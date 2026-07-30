#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, token, Address, Bytes, BytesN, Env, String,
};
use stellar_8183_interfaces::{
    AdminProp, AdminSet, BudgetSet, Error, Job, JobCreated, JobDone, JobExpire, JobFunded,
    JobReject, JobState, JobSubmit, PayRelease, ProvSet, Refunded,
};

pub use stellar_8183_interfaces;

const DESC_MAX: u32 = 512;
const OPT_MAX: u32 = 1_024;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Pending,
    Token,
    NextId,
    Job(u64),
}

#[contract]
pub struct Commerce;

#[contractimpl]
impl Commerce {
    pub fn __constructor(env: Env, admin: Address, token: Address) {
        let store = env.storage().instance();
        store.set(&DataKey::Admin, &admin);
        store.set(&DataKey::Token, &token);
        store.set(&DataKey::NextId, &1_u64);
        bump_core(&env, true);
    }

    pub fn create_job(
        env: Env,
        client: Address,
        provider: Option<Address>,
        evaluator: Address,
        expires_at: u64,
        desc: String,
        hook: Option<Address>,
    ) -> Result<u64, Error> {
        validate_desc(&desc)?;
        if expires_at <= env.ledger().timestamp() {
            return Err(Error::BadExpiry);
        }
        if hook.is_some() {
            return Err(Error::HookDenied);
        }
        client.require_auth();

        let next: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .expect("contract is initialized");
        let following = next.checked_add(1).ok_or(Error::IdOverflow)?;
        let job = Job {
            id: next,
            client: client.clone(),
            provider: provider.clone(),
            evaluator: evaluator.clone(),
            desc,
            budget: 0,
            expires_at,
            state: JobState::Open,
            hook: hook.clone(),
            work_hash: None,
            decision: None,
        };

        env.storage().instance().set(&DataKey::NextId, &following);
        put_job(&env, &job);
        bump_job(&env, next, true);
        JobCreated {
            id: next,
            client,
            provider,
            evaluator,
            expires_at,
            hook,
        }
        .publish(&env);
        Ok(next)
    }

    pub fn set_provider(env: Env, id: u64, provider: Address, opt: Bytes) -> Result<(), Error> {
        validate_opt(&opt)?;
        let mut job = read_job(&env, id)?;
        require_state(&job, JobState::Open)?;
        if job.provider.is_some() {
            return Err(Error::ProvExists);
        }
        let actor = job.client.clone();
        actor.require_auth();

        job.provider = Some(provider.clone());
        put_job(&env, &job);
        ProvSet { id, provider }.publish(&env);
        bump_job(&env, id, false);
        Ok(())
    }

    pub fn set_budget(
        env: Env,
        id: u64,
        actor: Address,
        amount: i128,
        opt: Bytes,
    ) -> Result<(), Error> {
        validate_opt(&opt)?;
        if amount <= 0 {
            return Err(Error::BadBudget);
        }
        let mut job = read_job(&env, id)?;
        require_state(&job, JobState::Open)?;
        let is_client = actor == job.client;
        let is_provider = job
            .provider
            .as_ref()
            .map(|provider| actor == *provider)
            .unwrap_or(false);
        if !is_client && !is_provider {
            return Err(Error::BadActor);
        }
        actor.require_auth();

        job.budget = amount;
        put_job(&env, &job);
        BudgetSet {
            id,
            actor: actor.clone(),
            amount,
        }
        .publish(&env);
        bump_job(&env, id, false);
        Ok(())
    }

    pub fn fund(env: Env, id: u64, expected_budget: i128, opt: Bytes) -> Result<(), Error> {
        validate_opt(&opt)?;
        let mut job = read_job(&env, id)?;
        require_state(&job, JobState::Open)?;
        if env.ledger().timestamp() >= job.expires_at {
            return Err(Error::BadExpiry);
        }
        if job.provider.is_none() {
            return Err(Error::NoProvider);
        }
        if job.budget <= 0 {
            return Err(Error::BadBudget);
        }
        if job.budget != expected_budget {
            return Err(Error::BudgetDiff);
        }
        let actor = job.client.clone();
        actor.require_auth();

        job.state = JobState::Funded;
        put_job(&env, &job);
        let escrow = env.current_contract_address();
        token::Client::new(&env, &get_token(&env)).transfer(&actor, &escrow, &job.budget);
        JobFunded {
            id,
            client: actor.clone(),
            amount: job.budget,
        }
        .publish(&env);
        bump_job(&env, id, false);
        Ok(())
    }

