extern crate std;

use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{
        storage::Persistent as _, Address as _, AuthorizedFunction, Events as _, IssuerFlags,
        Ledger, MockAuth, MockAuthInvoke,
    },
    token, Event, IntoVal, Symbol,
};
use stellar_8183_sla_hook::{SlaHook, SlaHookClient};
use stellar_8183_test_hooks::{Mode, TestHooks, TestHooksClient};

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

    fn create(&self, provider: Option<Address>, hook: Option<Address>, expiry: u64) -> u64 {
        self.api().create_job(
            &self.client,
            &provider,
            &self.evaluator,
            &expiry,
            &String::from_str(&self.env, "compile a proof"),
            &hook,
        )
    }

    fn funded(&self, hook: Option<Address>, expiry: u64, amount: i128) -> u64 {
        let id = self.create(Some(self.provider.clone()), hook, expiry);
        self.api()
            .set_budget(&id, &self.client, &amount, &Bytes::new(&self.env));
        self.api().fund(&id, &amount, &Bytes::new(&self.env));
        id
    }

    fn hook(&self, mode: Mode) -> Address {
        let hook = self.env.register(TestHooks, (self.kernel.clone(), mode));
        self.api().set_hook(&hook, &true);
        hook
    }
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn assert_root_auth(f: &Fixture, actor: &Address, function: &str) {
    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(&auths[0].0, actor);
    match &auths[0].1.function {
        AuthorizedFunction::Contract((contract, actual, _args)) => {
            assert_eq!(contract, &f.kernel);
            assert_eq!(actual, &Symbol::new(&f.env, function));
        }
        _ => panic!("role authorization must root at a kernel invocation"),
    }
    assert!(auths[0].1.sub_invocations.is_empty());
}

#[test]
fn every_role_authorization_roots_at_the_kernel_action() {
    let f = Fixture::new();
    let admitted = Address::generate(&f.env);
    f.api().set_hook(&admitted, &true);
    assert_root_auth(&f, &f.admin, "set_hook");

    let id = f.create(None, None, START + 1_000);
    assert_root_auth(&f, &f.client, "create_job");
    f.api().set_provider(&id, &f.provider, &Bytes::new(&f.env));
    assert_root_auth(&f, &f.client, "set_provider");
    f.api().set_budget(&id, &f.client, &10, &Bytes::new(&f.env));
    assert_root_auth(&f, &f.client, "set_budget");
    f.api()
        .set_budget(&id, &f.provider, &20, &Bytes::new(&f.env));
    assert_root_auth(&f, &f.provider, "set_budget");
    f.api().fund(&id, &20, &Bytes::new(&f.env));
    f.api().submit(&id, &hash(&f.env, 1), &Bytes::new(&f.env));
    assert_root_auth(&f, &f.provider, "submit");
    f.api().complete(&id, &None, &Bytes::new(&f.env));
    assert_root_auth(&f, &f.evaluator, "complete");

    let open = f.create(Some(f.provider.clone()), None, START + 1_000);
    f.api().reject(&open, &None, &Bytes::new(&f.env));
    assert_root_auth(&f, &f.client, "reject");

    let funded = f.funded(None, START + 1_000, 30);
    f.api().reject(&funded, &None, &Bytes::new(&f.env));
    assert_root_auth(&f, &f.evaluator, "reject");
}

