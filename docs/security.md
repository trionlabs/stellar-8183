# Security and threat model

This is unaudited testnet software. It must not be treated as safe for mainnet
funds.

## Trust assumptions

- The evaluator is trusted to judge the job. It can approve bad work, reject
  good work, or fail to act. Expiry limits liveness damage but does not provide
  fair arbitration.
- The client chooses the job terms and, for an unassigned job, chooses the
  provider. The provider must inspect the final on-chain budget, evaluator,
  expiry, token, and hook before doing work.
- A hook is trusted policy code for that job. Admission is a safety filter, not
  an audit or a guarantee.
- Stellar consensus, the selected RPC, SEP-41 token implementation, signing
  wallet, and facilitator are external dependencies. State and transaction
  results should be independently verified when value matters.
- A GitHub/SEP-55 build attestation proves provenance of a Wasm artifact; it
  does not prove that the source or artifact is safe.

## Core value invariants

For every successful invocation:

- Only Open jobs can become Funded.
- Funding moves exactly `budget` base units from client to kernel or changes
  nothing.
- A Funded or Submitted job contributes exactly `budget` to live escrow
  liabilities.
- Completion transfers exactly `budget` to the provider and sets Completed.
- Funded/Submitted rejection transfers exactly `budget` to the client and sets
  Rejected.
- Expiry refund transfers exactly `budget` to the client and sets Expired.
- A terminal job never changes state and never releases value again.
- The kernel token balance is at least the sum of all live liabilities.

There is no administrative sweep. An unsolicited token transfer to the kernel
is surplus that is not attributed to any job and cannot be recovered through
the ABI. This avoids an admin drain capability at the cost of permanently
locking accidental transfers.

## Authorization boundaries

| Action                             | Required authorization                                    |
| ---------------------------------- | --------------------------------------------------------- |
| Create                             | Explicit client                                           |
| Set provider                       | Recorded client                                           |
| Set budget                         | Explicit actor after matching recorded client or provider |
| Fund                               | Recorded client, including nested token transfer          |
| Submit                             | Recorded provider                                         |
| Complete                           | Recorded evaluator                                        |
| Reject Open                        | Recorded client                                           |
| Reject Funded/Submitted            | Recorded evaluator                                        |
| Claim refund                       | None                                                      |
| Propose admin / set hook admission | Current admin                                             |
| Accept admin                       | Pending admin                                             |
| Read / keep alive                  | None                                                      |

Authorization is checked against the economic role, never inferred from the
transaction source. Tests must use exact authorization trees; blanket mocks such
as “mock all auth” cannot be the only proof.

## Expiry and ordering races

Expiry enables `claim_refund`; it does not automatically execute a transition
or reserve transaction ordering. At or after expiry:

- From Funded, evaluator rejection, provider submission, or refund may be
  otherwise valid.
- From Submitted, evaluator completion, evaluator rejection, or refund may be
  otherwise valid.
- The first successful transaction applied wins. Every later attempt observes a
  terminal or otherwise changed state and fails.

Funding is not allowed at or after expiry. Integrators that require a guaranteed
evaluation window should use the SLA hook, which refuses submission unless
`ledger_timestamp + review_secs <= expires_at`.

## Hook boundary

- `create_job` and `claim_refund` never call a hook.
- Before and after callbacks cover only set-provider, set-budget, fund, submit,
  complete, and reject.
- The hook authenticates that its stored kernel address is the direct contract
  invoker.
- A before-hook failure makes no core change.
- An after-hook failure rolls back core state, events, SEP-41 transfers, and
  hook side effects in the transaction.
- A hook removed from the admission set still runs for jobs that already stored
  it. Otherwise an administrator could rewrite policy mid-job.
- Ordinary contract re-entry is rejected by the Soroban host. A test hook still
  attempts it so this assumption is checked against the pinned runtime.
- Soroban has transaction-level resource limits rather than EVM per-call gas.
  Resource-heavy hooks can make hookable actions fail; the non-hookable refund
  remains the recovery path.

