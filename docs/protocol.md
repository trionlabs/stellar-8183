# Protocol and contract ABI

This is the version 0.1.0 contract interface. `Env` appears in Rust source but is
supplied by the Soroban host and is omitted from external call signatures below.

## Kernel data types

```text
JobState =
  Open | Funded | Submitted | Completed | Rejected | Expired

Job {
  id:         u64
  client:     Address
  provider:   Option<Address>
  evaluator:  Address
  desc:       String
  budget:     i128
  expires_at: u64
  state:      JobState
  hook:       Option<Address>
  work_hash:  Option<BytesN<32>>
  decision:   Option<BytesN<32>>
}
```

Job IDs begin at 1. `job_count()` is the number of jobs ever created, not the
number of live jobs. IDs use checked addition and are never reused.

`budget` is denominated in the immutable deployment token's smallest unit.
`expires_at` is a Unix timestamp compared with the current ledger timestamp.
`work_hash` commits to the provider's off-chain deliverable. `decision` is the
optional completion/rejection reason commitment.

Descriptions must contain 1 through 512 bytes of valid UTF-8. Every `opt`
argument is opaque to the kernel, passed unchanged to the hook, and limited to
1,024 bytes.

## State machine

| Current state      | Call           | Authorizer         | Next state | Token movement                 |
| ------------------ | -------------- | ------------------ | ---------- | ------------------------------ |
| Open               | `set_provider` | Client             | Open       | None                           |
| Open               | `set_budget`   | Client or provider | Open       | None                           |
| Open               | `fund`         | Client             | Funded     | Client → kernel, full budget   |
| Open               | `reject`       | Client             | Rejected   | None                           |
| Funded             | `submit`       | Provider           | Submitted  | None                           |
| Funded             | `reject`       | Evaluator          | Rejected   | Kernel → client, full budget   |
| Funded, expired    | `claim_refund` | None               | Expired    | Kernel → client, full budget   |
| Submitted          | `complete`     | Evaluator          | Completed  | Kernel → provider, full budget |
| Submitted          | `reject`       | Evaluator          | Rejected   | Kernel → client, full budget   |
| Submitted, expired | `claim_refund` | None               | Expired    | Kernel → client, full budget   |

No other state transition is valid. Completed, Rejected, and Expired are
terminal.

Creation requires `expires_at > ledger.timestamp`. Funding additionally
requires `ledger.timestamp < expires_at`. In keeping with the pinned ERC,
submission, completion, and rejection do not become invalid merely because the
timestamp has reached expiry. Once expired, those calls and `claim_refund` can
race; the first successful ledger transaction determines the next state.

## Kernel functions

### Constructor and lifecycle

```text
__constructor(admin: Address, token: Address) -> ()

create_job(
  client: Address,
  provider: Option<Address>,
  evaluator: Address,
  expires_at: u64,
  desc: String,
  hook: Option<Address>
) -> Result<u64, Error>

set_provider(
  id: u64,
  provider: Address,
  opt: Bytes
) -> Result<(), Error>

set_budget(
  id: u64,
  actor: Address,
  amount: i128,
  opt: Bytes
) -> Result<(), Error>

fund(
  id: u64,
  expected_budget: i128,
  opt: Bytes
) -> Result<(), Error>

submit(
  id: u64,
  work_hash: BytesN<32>,
  opt: Bytes
) -> Result<(), Error>

complete(
  id: u64,
  reason: Option<BytesN<32>>,
  opt: Bytes
) -> Result<(), Error>

reject(
  id: u64,
  reason: Option<BytesN<32>>,
  opt: Bytes
) -> Result<(), Error>

claim_refund(id: u64) -> Result<(), Error>
```

Behavioral details:

- `create_job` requires `client` authorization. A supplied hook must currently
  be admitted. It initializes state Open, budget zero, and both commitments
  absent. Creation does not invoke a hook.
- `set_provider` requires the stored client's authorization, an Open job, and
  an absent current provider. Provider assignment is permanent.
- `set_budget` first verifies that explicit `actor` equals the client or current
  provider, then requires that address's authorization. A positive amount can
  be replaced repeatedly while Open.
- `fund` requires the stored client's authorization, an assigned provider, a
  positive stored budget, and exact equality with `expected_budget`. It calls
  SEP-41 `transfer(client, kernel, budget)`; no ERC-20-style allowance is used.
- `submit` requires the stored provider's authorization and records
  `work_hash`.
- `complete` requires evaluator authorization and records `reason` in
  `decision`. The entire budget is paid to the provider; there are no fees.
- `reject` derives the required authorizer from state: client in Open,
  evaluator in Funded/Submitted. It records `reason`; funded escrow is fully
  refunded.
- `claim_refund` requires no authorization, accepts only Funded or Submitted at
  `ledger.timestamp >= expires_at`, never calls a hook, and refunds in full.

State writes, token calls, callbacks, and events share one atomic invocation. A
failed transfer or callback commits none of them.

### Reads and TTL

```text
get_job(id: u64) -> Result<Job, Error>
keep_alive(id: u64) -> Result<(), Error>
get_token() -> Address
get_admin() -> Address
job_count() -> u64
```

Reads are unauthenticated and do not silently extend a job. `keep_alive` is
permissionless and extends the named persistent entry plus kernel instance/code.
See [storage-and-ttl.md](storage-and-ttl.md).

### Administration

```text
propose_admin(admin: Address) -> ()
accept_admin() -> Result<(), Error>
set_hook(hook: Address, allowed: bool) -> ()
is_hook(hook: Address) -> bool
```