#[test]
fn kernel_invoker_authenticates_hook_without_blanket_mocking() {
    let env = Env::default();
    env.ledger().set_timestamp(START);
    let admin = Address::generate(&env);
    let client = Address::generate(&env);
    let provider = Some(Address::generate(&env));
    let evaluator = Address::generate(&env);
    let token = Address::generate(&env);
    let kernel = env.register(Commerce, (admin.clone(), token));
    let hook = env.register(TestHooks, (kernel.clone(), Mode::Pass));
    let api = CommerceClient::new(&env, &kernel);

    api.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &kernel,
            fn_name: "set_hook",
            args: (hook.clone(), true).into_val(&env),
            sub_invokes: &[],
        },
    }])
    .set_hook(&hook, &true);

    let expiry = START + 1_000;
    let desc = String::from_str(&env, "direct invoker auth");
    let selected_hook = Some(hook.clone());
    let id = api
        .mock_auths(&[MockAuth {
            address: &client,
            invoke: &MockAuthInvoke {
                contract: &kernel,
                fn_name: "create_job",
                args: (
                    client.clone(),
                    provider.clone(),
                    evaluator.clone(),
                    expiry,
                    desc.clone(),
                    selected_hook.clone(),
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .create_job(
            &client,
            &provider,
            &evaluator,
            &expiry,
            &desc,
            &selected_hook,
        );

    let opt = Bytes::new(&env);
    api.mock_auths(&[MockAuth {
        address: &client,
        invoke: &MockAuthInvoke {
            contract: &kernel,
            fn_name: "set_budget",
            args: (id, client.clone(), 25_i128, opt.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }])
    .set_budget(&id, &client, &25, &opt);
    assert_eq!(
        TestHooksClient::new(&env, &hook).stats(),
        stellar_8183_test_hooks::Stats {
            before: 1,
            after: 1,
        }
    );
}

#[test]
fn completed_lifecycle_conserves_tokens_and_records_auth() {
    let f = Fixture::new();
    let id = f.create(None, None, START + 1_000);
    assert_eq!(id, 1);
    assert_eq!(f.api().job_count(), 1);
    assert_eq!(f.api().get_admin(), f.admin);

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

    let work = hash(&f.env, 7);
    let reason = Some(hash(&f.env, 8));
    f.api().submit(&id, &work, &Bytes::new(&f.env));
    assert_eq!(
        f.api().try_submit(&id, &work, &Bytes::new(&f.env)),
        Err(Ok(Error::BadState))
    );
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
    assert_eq!(
        f.api().try_reject(&id, &None, &Bytes::new(&f.env)),
        Err(Ok(Error::BadState))
    );
    assert_eq!(f.api().try_claim_refund(&id), Err(Ok(Error::BadState)));
}

#[test]
fn lifecycle_events_have_stable_topics_and_ordering() {
    let f = Fixture::new();
    let expiry = START + 1_000;
    let id = f.create(Some(f.provider.clone()), None, expiry);
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.kernel),
        std::vec![JobCreated {
            id,
            client: f.client.clone(),
            provider: Some(f.provider.clone()),
            evaluator: f.evaluator.clone(),
            expires_at: expiry,
            hook: None,
        }
        .to_xdr(&f.env, &f.kernel)]
    );

    f.api()
        .set_budget(&id, &f.client, &100, &Bytes::new(&f.env));
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.kernel),
        std::vec![BudgetSet {
            id,
            actor: f.client.clone(),
            amount: 100,
        }
        .to_xdr(&f.env, &f.kernel)]
    );
    f.api().fund(&id, &100, &Bytes::new(&f.env));
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.kernel),
        std::vec![JobFunded {
            id,
            client: f.client.clone(),
            amount: 100,
        }
        .to_xdr(&f.env, &f.kernel)]
    );

    let work = hash(&f.env, 9);
    f.api().submit(&id, &work, &Bytes::new(&f.env));
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.kernel),
        std::vec![JobSubmit {
            id,
            provider: f.provider.clone(),
            work_hash: work,
        }
        .to_xdr(&f.env, &f.kernel)]
    );
    f.api().complete(&id, &None, &Bytes::new(&f.env));
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.kernel),
        std::vec![
            JobDone {
                id,
                evaluator: f.evaluator.clone(),
                reason: None,
            }
            .to_xdr(&f.env, &f.kernel),
            PayRelease {
                id,
                provider: f.provider.clone(),
                amount: 100,
            }
            .to_xdr(&f.env, &f.kernel),
        ]
    );

    let refund = f.funded(None, START + 10, 120);
    f.env.ledger().set_timestamp(START + 10);
    f.api().claim_refund(&refund);
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.kernel),
        std::vec![
            Refunded {
                id: refund,
                client: f.client.clone(),
                amount: 120,
            }
            .to_xdr(&f.env, &f.kernel),
            JobExpire { id: refund }.to_xdr(&f.env, &f.kernel),
        ]
    );
}

