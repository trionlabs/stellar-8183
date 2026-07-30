extern crate std;

use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{storage::Persistent as _, Address as _, AuthorizedFunction, IssuerFlags, Ledger},
    token,
};

const START: u64 = 100;
const FUNDS: i128 = 1_000_000;

struct Fixture {
    env: Env,
    admin: Address,
    client: Address,
    provider: Address,
    evaluator: Address,
    token: Address,
    kernel: Address,
}

impl Fixture {
    fn new() -> Self {
        let env = Env::default();
        env.ledger().set_timestamp(START);
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let client = Address::generate(&env);
        let provider = Address::generate(&env);
        let evaluator = Address::generate(&env);
        let asset = env.register_stellar_asset_contract_v2(admin.clone());
        asset.issuer().set_flag(IssuerFlags::RevocableFlag);
        let token = asset.address();
        let kernel = env.register(Commerce, (admin.clone(), token.clone()));
        token::StellarAssetClient::new(&env, &token).mint(&client, &FUNDS);
        Self {
            env,
            admin,
            client,
            provider,
            evaluator,
            token,
            kernel,
        }
    }

    fn api(&self) -> CommerceClient<'_> {
        CommerceClient::new(&self.env, &self.kernel)
    }

    fn token(&self) -> token::Client<'_> {
        token::Client::new(&self.env, &self.token)
    }

    fn create(&self, provider: Option<Address>, expiry: u64) -> u64 {
        self.api().create_job(
            &self.client,
            &provider,
            &self.evaluator,
            &expiry,
            &String::from_str(&self.env, "compile a proof"),
            &None,
        )
    }
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

#[test]
fn open_to_funded_to_submitted_escrows_sep41_tokens() {
    let f = Fixture::new();
    let id = f.create(None, START + 1_000);
    assert_eq!(id, 1);
    assert_eq!(f.api().job_count(), 1);
    assert_eq!(f.api().get_admin(), f.admin);
    assert_eq!(f.api().get_token(), f.token);

    f.api().set_provider(&id, &f.provider, &Bytes::new(&f.env));
    f.api()
        .set_budget(&id, &f.provider, &250, &Bytes::new(&f.env));
    f.api().fund(&id, &250, &Bytes::new(&f.env));

    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.client);
    match &auths[0].1.function {
        AuthorizedFunction::Contract((contract, function, _args)) => {
            assert_eq!(contract, &f.kernel);
            assert_eq!(function, &symbol_short!("fund"));
        }
        _ => panic!("fund must be the root authorized contract invocation"),
    }
    assert_eq!(auths[0].1.sub_invocations.len(), 1);
    match &auths[0].1.sub_invocations[0].function {
        AuthorizedFunction::Contract((contract, function, _args)) => {
            assert_eq!(contract, &f.token);
            assert_eq!(function, &symbol_short!("transfer"));
        }
        _ => panic!("SEP-41 transfer must be nested in client fund authorization"),
    }
    assert_eq!(f.token().balance(&f.client), FUNDS - 250);
    assert_eq!(f.token().balance(&f.kernel), 250);

    let work_hash = hash(&f.env, 7);
    f.api().submit(&id, &work_hash, &Bytes::new(&f.env));
    let job = f.api().get_job(&id);
    assert_eq!(job.state, JobState::Submitted);
    assert_eq!(job.provider, Some(f.provider));
    assert_eq!(job.budget, 250);
    assert_eq!(job.work_hash, Some(work_hash));
    assert_eq!(job.decision, None);
}

#[test]
fn funding_guards_preserve_open_jobs_and_token_balances() {
    let f = Fixture::new();
    let id = f.create(Some(f.provider.clone()), START + 10);
    f.api()
        .set_budget(&id, &f.client, &100, &Bytes::new(&f.env));

    assert_eq!(
        f.api().try_fund(&id, &99, &Bytes::new(&f.env)),
        Err(Ok(Error::BudgetDiff))
    );
    assert_eq!(f.api().get_job(&id).state, JobState::Open);
    assert_eq!(f.token().balance(&f.client), FUNDS);
    assert_eq!(f.token().balance(&f.kernel), 0);

    f.env.ledger().set_timestamp(START + 10);
    assert_eq!(
        f.api().try_fund(&id, &100, &Bytes::new(&f.env)),
        Err(Ok(Error::BadExpiry))
    );
    assert_eq!(f.api().get_job(&id).state, JobState::Open);
    assert_eq!(f.token().balance(&f.client), FUNDS);
    assert_eq!(f.token().balance(&f.kernel), 0);
}

#[test]
fn validation_rejects_unavailable_hooks_and_forbidden_transitions() {
    let f = Fixture::new();
    assert_eq!(
        f.api().try_create_job(
            &f.client,
            &Some(f.provider.clone()),
            &f.evaluator,
            &(START + 1_000),
            &String::from_str(&f.env, "hook not available in week 1"),
            &Some(Address::generate(&f.env)),
        ),
        Err(Ok(Error::HookDenied))
    );

    let id = f.create(None, START + 1_000);
    assert_eq!(
        f.api()
            .try_set_budget(&id, &f.evaluator, &10, &Bytes::new(&f.env)),
        Err(Ok(Error::BadActor))
    );
    f.api().set_budget(&id, &f.client, &10, &Bytes::new(&f.env));
    assert_eq!(
        f.api().try_fund(&id, &10, &Bytes::new(&f.env)),
        Err(Ok(Error::NoProvider))
    );
    f.api().set_provider(&id, &f.provider, &Bytes::new(&f.env));
    f.api().fund(&id, &10, &Bytes::new(&f.env));
    assert_eq!(
        f.api().try_fund(&id, &10, &Bytes::new(&f.env)),
        Err(Ok(Error::BadState))
    );
    f.api().submit(&id, &hash(&f.env, 1), &Bytes::new(&f.env));
    assert_eq!(
        f.api()
            .try_submit(&id, &hash(&f.env, 2), &Bytes::new(&f.env)),
        Err(Ok(Error::BadState))
    );
}

#[test]
fn persistent_job_ttl_is_extended_only_below_half_life() {
    let f = Fixture::new();
    let id = f.create(Some(f.provider.clone()), START + 10_000);
    let max_ttl = f.env.ledger().get().max_entry_ttl;
    let job_ttl = || {
        f.env.as_contract(&f.kernel, || {
            f.env.storage().persistent().get_ttl(&DataKey::Job(id))
        })
    };

    f.env.ledger().set_sequence_number(100);
    let healthy_ttl = job_ttl();
    assert!(healthy_ttl > max_ttl / 2);
    f.api().set_budget(&id, &f.client, &10, &Bytes::new(&f.env));
    assert_eq!(job_ttl(), healthy_ttl);

    f.env.ledger().set_sequence_number(max_ttl / 2 + 100);
    assert!(job_ttl() < max_ttl / 2);
    f.api()
        .set_budget(&id, &f.provider, &20, &Bytes::new(&f.env));
    assert_eq!(job_ttl(), max_ttl - 1);
}
