#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error, Address,
    Bytes, Env,
};
use stellar_8183_interfaces::{Action, HookCtx};

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    Pass,
    AlwaysFail,
    AfterFail,
    FundAfter,
    SettleFail,
    Reenter,
    Workload,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Stats {
    pub before: u32,
    pub after: u32,
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TestError {
    HookFailed = 900,
    AfterFail = 901,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Core,
    Mode,
    Stats,
}

#[contractclient(name = "CoreClient")]
#[allow(dead_code)]
trait CoreView {
    fn job_count(env: Env) -> u64;
}

#[contract]
pub struct TestHooks;

#[contractimpl]
impl TestHooks {
    pub fn __constructor(env: Env, core: Address, mode: Mode) {
        env.storage().instance().set(&DataKey::Core, &core);
        env.storage().instance().set(&DataKey::Mode, &mode);
        env.storage().instance().set(
            &DataKey::Stats,
            &Stats {
                before: 0,
                after: 0,
            },
        );
    }

    pub fn before_action(env: Env, ctx: HookCtx) {
        let core = require_core(&env);
        let mode = mode(&env);
        if mode == Mode::AlwaysFail {
            panic_with_error!(&env, TestError::HookFailed);
        }
        if mode == Mode::SettleFail && matches!(ctx.action, Action::Complete | Action::Reject) {
            panic_with_error!(&env, TestError::HookFailed);
        }
        if mode == Mode::Reenter {
            // Soroban rejects this while the kernel is already on the contract
            // call stack. The fixture makes that host guarantee testable.
            CoreClient::new(&env, &core).job_count();
        }
        if mode == Mode::Workload {
            workload(&env, &ctx.opt);
        }
        update_stats(&env, true);
    }

    pub fn after_action(env: Env, ctx: HookCtx) {
        require_core(&env);
        let mode = mode(&env);
        if mode == Mode::AlwaysFail {
            panic_with_error!(&env, TestError::HookFailed);
        }
        if mode == Mode::AfterFail {
            panic_with_error!(&env, TestError::AfterFail);
        }
        if mode == Mode::FundAfter && ctx.action == Action::Fund {
            panic_with_error!(&env, TestError::AfterFail);
        }
        if mode == Mode::Workload {
            workload(&env, &ctx.opt);
        }
        update_stats(&env, false);
    }

    pub fn get_mode(env: Env) -> Mode {
        mode(&env)
    }

    pub fn stats(env: Env) -> Stats {
        env.storage()
            .instance()
            .get(&DataKey::Stats)
            .expect("contract is initialized")
    }
}

fn core(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Core)
        .expect("contract is initialized")
}

fn mode(env: &Env) -> Mode {
    env.storage()
        .instance()
        .get(&DataKey::Mode)
        .expect("contract is initialized")
}

fn require_core(env: &Env) -> Address {
    let core = core(env);
    core.require_auth();
    core
}

fn update_stats(env: &Env, before: bool) {
    let mut stats: Stats = env
        .storage()
        .instance()
        .get(&DataKey::Stats)
        .expect("contract is initialized");
    if before {
        stats.before = stats.before.saturating_add(1);
    } else {
        stats.after = stats.after.saturating_add(1);
    }
    env.storage().instance().set(&DataKey::Stats, &stats);
}

fn workload(env: &Env, opt: &Bytes) {
    let mut input = opt.clone();
    let mut round = 0_u32;
    while round < 64 {
        input = env.crypto().sha256(&input).into();
        round += 1;
    }
}