    pub fn submit(env: Env, id: u64, work_hash: BytesN<32>, opt: Bytes) -> Result<(), Error> {
        validate_opt(&opt)?;
        let mut job = read_job(&env, id)?;
        require_state(&job, JobState::Funded)?;
        let actor = job.provider.clone().ok_or(Error::NoProvider)?;
        actor.require_auth();

        job.state = JobState::Submitted;
        job.work_hash = Some(work_hash.clone());
        put_job(&env, &job);
        JobSubmit {
            id,
            provider: actor.clone(),
            work_hash: work_hash.clone(),
        }
        .publish(&env);
        bump_job(&env, id, false);
        Ok(())
    }

    pub fn complete(
        env: Env,
        id: u64,
        reason: Option<BytesN<32>>,
        opt: Bytes,
    ) -> Result<(), Error> {
        validate_opt(&opt)?;
        let mut job = read_job(&env, id)?;
        require_state(&job, JobState::Submitted)?;
        let actor = job.evaluator.clone();
        let provider = job.provider.clone().ok_or(Error::NoProvider)?;
        actor.require_auth();

        job.state = JobState::Completed;
        job.decision = reason.clone();
        put_job(&env, &job);
        token::Client::new(&env, &get_token(&env)).transfer(
            &env.current_contract_address(),
            &provider,
            &job.budget,
        );
        JobDone {
            id,
            evaluator: actor,
            reason,
        }
        .publish(&env);
        PayRelease {
            id,
            provider,
            amount: job.budget,
        }
        .publish(&env);
        Ok(())
    }

    pub fn reject(env: Env, id: u64, reason: Option<BytesN<32>>, opt: Bytes) -> Result<(), Error> {
        validate_opt(&opt)?;
        let mut job = read_job(&env, id)?;
        let previous = job.state;
        let actor = match previous {
            JobState::Open => job.client.clone(),
            JobState::Funded | JobState::Submitted => job.evaluator.clone(),
            _ => return Err(Error::BadState),
        };
        actor.require_auth();

        job.state = JobState::Rejected;
        job.decision = reason.clone();
        put_job(&env, &job);
        if previous.has_funds() {
            token::Client::new(&env, &get_token(&env)).transfer(
                &env.current_contract_address(),
                &job.client,
                &job.budget,
            );
            Refunded {
                id,
                client: job.client.clone(),
                amount: job.budget,
            }
            .publish(&env);
        }
        JobReject {
            id,
            rejector: actor,
            reason,
        }
        .publish(&env);
        Ok(())
    }

    /// Permissionless and deliberately not hookable.
    pub fn claim_refund(env: Env, id: u64) -> Result<(), Error> {
        let mut job = read_job(&env, id)?;
        if !job.state.has_funds() {
            return Err(Error::BadState);
        }
        if env.ledger().timestamp() < job.expires_at {
            return Err(Error::BadExpiry);
        }

        job.state = JobState::Expired;
        put_job(&env, &job);
        token::Client::new(&env, &get_token(&env)).transfer(
            &env.current_contract_address(),
            &job.client,
            &job.budget,
        );
        Refunded {
            id,
            client: job.client,
            amount: job.budget,
        }
        .publish(&env);
        JobExpire { id }.publish(&env);
        Ok(())
    }

    pub fn get_job(env: Env, id: u64) -> Result<Job, Error> {
        read_job(&env, id)
    }

    pub fn keep_alive(env: Env, id: u64) -> Result<(), Error> {
        read_job(&env, id)?;
        bump_job(&env, id, true);
        Ok(())
    }