#[test]
fn rejection_paths_refund_only_escrowed_jobs() {
    let f = Fixture::new();
    let open = f.create(Some(f.provider.clone()), None, START + 1_000);
    f.api()
        .set_budget(&open, &f.client, &100, &Bytes::new(&f.env));
    f.api()
        .reject(&open, &Some(hash(&f.env, 1)), &Bytes::new(&f.env));
    assert_eq!(f.api().get_job(&open).state, JobState::Rejected);
    assert_eq!(f.token().balance(&f.client), FUNDS);
    assert_eq!(f.token().balance(&f.kernel), 0);

    let funded = f.funded(None, START + 1_000, 200);
    assert_eq!(f.token().balance(&f.client), FUNDS - 200);
    f.api()
        .reject(&funded, &Some(hash(&f.env, 2)), &Bytes::new(&f.env));
    assert_eq!(f.api().get_job(&funded).state, JobState::Rejected);
    assert_eq!(f.token().balance(&f.client), FUNDS);
    assert_eq!(f.token().balance(&f.kernel), 0);
    assert_eq!(
        f.api().try_reject(&funded, &None, &Bytes::new(&f.env)),
        Err(Ok(Error::BadState))
    );

    let submitted = f.funded(None, START + 1_000, 300);
    f.api()
        .submit(&submitted, &hash(&f.env, 3), &Bytes::new(&f.env));
    f.api()
        .reject(&submitted, &Some(hash(&f.env, 4)), &Bytes::new(&f.env));
    assert_eq!(f.api().get_job(&submitted).state, JobState::Rejected);
    assert_eq!(f.token().balance(&f.client), FUNDS);
    assert_eq!(f.token().balance(&f.kernel), 0);
}

#[test]
fn validation_and_forbidden_transitions_are_explicit() {
    let f = Fixture::new();
    let api = f.api();
    let no_provider = None;
    let no_hook = None;
    assert_eq!(api.try_get_job(&999), Err(Ok(Error::NotFound)));
    assert_eq!(
        api.try_create_job(
            &f.client,
            &no_provider,
            &f.evaluator,
            &(START + 10),
            &String::from_str(&f.env, ""),
            &no_hook,
        ),
        Err(Ok(Error::BadDesc))
    );
    assert_eq!(
        api.try_create_job(
            &f.client,
            &no_provider,
            &f.evaluator,
            &START,
            &String::from_str(&f.env, "valid"),
            &no_hook,
        ),
        Err(Ok(Error::BadExpiry))
    );
    let invalid = String::from_bytes(&f.env, b"\xf0\x28\x8c\xbc");
    assert_eq!(
        api.try_create_job(
            &f.client,
            &no_provider,
            &f.evaluator,
            &(START + 10),
            &invalid,
            &no_hook,
        ),
        Err(Ok(Error::BadDesc))
    );
    let long = String::from_bytes(&f.env, &[b'a'; 513]);
    assert_eq!(
        api.try_create_job(
            &f.client,
            &no_provider,
            &f.evaluator,
            &(START + 10),
            &long,
            &no_hook,
        ),
        Err(Ok(Error::BadDesc))
    );

    let id = f.create(None, None, START + 100);
    assert_eq!(
        api.try_set_budget(&id, &f.client, &0, &Bytes::new(&f.env)),
        Err(Ok(Error::BadBudget))
    );
    assert_eq!(
        api.try_set_budget(&id, &f.client, &-1, &Bytes::new(&f.env)),
        Err(Ok(Error::BadBudget))
    );
    assert_eq!(
        api.try_set_budget(&id, &f.evaluator, &10, &Bytes::new(&f.env)),
        Err(Ok(Error::BadActor))
    );
    api.set_budget(&id, &f.client, &10, &Bytes::new(&f.env));
    assert_eq!(
        api.try_fund(&id, &10, &Bytes::new(&f.env)),
        Err(Ok(Error::NoProvider))
    );
    api.set_provider(&id, &f.provider, &Bytes::new(&f.env));
    assert_eq!(
        api.try_set_provider(&id, &f.evaluator, &Bytes::new(&f.env)),
        Err(Ok(Error::ProvExists))
    );
    assert_eq!(
        api.try_fund(&id, &11, &Bytes::new(&f.env)),
        Err(Ok(Error::BudgetDiff))
    );

    let oversized = Bytes::from_slice(&f.env, &[0_u8; 1_025]);
    assert_eq!(
        api.try_fund(&id, &10, &oversized),
        Err(Ok(Error::OptTooLong))
    );
    api.fund(&id, &10, &Bytes::new(&f.env));
    assert_eq!(
        api.try_fund(&id, &10, &Bytes::new(&f.env)),
        Err(Ok(Error::BadState))
    );
    assert_eq!(
        api.try_complete(&id, &None, &Bytes::new(&f.env)),
        Err(Ok(Error::BadState))
    );

    let expired_open = f.create(Some(f.provider.clone()), None, START + 1);
    api.set_budget(&expired_open, &f.client, &10, &Bytes::new(&f.env));
    f.env.ledger().set_timestamp(START + 1);
    assert_eq!(
        api.try_fund(&expired_open, &10, &Bytes::new(&f.env)),
        Err(Ok(Error::BadExpiry))
    );
    assert_eq!(api.get_job(&expired_open).state, JobState::Open);
}