The SLA hook is immutable, binds one kernel in its constructor, checks caller
authorization, uses checked timestamp arithmetic, and contains no token custody.

## Relayer/facilitator threats

The role signs an authorization entry, not an arbitrary transaction. A malicious
envelope can still try to make the facilitator pay for unintended work. The
facilitator must reject:

- the wrong network passphrase;
- zero or multiple operations;
- an operation other than the expected contract invocation;
- a different contract, function, or argument set;
- an operation-level source or authorization involving the facilitator;
- missing, duplicated, or unexpected role authorizers;
- absent, stale, or excessive time bounds;
- an inclusion/resource fee above policy;
- stale simulation, missing restoration information, or enforcing-mode failure.

The facilitator rebuilds with its current account sequence, freshly simulates,
signs only after all checks, submits, and waits for a terminal RPC result. No
seed or secret may be logged, serialized into evidence, bundled into the npm
package, or shown in the recording.

The separate restore-footprint fallback is a distinct signing boundary and is
disabled by default. A raw wallet `signTransaction` callback must never approve
an RPC-proposed restore-footprint envelope. The opt-in guard requires
independently derived exact ledger keys, a complete-fee ceiling, finite
lifetime, expected network, and expected facilitator, then verifies the
complete transaction body and final signature before returning it. After
restoration, discard prior simulations and authorization entries and prepare
the intended invocation again.
Protocol 23 same-envelope archived entries in a successful invoke simulation
are handled separately: their exact resolved ledger keys and the full footprint
are pinned in the trusted relay intent and cannot change during facilitation;
`restore: false` does not remove them.

The initial recording simulation and its RPC choose the first pinned footprint
and are therefore a trust boundary. Derive expected keys independently or
compare trusted RPCs when value warrants it. Enforcing simulation may revise
resource scalar estimates, but it must preserve the invocation, authorization
roots, and key sets, and the final total fee cannot exceed the trusted
`maxFee`.

## Token threats

- Constructor token selection is immutable; deploying with the wrong token
  requires abandoning that deployment.
- The kernel uses the SEP-41 interface and integer base units. SDK decimal
  conversion must check the token's reported decimals.
- Missing, unauthorized, frozen, or insufficient client balance makes funding
  fail atomically.
- A G-account provider without the required classic trustline cannot receive a
  Stellar Asset Contract payment; completion must roll back rather than settle
  without payment.
- Refund liveness also depends on the client remaining able to receive the
  asset. If the issuer freezes the client, or the client removes its empty
  classic trustline after funding, rejection/refund fails atomically and the
  job remains Funded or Submitted until that recipient condition is repaired.
  Permissionless triggering cannot bypass Stellar Asset Contract authorization
  or trustline rules.
- Fee-on-transfer or otherwise non-SEP-41-compatible behavior is unsupported.
  Testnet release evidence uses the official USDC Stellar Asset Contract.

## Storage and availability threats

Persistent state and instance/code may archive. They can be restored on Protocol
23+ when fresh simulation includes them in the restore list, but restoration
costs resources and depends on available historical state. See
[storage-and-ttl.md](storage-and-ttl.md).

Events are not durable application storage and RPC event retention can be short.
Evidence capture must save transaction hashes, ledgers, decoded events, and state
snapshots immediately after the testnet run.

## Operational controls

- No mainnet deployment before an independent audit and explicit production
  threat-model review.
- Release only byte-reproducible optimized Wasm whose local hash matches Wasm
  fetched from the deployed contract.
- Pin the source commit and toolchain; attest release artifacts using SEP-55
  compatible GitHub provenance.
- Use dedicated, valueless testnet identities.
- Keep `.env`, Stellar identity stores, videos containing secrets, and raw
  signing traces out of git and release artifacts.
- Treat any unresolved critical or high review finding as a release blocker.

Security issues should be reported privately to `deniz@trionlabs.dev`, with no
live secrets or sensitive user data in the report.
