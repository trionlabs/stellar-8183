extern crate std;

use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{
        storage::Persistent as _, Address as _, AuthorizedFunction, IssuerFlags, Ledger, MockAuth,
        MockAuthInvoke,
    },
    token, IntoVal,
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

    fn funded(&self, expiry: u64, amount: i128) -> u64 {
        let id = self.create(Some(self.provider.clone()), expiry);
        self.api()
            .set_budget(&id, &self.client, &amount, &Bytes::new(&self.env));
        self.api().fund(&id, &amount, &Bytes::new(&self.env));
        id
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

#[test]
fn completion_releases_exactly_one_job_budget() {
    let f = Fixture::new();
    let id = f.funded(START + 1_000, 250);
    let work = hash(&f.env, 7);
    let reason = Some(hash(&f.env, 8));
    f.api().submit(&id, &work, &Bytes::new(&f.env));
    f.api().complete(&id, &reason, &Bytes::new(&f.env));

    let job = f.api().get_job(&id);
    assert_eq!(job.state, JobState::Completed);
    assert_eq!(job.work_hash, Some(work));
    assert_eq!(job.decision, reason);
    assert_eq!(f.token().balance(&f.client), FUNDS - 250);
    assert_eq!(f.token().balance(&f.provider), 250);
    assert_eq!(f.token().balance(&f.kernel), 0);
    assert_eq!(
        f.token().balance(&f.client)
            + f.token().balance(&f.provider)
            + f.token().balance(&f.kernel),
        FUNDS
    );
    assert_eq!(
        f.api().try_complete(&id, &None, &Bytes::new(&f.env)),
        Err(Ok(Error::BadState))
    );
    assert_eq!(f.api().try_claim_refund(&id), Err(Ok(Error::BadState)));
}

#[test]
fn rejection_refunds_only_jobs_that_hold_escrow() {
    let f = Fixture::new();
    let open = f.create(Some(f.provider.clone()), START + 1_000);
    f.api()
        .set_budget(&open, &f.client, &100, &Bytes::new(&f.env));
    f.api()
        .reject(&open, &Some(hash(&f.env, 1)), &Bytes::new(&f.env));
    assert_eq!(f.api().get_job(&open).state, JobState::Rejected);
    assert_eq!(f.token().balance(&f.client), FUNDS);
    assert_eq!(f.token().balance(&f.kernel), 0);

    let funded = f.funded(START + 1_000, 200);
    f.api()
        .reject(&funded, &Some(hash(&f.env, 2)), &Bytes::new(&f.env));
    assert_eq!(f.api().get_job(&funded).state, JobState::Rejected);
    assert_eq!(f.token().balance(&f.client), FUNDS);
    assert_eq!(f.token().balance(&f.kernel), 0);

    let submitted = f.funded(START + 1_000, 300);
    f.api()
        .submit(&submitted, &hash(&f.env, 3), &Bytes::new(&f.env));
    f.api()
        .reject(&submitted, &Some(hash(&f.env, 4)), &Bytes::new(&f.env));
    assert_eq!(f.api().get_job(&submitted).state, JobState::Rejected);
    assert_eq!(f.token().balance(&f.client), FUNDS);
    assert_eq!(f.token().balance(&f.kernel), 0);
}

#[test]
fn permissionless_refund_is_available_at_expiry_exactly_once() {
    let f = Fixture::new();
    let expiry = START + 10;
    let id = f.funded(expiry, 125);
    assert_eq!(f.api().try_claim_refund(&id), Err(Ok(Error::BadExpiry)));

    f.env.ledger().set_timestamp(expiry);
    f.api().claim_refund(&id);
    assert!(f.env.auths().is_empty());
    assert_eq!(f.api().get_job(&id).state, JobState::Expired);
    assert_eq!(f.token().balance(&f.client), FUNDS);
    assert_eq!(f.token().balance(&f.kernel), 0);
    assert_eq!(f.api().try_claim_refund(&id), Err(Ok(Error::BadState)));
}

#[test]
fn expiry_race_allows_only_the_first_valid_terminal_transition() {
    let f = Fixture::new();
    let completes = f.funded(START + 10, 100);
    f.env.ledger().set_timestamp(START + 10);
    f.api()
        .submit(&completes, &hash(&f.env, 3), &Bytes::new(&f.env));
    f.api().complete(&completes, &None, &Bytes::new(&f.env));
    assert_eq!(
        f.api().try_claim_refund(&completes),
        Err(Ok(Error::BadState))
    );

    f.env.ledger().set_timestamp(START + 11);
    let refunds = f.funded(START + 20, 120);
    f.env.ledger().set_timestamp(START + 20);
    f.api().claim_refund(&refunds);
    assert_eq!(
        f.api()
            .try_submit(&refunds, &hash(&f.env, 4), &Bytes::new(&f.env)),
        Err(Ok(Error::BadState))
    );
    assert_eq!(f.token().balance(&f.kernel), 0);
    assert_eq!(f.token().balance(&f.client), FUNDS - 100);
    assert_eq!(f.token().balance(&f.provider), 100);
}

#[test]
fn token_failures_roll_back_state_and_balances() {
    let f = Fixture::new();
    let unfundable = f.create(Some(f.provider.clone()), START + 1_000);
    f.api()
        .set_budget(&unfundable, &f.client, &(FUNDS + 1), &Bytes::new(&f.env));
    assert!(f
        .api()
        .try_fund(&unfundable, &(FUNDS + 1), &Bytes::new(&f.env))
        .is_err());
    assert_eq!(f.api().get_job(&unfundable).state, JobState::Open);
    assert_eq!(f.token().balance(&f.kernel), 0);

    let payable = f.funded(START + 1_000, 70);
    f.api()
        .submit(&payable, &hash(&f.env, 5), &Bytes::new(&f.env));
    token::StellarAssetClient::new(&f.env, &f.token).set_authorized(&f.provider, &false);
    assert!(f
        .api()
        .try_complete(&payable, &None, &Bytes::new(&f.env))
        .is_err());
    assert_eq!(f.api().get_job(&payable).state, JobState::Submitted);
    assert_eq!(f.token().balance(&f.kernel), 70);
    assert_eq!(f.token().balance(&f.provider), 0);
}

#[test]
fn archived_funded_job_auto_restores_then_refunds() {
    let f = Fixture::new();
    let expiry = START + 10_000;
    let id = f.funded(expiry, 90);
    let max_ttl = f.env.ledger().get().max_entry_ttl;
    f.env.as_contract(&f.kernel, || {
        assert_eq!(
            f.env.storage().persistent().get_ttl(&DataKey::Job(id)),
            max_ttl - 1
        );
    });

    f.env
        .ledger()
        .set_sequence_number(max_ttl.saturating_add(1));
    f.env.ledger().set_timestamp(expiry);
    f.api().claim_refund(&id);
    assert_eq!(f.api().get_job(&id).state, JobState::Expired);
    assert_eq!(f.token().balance(&f.client), FUNDS);
    assert_eq!(f.token().balance(&f.kernel), 0);
}

#[test]
fn terminal_jobs_are_not_extended_automatically_but_can_be_kept_alive() {
    let f = Fixture::new();
    let id = f.funded(START + 10_000, 40);
    f.api().submit(&id, &hash(&f.env, 10), &Bytes::new(&f.env));
    let max_ttl = f.env.ledger().get().max_entry_ttl;
    let job_ttl = || {
        f.env.as_contract(&f.kernel, || {
            f.env.storage().persistent().get_ttl(&DataKey::Job(id))
        })
    };

    f.env.ledger().set_sequence_number(max_ttl / 2 + 100);
    let before = job_ttl();
    assert!(before < max_ttl / 2);
    f.api().complete(&id, &None, &Bytes::new(&f.env));
    assert_eq!(job_ttl(), before);

    f.api().keep_alive(&id);
    assert_eq!(job_ttl(), max_ttl - 1);
    assert_eq!(f.api().try_keep_alive(&999), Err(Ok(Error::NotFound)));
}

#[test]
fn two_step_admin_requires_the_pending_admin_signature() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let pending = Address::generate(&env);
    let token = Address::generate(&env);
    let kernel = env.register(Commerce, (admin.clone(), token));
    let api = CommerceClient::new(&env, &kernel);
    assert_eq!(api.try_accept_admin(), Err(Ok(Error::NoPending)));

    api.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &kernel,
            fn_name: "propose_admin",
            args: (&pending,).into_val(&env),
            sub_invokes: &[],
        },
    }])
    .propose_admin(&pending);
    assert!(api.try_accept_admin().is_err());

    api.mock_auths(&[MockAuth {
        address: &pending,
        invoke: &MockAuthInvoke {
            contract: &kernel,
            fn_name: "accept_admin",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }])
    .accept_admin();
    assert_eq!(api.get_admin(), pending);
}

#[test]
fn role_authorization_is_not_optional() {
    let env = Env::default();
    env.ledger().set_timestamp(START);
    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let client = Address::generate(&env);
    let evaluator = Address::generate(&env);
    let kernel = env.register(Commerce, (admin, token));
    let api = CommerceClient::new(&env, &kernel);
    assert!(api
        .try_create_job(
            &client,
            &None,
            &evaluator,
            &(START + 1),
            &String::from_str(&env, "requires a signature"),
            &None,
        )
        .is_err());
    assert_eq!(api.job_count(), 0);
}

#[test]
fn checked_job_id_overflow_cannot_overwrite_storage() {
    let f = Fixture::new();
    f.env.as_contract(&f.kernel, || {
        f.env.storage().instance().set(&DataKey::NextId, &u64::MAX);
    });
    assert_eq!(
        f.api().try_create_job(
            &f.client,
            &Some(f.provider.clone()),
            &f.evaluator,
            &(START + 1),
            &String::from_str(&f.env, "cannot wrap"),
            &None,
        ),
        Err(Ok(Error::IdOverflow))
    );
    f.env.as_contract(&f.kernel, || {
        assert!(!f.env.storage().persistent().has(&DataKey::Job(u64::MAX)));
    });
}