#[test]
fn expiry_race_allows_either_valid_winner() {
    let f = Fixture::new();
    let completes = f.funded(None, START + 10, 100);
    assert_eq!(
        f.api().try_claim_refund(&completes),
        Err(Ok(Error::BadExpiry))
    );
    f.env.ledger().set_timestamp(START + 10);
    f.api()
        .submit(&completes, &hash(&f.env, 3), &Bytes::new(&f.env));
    f.api().complete(&completes, &None, &Bytes::new(&f.env));
    assert_eq!(f.api().get_job(&completes).state, JobState::Completed);

    f.env.ledger().set_timestamp(START + 11);
    let refunds = f.funded(None, START + 20, 120);
    f.env.ledger().set_timestamp(START + 20);
    f.api().claim_refund(&refunds);
    assert_eq!(f.api().get_job(&refunds).state, JobState::Expired);
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
fn refund_cannot_be_blocked_by_hook() {
    let f = Fixture::new();
    let hook = f.hook(Mode::SettleFail);
    let id = f.funded(Some(hook), START + 10, 300);
    f.api().submit(&id, &hash(&f.env, 5), &Bytes::new(&f.env));
    assert!(f
        .api()
        .try_complete(&id, &None, &Bytes::new(&f.env))
        .is_err());
    assert_eq!(f.api().get_job(&id).state, JobState::Submitted);
    assert_eq!(f.token().balance(&f.kernel), 300);

    f.env.ledger().set_timestamp(START + 10);
    f.api().claim_refund(&id);
    assert_eq!(f.api().get_job(&id).state, JobState::Expired);
    assert_eq!(f.token().balance(&f.kernel), 0);
    assert_eq!(f.token().balance(&f.client), FUNDS);
}

#[test]
fn after_hook_failure_rolls_back_state_and_token_transfer() {
    let f = Fixture::new();
    let hook = f.hook(Mode::FundAfter);
    let id = f.create(Some(f.provider.clone()), Some(hook), START + 1_000);
    f.api()
        .set_budget(&id, &f.client, &400, &Bytes::new(&f.env));

    assert!(f.api().try_fund(&id, &400, &Bytes::new(&f.env)).is_err());
    assert!(f.env.events().all().events().is_empty());
    let job = f.api().get_job(&id);
    assert_eq!(job.state, JobState::Open);
    assert_eq!(job.budget, 400);
    assert_eq!(f.token().balance(&f.client), FUNDS);
    assert_eq!(f.token().balance(&f.kernel), 0);
    let stats = TestHooksClient::new(&f.env, &job.hook.unwrap()).stats();
    // set_budget committed one callback pair; the failed fund's before-hook
    // increment and all later effects were rolled back atomically.
    assert_eq!(stats.before, 1);
    assert_eq!(stats.after, 1);
}

#[test]
fn insufficient_token_balance_rolls_back_funding() {
    let f = Fixture::new();
    let amount = FUNDS + 1;
    let id = f.create(Some(f.provider.clone()), None, START + 1_000);
    f.api()
        .set_budget(&id, &f.client, &amount, &Bytes::new(&f.env));
    assert!(f.api().try_fund(&id, &amount, &Bytes::new(&f.env)).is_err());
    assert_eq!(f.api().get_job(&id).state, JobState::Open);
    assert_eq!(f.token().balance(&f.client), FUNDS);
    assert_eq!(f.token().balance(&f.kernel), 0);
}

#[test]
fn frozen_provider_rolls_back_completion() {
    let f = Fixture::new();
    let id = f.funded(None, START + 1_000, 70);
    f.api().submit(&id, &hash(&f.env, 5), &Bytes::new(&f.env));
    token::StellarAssetClient::new(&f.env, &f.token).set_authorized(&f.provider, &false);

    assert!(f
        .api()
        .try_complete(&id, &None, &Bytes::new(&f.env))
        .is_err());
    assert_eq!(f.api().get_job(&id).state, JobState::Submitted);
    assert_eq!(f.token().balance(&f.kernel), 70);
    assert_eq!(f.token().balance(&f.provider), 0);

    token::StellarAssetClient::new(&f.env, &f.token).set_authorized(&f.provider, &true);
    f.api().complete(&id, &None, &Bytes::new(&f.env));
    assert_eq!(f.api().get_job(&id).state, JobState::Completed);
    assert_eq!(f.token().balance(&f.kernel), 0);
    assert_eq!(f.token().balance(&f.provider), 70);
}

#[test]
fn frozen_client_refund_rolls_back_until_reauthorized() {
    let f = Fixture::new();
    let expiry = START + 10;
    let id = f.funded(None, expiry, 65);
    token::StellarAssetClient::new(&f.env, &f.token).set_authorized(&f.client, &false);
    f.env.ledger().set_timestamp(expiry);

    assert!(f.api().try_claim_refund(&id).is_err());
    assert_eq!(f.api().get_job(&id).state, JobState::Funded);
    assert_eq!(f.token().balance(&f.kernel), 65);
    assert_eq!(f.token().balance(&f.client), FUNDS - 65);

    token::StellarAssetClient::new(&f.env, &f.token).set_authorized(&f.client, &true);
    f.api().claim_refund(&id);
    assert_eq!(f.api().get_job(&id).state, JobState::Expired);
    assert_eq!(f.token().balance(&f.kernel), 0);
    assert_eq!(f.token().balance(&f.client), FUNDS);
}

#[test]
fn unsolicited_token_surplus_is_not_assigned_to_a_job() {
    let f = Fixture::new();
    token::StellarAssetClient::new(&f.env, &f.token).mint(&f.kernel, &13);
    let id = f.funded(None, START + 1_000, 40);
    assert_eq!(f.token().balance(&f.kernel), 53);

    f.api().submit(&id, &hash(&f.env, 5), &Bytes::new(&f.env));
    f.api().complete(&id, &None, &Bytes::new(&f.env));

    assert_eq!(f.api().get_job(&id).state, JobState::Completed);
    assert_eq!(f.token().balance(&f.provider), 40);
    assert_eq!(f.token().balance(&f.kernel), 13);
}

#[test]
fn hook_delisting_only_blocks_new_jobs() {
    let f = Fixture::new();
    let hook = f.hook(Mode::Pass);
    let id = f.create(Some(f.provider.clone()), Some(hook.clone()), START + 1_000);
    f.api().set_hook(&hook, &false);
    assert!(!f.api().is_hook(&hook));
    assert_eq!(
        f.api().try_create_job(
            &f.client,
            &Some(f.provider.clone()),
            &f.evaluator,
            &(START + 1_000),
            &String::from_str(&f.env, "new"),
            &Some(hook.clone()),
        ),
        Err(Ok(Error::HookDenied))
    );

    f.api().set_budget(&id, &f.client, &50, &Bytes::new(&f.env));
    f.api().fund(&id, &50, &Bytes::new(&f.env));
    f.api().submit(&id, &hash(&f.env, 6), &Bytes::new(&f.env));
    f.api().complete(&id, &None, &Bytes::new(&f.env));
    let stats = TestHooksClient::new(&f.env, &hook).stats();
    assert_eq!(stats.before, 4);
    assert_eq!(stats.after, 4);
}

#[test]
fn sla_enforces_a_full_review_window() {
    let f = Fixture::new();
    let review = 50_u64;
    let hook = f.env.register(SlaHook, (f.kernel.clone(), review));
    f.api().set_hook(&hook, &true);
    let id = f.funded(Some(hook), START + 100, 80);

    f.env.ledger().set_timestamp(START + 51);
    assert_eq!(
        f.api()
            .try_submit(&id, &hash(&f.env, 7), &Bytes::new(&f.env)),
        Err(Err(soroban_sdk::InvokeError::Contract(100)))
    );
    assert_eq!(f.api().get_job(&id).state, JobState::Funded);

    f.env.ledger().set_timestamp(START + 50);
    f.api().submit(&id, &hash(&f.env, 7), &Bytes::new(&f.env));
    assert_eq!(f.api().get_job(&id).state, JobState::Submitted);
    assert_eq!(
        SlaHookClient::new(&f.env, &f.api().get_job(&id).hook.unwrap()).review_secs(),
        50
    );
}

#[test]
fn funded_job_auto_restores_then_refunds() {
    let f = Fixture::new();
    let expiry = START + 10_000;
    let id = f.funded(None, expiry, 90);
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
fn ttl_bumps_only_below_the_half_life_threshold() {
    let f = Fixture::new();
    let id = f.create(Some(f.provider.clone()), None, START + 10_000);
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
fn terminal_transition_does_not_aggressively_extend_job_ttl() {
    let f = Fixture::new();
    let id = f.funded(None, START + 10_000, 40);
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

    assert_eq!(f.api().get_job(&id).state, JobState::Completed);
    assert_eq!(job_ttl(), before);
}

#[test]
fn keep_alive_force_extends_active_and_terminal_jobs() {
    let f = Fixture::new();
    let active = f.create(Some(f.provider.clone()), None, START + 10_000);
    let terminal = f.create(Some(f.provider.clone()), None, START + 10_000);
    f.api().reject(&terminal, &None, &Bytes::new(&f.env));
    let max_ttl = f.env.ledger().get().max_entry_ttl;
    f.env.ledger().set_sequence_number(max_ttl / 2 + 100);

    let job_ttl = |id| {
        f.env.as_contract(&f.kernel, || {
            f.env.storage().persistent().get_ttl(&DataKey::Job(id))
        })
    };
    assert!(job_ttl(active) < max_ttl / 2);
    assert!(job_ttl(terminal) < max_ttl / 2);

    f.api().keep_alive(&active);
    f.api().keep_alive(&terminal);
    assert_eq!(job_ttl(active), max_ttl - 1);
    assert_eq!(job_ttl(terminal), max_ttl - 1);
    assert_eq!(f.api().try_keep_alive(&999), Err(Ok(Error::NotFound)));
}

#[test]
fn resource_heavy_hook_executes_with_default_host_limits() {
    let f = Fixture::new();
    let hook = f.hook(Mode::Workload);
    let id = f.create(Some(f.provider.clone()), Some(hook.clone()), START + 1_000);

    f.api().set_budget(&id, &f.client, &25, &Bytes::new(&f.env));

    assert_eq!(f.api().get_job(&id).budget, 25);
    assert_eq!(
        TestHooksClient::new(&f.env, &hook).stats(),
        stellar_8183_test_hooks::Stats {
            before: 1,
            after: 1,
        }
    );
}

#[test]
fn direct_hook_spoof_and_reentry_are_rejected() {
    let env = Env::default();
    let core = Address::generate(&env);
    let actor = Address::generate(&env);
    let spoof_hook = env.register(TestHooks, (core.clone(), Mode::Pass));
    let ctx = HookCtx {
        job_id: 1,
        action: Action::Fund,
        actor: actor.clone(),
        client: actor.clone(),
        provider: None,
        evaluator: actor,
        budget: 1,
        expiry: 100,
        state: JobState::Open,
        arg: HookArg::None,
        opt: Bytes::new(&env),
    };
    assert!(TestHooksClient::new(&env, &spoof_hook)
        .try_before_action(&ctx)
        .is_err());

    let f = Fixture::new();
    let hook = f.hook(Mode::Reenter);
    let id = f.create(Some(f.provider.clone()), Some(hook), START + 1_000);
    assert!(f
        .api()
        .try_set_budget(&id, &f.client, &10, &Bytes::new(&f.env))
        .is_err());
    assert_eq!(f.api().get_job(&id).budget, 0);
}

#[test]
fn two_step_admin_requires_pending_admin_auth() {
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
fn multiple_job_liabilities_equal_kernel_balance() {
    let f = Fixture::new();
    let first = f.funded(None, START + 1_000, 100);
    let second = f.funded(None, START + 1_000, 200);
    assert_eq!(f.token().balance(&f.kernel), 300);

    f.api()
        .submit(&first, &hash(&f.env, 8), &Bytes::new(&f.env));
    f.api().complete(&first, &None, &Bytes::new(&f.env));
    assert_eq!(f.token().balance(&f.kernel), 200);

    f.api().reject(&second, &None, &Bytes::new(&f.env));
    assert_eq!(f.token().balance(&f.kernel), 0);
    assert_eq!(f.token().balance(&f.client), FUNDS - 100);
    assert_eq!(f.token().balance(&f.provider), 100);
}

#[test]
fn evaluator_may_be_the_client() {
    let f = Fixture::new();
    let id = f.api().create_job(
        &f.client,
        &Some(f.provider.clone()),
        &f.client,
        &(START + 1_000),
        &String::from_str(&f.env, "client evaluates"),
        &None,
    );
    f.api().set_budget(&id, &f.client, &55, &Bytes::new(&f.env));
    f.api().fund(&id, &55, &Bytes::new(&f.env));
    f.api().submit(&id, &hash(&f.env, 9), &Bytes::new(&f.env));
    f.api().complete(&id, &None, &Bytes::new(&f.env));

    assert_root_auth(&f, &f.client, "complete");
    assert_eq!(f.api().get_job(&id).state, JobState::Completed);
    assert_eq!(f.token().balance(&f.provider), 55);
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

#[derive(Clone, Copy, Debug)]
enum ModelOp {
    SetProv,
    SetBudget,
    Fund,
    Submit,
    Complete,
    Reject,
    Refund,
}

const MODEL_BUDGET: i128 = 77;

fn fixture_in_state(state: JobState, op: ModelOp) -> (Fixture, u64, u64) {
    let f = Fixture::new();
    let expiry = START + 1_000;
    let provider = if state == JobState::Open && matches!(op, ModelOp::SetProv) {
        None
    } else {
        Some(f.provider.clone())
    };
    let id = f.create(provider, None, expiry);
    f.api()
        .set_budget(&id, &f.client, &MODEL_BUDGET, &Bytes::new(&f.env));

    match state {
        JobState::Open => {}
        JobState::Funded => {
            f.api().fund(&id, &MODEL_BUDGET, &Bytes::new(&f.env));
        }
        JobState::Submitted => {
            f.api().fund(&id, &MODEL_BUDGET, &Bytes::new(&f.env));
            f.api().submit(&id, &hash(&f.env, 11), &Bytes::new(&f.env));
        }
        JobState::Completed => {
            f.api().fund(&id, &MODEL_BUDGET, &Bytes::new(&f.env));
            f.api().submit(&id, &hash(&f.env, 11), &Bytes::new(&f.env));
            f.api().complete(&id, &None, &Bytes::new(&f.env));
        }
        JobState::Rejected => {
            f.api().reject(&id, &None, &Bytes::new(&f.env));
        }
        JobState::Expired => {
            f.api().fund(&id, &MODEL_BUDGET, &Bytes::new(&f.env));
            f.env.ledger().set_timestamp(expiry);
            f.api().claim_refund(&id);
        }
    }

    assert_eq!(f.api().get_job(&id).state, state);
    (f, id, expiry)
}

fn invoke_model_op(f: &Fixture, id: u64, expiry: u64, op: ModelOp) -> bool {
    match op {
        ModelOp::SetProv => f
            .api()
            .try_set_provider(&id, &Address::generate(&f.env), &Bytes::new(&f.env))
            .is_ok(),
        ModelOp::SetBudget => f
            .api()
            .try_set_budget(&id, &f.client, &(MODEL_BUDGET + 1), &Bytes::new(&f.env))
            .is_ok(),
        ModelOp::Fund => f
            .api()
            .try_fund(&id, &MODEL_BUDGET, &Bytes::new(&f.env))
            .is_ok(),
        ModelOp::Submit => f
            .api()
            .try_submit(&id, &hash(&f.env, 12), &Bytes::new(&f.env))
            .is_ok(),
        ModelOp::Complete => f
            .api()
            .try_complete(&id, &None, &Bytes::new(&f.env))
            .is_ok(),
        ModelOp::Reject => f.api().try_reject(&id, &None, &Bytes::new(&f.env)).is_ok(),
        ModelOp::Refund => {
            f.env.ledger().set_timestamp(expiry);
            f.api().try_claim_refund(&id).is_ok()
        }
    }
}

#[test]
fn normative_state_transition_table_is_exhaustive() {
    use JobState::{Completed, Expired, Funded, Open, Rejected, Submitted};

    let states = [Open, Funded, Submitted, Completed, Rejected, Expired];
    let ops = [
        ModelOp::SetProv,
        ModelOp::SetBudget,
        ModelOp::Fund,
        ModelOp::Submit,
        ModelOp::Complete,
        ModelOp::Reject,
        ModelOp::Refund,
    ];
    let expected = [
        [
            Some(Open),
            Some(Open),
            Some(Funded),
            None,
            None,
            Some(Rejected),
            None,
        ],
        [
            None,
            None,
            None,
            Some(Submitted),
            None,
            Some(Rejected),
            Some(Expired),
        ],
        [
            None,
            None,
            None,
            None,
            Some(Completed),
            Some(Rejected),
            Some(Expired),
        ],
        [None, None, None, None, None, None, None],
        [None, None, None, None, None, None, None],
        [None, None, None, None, None, None, None],
    ];

    for (state_index, source) in states.iter().enumerate() {
        for (op_index, op) in ops.iter().enumerate() {
            let (f, id, expiry) = fixture_in_state(*source, *op);
            let expected_state = expected[state_index][op_index];
            let succeeded = invoke_model_op(&f, id, expiry, *op);
            assert_eq!(
                succeeded,
                expected_state.is_some(),
                "unexpected result for {source:?} + {op:?}"
            );

            let final_state = f.api().get_job(&id).state;
            assert_eq!(
                final_state,
                expected_state.unwrap_or(*source),
                "unexpected final state for {source:?} + {op:?}"
            );
            let expected_liability = if final_state.has_funds() {
                MODEL_BUDGET
            } else {
                0
            };
            assert_eq!(
                f.token().balance(&f.kernel),
                expected_liability,
                "unexpected kernel liability for {source:?} + {op:?}"
            );
        }
    }
}