`propose_admin` and `set_hook` require current-admin authorization.
`accept_admin` loads the pending address and requires authorization from that
address; a caller cannot self-declare that it is pending. A new proposal
replaces the prior pending proposal.

`set_hook(hook, true)` admits a hook for new jobs and extends its admission
entry. `set_hook(hook, false)` removes admission. Removal does not mutate jobs
that already reference the hook and does not skip their callbacks.

The administrator cannot move escrow, alter jobs, pause the contract, replace
the token, or update Wasm.

## Hook ABI

```text
Action =
  SetProv | SetBudget | Fund | Submit | Complete | Reject

HookArg =
  None
  | Provider(Address)
  | Budget(i128)
  | Work(BytesN<32>)
  | Decision(Option<BytesN<32>>)

HookCtx {
  job_id:   u64
  action:   Action
  actor:    Address
  client:   Address
  provider: Option<Address>
  evaluator: Address
  budget:   i128
  expiry:   u64
  state:    JobState
  arg:      HookArg
  opt:      Bytes
}

before_action(ctx: HookCtx) -> ()
after_action(ctx: HookCtx) -> ()
```

The before callback receives the complete pre-action snapshot. The after
callback receives the post-action snapshot after core state and any token
movement. `arg` identifies the proposed value even when the before snapshot
still contains the old value:

| Action    | Actor                               | Hook argument            |
| --------- | ----------------------------------- | ------------------------ |
| SetProv   | Client                              | `Provider(new_provider)` |
| SetBudget | Explicit client/provider            | `Budget(new_amount)`     |
| Fund      | Client                              | `None`                   |
| Submit    | Provider                            | `Work(work_hash)`        |
| Complete  | Evaluator                           | `Decision(reason)`       |
| Reject    | Client or evaluator, based on state | `Decision(reason)`       |

The hook should bind one kernel address at construction and call
`require_auth()` on that address in both callbacks. Soroban recognizes the
direct contract invoker; an external actor cannot spoof a callback.

## SLA hook ABI

```text
__constructor(core: Address, review_secs: u64) -> ()
before_action(ctx: HookCtx) -> ()
after_action(ctx: HookCtx) -> ()
get_core() -> Address
review_secs() -> u64
```

`review_secs` must be positive. On a Submit before-callback, the hook performs
checked addition and requires:

```text
ledger.timestamp + review_secs <= ctx.expiry
```

Violation fails with `SlaError::SlaTime` (`100`). A zero review window is
rejected at construction with `SlaError::BadReview` (`101`). Other actions pass
through. The hook stores no job data or tokens and has no upgrade function.

## Contract errors

The following numeric values are stable ABI:

| Code | Variant      | Meaning                                                                       |
| ---: | ------------ | ----------------------------------------------------------------------------- |
|    1 | `NotFound`   | Job does not exist or its persistent entry is not available to the invocation |
|    2 | `BadState`   | Action is invalid for current state                                           |
|    3 | `BadActor`   | Explicit budget actor is neither client nor provider                          |
|    4 | `BadExpiry`  | Creation/funding/refund timestamp condition failed                            |
|    5 | `BadDesc`    | Description is empty, oversized, or invalid UTF-8                             |
|    6 | `BadBudget`  | Amount is not positive                                                        |
|    7 | `NoProvider` | Funding/submission/payment requires an assigned provider                      |
|    8 | `BudgetDiff` | Expected budget differs from stored budget                                    |
|    9 | `HookDenied` | Hook was not admitted at job creation                                         |
|   10 | `IdOverflow` | No next `u64` job identifier exists                                           |
|   11 | `NoPending`  | No pending administrator proposal exists                                      |
|   12 | `OptTooLong` | Opaque hook options exceed 1,024 bytes                                        |
|   13 | `ProvExists` | Provider is already assigned                                                  |

Failed `require_auth()` checks are Soroban authorization failures rather than
contract error variants.

Hook failures retain the called hook contract's error namespace. The reference
SLA hook reserves `SlaTime = 100` and `BadReview = 101`; these are not kernel
errors. Private adversarial fixtures use `HookFailed = 900` and
`AfterFail = 901`. Generated clients must report unknown nested-contract errors
without mislabeling them as a kernel variant.

## Events

The first topic is the static event name shown below. Additional topic fields
are indexed in order; remaining fields are event data.

| Static topic       | Indexed fields           | Data                                          |
| ------------------ | ------------------------ | --------------------------------------------- |
| `job_created`      | `id`, `client`           | `provider`, `evaluator`, `expires_at`, `hook` |
| `provider_set`     | `id`, `provider`         | None                                          |
| `budget_set`       | `id`, `actor`            | `amount`                                      |
| `job_funded`       | `id`, `client`           | `amount`                                      |
| `job_submitted`    | `id`, `provider`         | `work_hash`                                   |
| `job_completed`    | `id`, `evaluator`        | `reason`                                      |
| `job_rejected`     | `id`, `rejector`         | `reason`                                      |
| `job_expired`      | `id`                     | None                                          |
| `payment_released` | `id`, `provider`         | `amount`                                      |
| `refunded`         | `id`, `client`           | `amount`                                      |
| `hook_set`         | `hook`                   | `allowed`                                     |
| `admin_proposed`   | `old_admin`, `pending`   | None                                          |
| `admin_accepted`   | `old_admin`, `new_admin` | None                                          |

Events from a failed transaction are not durable contract events. Consumers
must derive truth from successful transaction status plus contract state, not
from diagnostic output.