    pub fn propose_admin(env: Env, admin: Address) {
        let old_admin = get_admin(&env);
        old_admin.require_auth();
        env.storage().instance().set(&DataKey::Pending, &admin);
        AdminProp {
            old_admin,
            pending: admin,
        }
        .publish(&env);
        bump_core(&env, false);
    }

    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pending)
            .ok_or(Error::NoPending)?;
        let old_admin = get_admin(&env);
        pending.require_auth();
        env.storage().instance().set(&DataKey::Admin, &pending);
        env.storage().instance().remove(&DataKey::Pending);
        AdminSet {
            old_admin,
            new_admin: pending,
        }
        .publish(&env);
        bump_core(&env, false);
        Ok(())
    }

    pub fn get_token(env: Env) -> Address {
        get_token(&env)
    }

    pub fn get_admin(env: Env) -> Address {
        get_admin(&env)
    }

    pub fn job_count(env: Env) -> u64 {
        let next: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .expect("contract is initialized");
        next - 1
    }
}

fn read_job(env: &Env, id: u64) -> Result<Job, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Job(id))
        .ok_or(Error::NotFound)
}

fn put_job(env: &Env, job: &Job) {
    env.storage().persistent().set(&DataKey::Job(job.id), job);
}

fn get_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("contract is initialized")
}

fn get_token(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Token)
        .expect("contract is initialized")
}

fn require_state(job: &Job, expected: JobState) -> Result<(), Error> {
    if job.state == expected {
        Ok(())
    } else {
        Err(Error::BadState)
    }
}

fn validate_desc(desc: &String) -> Result<(), Error> {
    let bytes = desc.to_bytes();
    if bytes.is_empty() || bytes.len() > DESC_MAX || !valid_utf8(&bytes) {
        Err(Error::BadDesc)
    } else {
        Ok(())
    }
}

fn valid_utf8(bytes: &Bytes) -> bool {
    let len = bytes.len();
    let mut i = 0_u32;
    while i < len {
        let first = bytes.get_unchecked(i);
        if first <= 0x7f {
            i += 1;
            continue;
        }

        let (width, second_min, second_max) = if (0xc2..=0xdf).contains(&first) {
            (2_u32, 0x80_u8, 0xbf_u8)
        } else if first == 0xe0 {
            (3, 0xa0, 0xbf)
        } else if (0xe1..=0xec).contains(&first) || (0xee..=0xef).contains(&first) {
            (3, 0x80, 0xbf)
        } else if first == 0xed {
            (3, 0x80, 0x9f)
        } else if first == 0xf0 {
            (4, 0x90, 0xbf)
        } else if (0xf1..=0xf3).contains(&first) {
            (4, 0x80, 0xbf)
        } else if first == 0xf4 {
            (4, 0x80, 0x8f)
        } else {
            return false;
        };

        if i + width > len {
            return false;
        }
        let second = bytes.get_unchecked(i + 1);
        if second < second_min || second > second_max {
            return false;
        }
        let mut j = 2_u32;
        while j < width {
            let continuation = bytes.get_unchecked(i + j);
            if !(0x80..=0xbf).contains(&continuation) {
                return false;
            }
            j += 1;
        }
        i += width;
    }
    true
}

fn validate_opt(opt: &Bytes) -> Result<(), Error> {
    if opt.len() > OPT_MAX {
        Err(Error::OptTooLong)
    } else {
        Ok(())
    }
}

fn bump_job(env: &Env, id: u64, force: bool) {
    bump_key(env, &DataKey::Job(id), force);
    bump_core(env, force);
}

fn bump_key(env: &Env, key: &DataKey, force: bool) {
    let extend_to = env.storage().max_ttl();
    let threshold = if force { extend_to } else { extend_to / 2 };
    env.storage()
        .persistent()
        .extend_ttl(key, threshold, extend_to);
}

fn bump_core(env: &Env, force: bool) {
    let extend_to = env.storage().max_ttl();
    let threshold = if force { extend_to } else { extend_to / 2 };
    env.deployer()
        .extend_ttl(env.current_contract_address(), threshold, extend_to);
}

#[cfg(test)]
mod test;
