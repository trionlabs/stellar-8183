#![no_std]

use soroban_sdk::{
    contractclient, contracterror, contractevent, contracttype, Address, Bytes, BytesN, Env, String,
};

/// The six states required by ERC-8183.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JobState {
    Open,
    Funded,
    Submitted,
    Completed,
    Rejected,
    Expired,
}

impl JobState {
    pub fn is_live(&self) -> bool {
        matches!(self, Self::Open | Self::Funded | Self::Submitted)
    }

    pub fn has_funds(&self) -> bool {
        matches!(self, Self::Funded | Self::Submitted)
    }
}

/// A complete, independently archived job record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Job {
    pub id: u64,
    pub client: Address,
    pub provider: Option<Address>,
    pub evaluator: Address,
    pub desc: String,
    pub budget: i128,
    pub expires_at: u64,
    pub state: JobState,
    pub hook: Option<Address>,
    pub work_hash: Option<BytesN<32>>,
    pub decision: Option<BytesN<32>>,
}

/// A hookable kernel action.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    SetProv,
    SetBudget,
    Fund,
    Submit,
    Complete,
    Reject,
}

/// The action-specific value passed to a hook.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HookArg {
    None,
    Provider(Address),
    Budget(i128),
    Work(BytesN<32>),
    Decision(Option<BytesN<32>>),
}

/// A callback snapshot. Before callbacks receive the pre-action job state and
/// after callbacks receive the post-action state.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HookCtx {
    pub job_id: u64,
    pub action: Action,
    pub actor: Address,
    pub client: Address,
    pub provider: Option<Address>,
    pub evaluator: Address,
    pub budget: i128,
    pub expiry: u64,
    pub state: JobState,
    pub arg: HookArg,
    pub opt: Bytes,
}

/// Stable kernel error codes. These values are part of the public ABI.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    BadState = 2,
    BadActor = 3,
    BadExpiry = 4,
    BadDesc = 5,
    BadBudget = 6,
    NoProvider = 7,
    BudgetDiff = 8,
    HookDenied = 9,
    IdOverflow = 10,
    NoPending = 11,
    OptTooLong = 12,
    ProvExists = 13,
}

/// Generic callback ABI implemented by every admitted hook.
#[contractclient(name = "HookClient")]
pub trait Hook {
    fn before_action(env: Env, ctx: HookCtx);
    fn after_action(env: Env, ctx: HookCtx);
}

#[contractevent(topics = ["job_created"])]
pub struct JobCreated {
    #[topic]
    pub id: u64,
    #[topic]
    pub client: Address,
    pub provider: Option<Address>,
    pub evaluator: Address,
    pub expires_at: u64,
    pub hook: Option<Address>,
}

#[contractevent(topics = ["provider_set"])]
pub struct ProvSet {
    #[topic]
    pub id: u64,
    #[topic]
    pub provider: Address,
}

#[contractevent(topics = ["budget_set"])]
pub struct BudgetSet {
    #[topic]
    pub id: u64,
    #[topic]
    pub actor: Address,
    pub amount: i128,
}

#[contractevent(topics = ["job_funded"])]
pub struct JobFunded {
    #[topic]
    pub id: u64,
    #[topic]
    pub client: Address,
    pub amount: i128,
}

#[contractevent(topics = ["job_submitted"])]
pub struct JobSubmit {
    #[topic]
    pub id: u64,
    #[topic]
    pub provider: Address,
    pub work_hash: BytesN<32>,
}

#[contractevent(topics = ["job_completed"])]
pub struct JobDone {
    #[topic]
    pub id: u64,
    #[topic]
    pub evaluator: Address,
    pub reason: Option<BytesN<32>>,
}

#[contractevent(topics = ["job_rejected"])]
pub struct JobReject {
    #[topic]
    pub id: u64,
    #[topic]
    pub rejector: Address,
    pub reason: Option<BytesN<32>>,
}

#[contractevent(topics = ["job_expired"])]
pub struct JobExpire {
    #[topic]
    pub id: u64,
}

#[contractevent(topics = ["payment_released"])]
pub struct PayRelease {
    #[topic]
    pub id: u64,
    #[topic]
    pub provider: Address,
    pub amount: i128,
}

#[contractevent(topics = ["refunded"])]
pub struct Refunded {
    #[topic]
    pub id: u64,
    #[topic]
    pub client: Address,
    pub amount: i128,
}

#[contractevent(topics = ["hook_set"])]
pub struct HookSet {
    #[topic]
    pub hook: Address,
    pub allowed: bool,
}

#[contractevent(topics = ["admin_proposed"])]
pub struct AdminProp {
    #[topic]
    pub old_admin: Address,
    #[topic]
    pub pending: Address,
}

#[contractevent(topics = ["admin_accepted"])]
pub struct AdminSet {
    #[topic]
    pub old_admin: Address,
    #[topic]
    pub new_admin: Address,
}
