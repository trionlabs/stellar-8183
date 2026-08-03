#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env,
};
use stellar_8183_interfaces::{Action, HookCtx};

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Core,
    Review,
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum SlaError {
    SlaTime = 100,
    BadReview = 101,
}

#[contract]
pub struct SlaHook;

#[contractimpl]
impl SlaHook {
    pub fn __constructor(env: Env, core: Address, review_secs: u64) {
        if review_secs == 0 {
            panic_with_error!(&env, SlaError::BadReview);
        }
        env.storage().instance().set(&DataKey::Core, &core);
        env.storage().instance().set(&DataKey::Review, &review_secs);
        bump_ttl(&env, true);
    }

    pub fn before_action(env: Env, ctx: HookCtx) {
        require_core(&env);
        if ctx.action == Action::Submit {
            let review = review_secs(&env);
            let cutoff = env.ledger().timestamp().checked_add(review);
            if cutoff.map(|time| time > ctx.expiry).unwrap_or(true) {
                panic_with_error!(&env, SlaError::SlaTime);
            }
        }
        bump_ttl(&env, false);
    }

    pub fn after_action(env: Env, _ctx: HookCtx) {
        require_core(&env);
        bump_ttl(&env, false);
    }

    pub fn get_core(env: Env) -> Address {
        core(&env)
    }

    pub fn review_secs(env: Env) -> u64 {
        review_secs(&env)
    }
}

fn core(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Core)
        .expect("contract is initialized")
}

fn review_secs(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::Review)
        .expect("contract is initialized")
}

fn require_core(env: &Env) {
    core(env).require_auth();
}

fn bump_ttl(env: &Env, force: bool) {
    let extend_to = env.storage().max_ttl();
    let threshold = if force { extend_to } else { extend_to / 2 };
    env.deployer()
        .extend_ttl(env.current_contract_address(), threshold, extend_to);
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    #[should_panic]
    fn zero_review_window_is_rejected() {
        let env = Env::default();
        let core = Address::generate(&env);
        env.register(SlaHook, (core, 0_u64));
    }

    #[test]
    fn constructor_configuration_is_immutable() {
        let env = Env::default();
        let core = Address::generate(&env);
        let hook = env.register(SlaHook, (core.clone(), 60_u64));
        let client = SlaHookClient::new(&env, &hook);
        assert_eq!(client.get_core(), core);
        assert_eq!(client.review_secs(), 60);
    }
}
