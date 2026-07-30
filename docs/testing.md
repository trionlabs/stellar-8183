# Test strategy and acceptance matrix

The test layers must not be conflated. Contract unit tests execute Rust
contracts in Soroban SDK's native test host; they do not execute the optimized
Wasm file. CI separately builds, inspects, size-checks, and reproducibility
checks that Wasm. The required public testnet run is the integration layer that
executes the deployed optimized Wasm.

## Local quality gates

From a clean checkout:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
stellar contract build --locked --optimize
pnpm install --frozen-lockfile
pnpm check
```

CI additionally runs Rust dependency and secret audits, checks generated
binding drift, parses the Wasm interface and metadata, enforces the artifact
size limit, inspects the npm tarball, and compares two independent optimized
builds byte for byte. There is currently no compiled-Wasm local integration
harness; successful native-host tests alone are therefore insufficient
testnet evidence.

## State-transition matrix

| From               | Action       | Required role      | To        | Value movement                 |
| ------------------ | ------------ | ------------------ | --------- | ------------------------------ |
| Open               | Set provider | Client             | Open      | None                           |
| Open               | Set budget   | Client or provider | Open      | None                           |
| Open               | Fund         | Client             | Funded    | Client → kernel, full budget   |
| Open               | Reject       | Client             | Rejected  | None                           |
| Funded             | Submit       | Provider           | Submitted | None                           |
| Funded             | Reject       | Evaluator          | Rejected  | Kernel → client, full budget   |
| Funded, expired    | Claim refund | Anyone             | Expired   | Kernel → client, full budget   |
| Submitted          | Complete     | Evaluator          | Completed | Kernel → provider, full budget |
| Submitted          | Reject       | Evaluator          | Rejected  | Kernel → client, full budget   |
| Submitted, expired | Claim refund | Anyone             | Expired   | Kernel → client, full budget   |

Every unlisted edge must fail without changing state, balances, or durable
events.

## Contract test groups

### Validation and authorization

- Missing job, future-expiry boundary, empty/oversized description, oversized
  hook options, unadmitted hook, and job-ID overflow. An absent evaluator is
  excluded at the ABI/type level because `create_job` requires an `Address`;
  it is not a runtime input that can be encoded.
- Missing provider, repeated provider assignment, wrong expected budget,
  non-positive budget, and funding at/after expiry.
- Correct and incorrect client/provider/evaluator signatures for every path.
- Client and provider repeatedly negotiate the budget while Open.
- Replayed, expired, mutated, missing, and extra authorization entries.
- Evaluator equal to client and distinct-role jobs.

### State and value

- Every allowed transition and every forbidden edge.
- Exact token conservation across multiple simultaneous jobs.
- Double funding, submission, completion, rejection, and refund.
- Rollback when a SEP-41 transfer fails because of balance, authorization,
  trustline, freeze, or recipient constraints.
- Terminal immutability and exactly-once release.
- Unsolicited token surplus cannot be assigned or swept.
- Exact expiry boundary (`timestamp == expires_at`).
- Both ordering-race winners after expiry: evaluator/provider action first and
  refund first.

### Hooks

- Callback context for every hookable action in pre-state and post-state form.
- No callbacks on create or refund.
- Before-hook failure leaves state and balances unchanged.
- After-hook failure rolls back earlier state and token changes.
- Direct callback spoofing fails kernel authorization.
- Ordinary re-entry attempt fails safely.
- The resource-heavy test hook executes successfully under the native test
  host's default limits. This is a regression smoke test, not a measured
  production failure threshold.
- Hook removal blocks new jobs but not callbacks on existing jobs.
- SLA permits and denies submissions on both sides of the exact review-window
  boundary.
- The named `refund_cannot_be_blocked_by_hook` test uses an always-reverting
  hook and proves a full refund after expiry.

### TTL and archival

- Creation and threshold-based extension behavior for job, instance, and code.
- No redundant extension above the threshold.
- No automatic job bump after terminal settlement.
- Explicit `keep_alive` for active and terminal jobs.
- Native-host ledger advancement archives a funded job and demonstrates
  restoration followed by an exact refund.
- The live testnet gate executes the optimized Wasm lifecycle. Long TTLs make
  forced archival impractical during that release run, so separate-restoration
  envelope policy is covered by dedicated adversarial SDK tests rather than
  claimed as live evidence.

### Model and resource tests

The checked-in transition-table test exhaustively evaluates each modeled
state/action pair and compares expected success, resulting state, and token
liability with the contract result. Useful properties include:

- terminal state is absorbing;
- live liability equals the sum of budgets in Funded/Submitted;
- total released plus refunded plus live liability equals total funded;
- a job releases at most once;
- the next identifier is strictly monotonic.

Testnet evidence records instruction, read/write byte, ledger-entry, event, and
fee data for every demonstrated transaction. The repository does not yet
enforce a numeric resource-regression threshold, so the checked-in
resource-heavy native-host smoke test must not be described as one.

## SDK test groups

- Encode/decode every public type and contract method.
- Decimal conversion around zero, maximum safe values, and arbitrary token
  decimals.
- Commitment hashing uses canonical bytes and produces 32 bytes.
- Recording simulation → role auth signing → enforcing simulation.
- Nested token-transfer authorization on funding.
- Facilitator rejects every hostile-envelope case in
  [security.md](security.md).
- The separate restore-footprint fallback is disabled by default. Guarded
  fallback restoration accepts only a separately trusted exact ledger-key
  allowlist, a fee ceiling, a bounded lifetime, and the expected facilitator
  signer; hostile restoration envelopes fail closed. Protocol 23
  same-envelope archived keys remain pinned in the relay footprint.
- Retry/status polling distinguishes pending, success, failure, timeout, and
  unknown status without duplicate intent.
- A clean external fixture installs the packed tarball, imports public exports,
  and builds under Node 22.
- `EvidenceRecorder` emits only the documented secret-whitelisted
  `RawEvidenceCapture`; deterministic release assembly and semantic validation
  reject missing or contradictory raw/build/deployment inputs, wrong role
  authorization, broken balance arithmetic, artifact mismatches, and overwrite
  attempts.
- Live evidence verification re-fetches every still-retained testnet
  transaction and decodes its envelope to recheck hash, source, function,
  arguments, authorization addresses, result XDR, and resource declaration.
  Deployment verification additionally binds `createContractV2`, Wasm hash,
  constructor arguments, address preimage, and derived contract ID.
- `npm pack --dry-run` contains no seeds, `.env`, private deployment material,
  test fixtures with secrets, or unrelated workspace files.

## Testnet acceptance

The public testnet run must use distinct admin, client, provider, evaluator, and
facilitator addresses, with the facilitator as transaction source and role
addresses represented by signed auth entries.

Required public scenarios:

1. Create without provider → set provider → negotiate budget → fund exactly
   1 test USDC → submit → complete.
2. Create → budget → fund → reach ledger-time expiry → permissionless refund.
3. Open rejection.
4. Evaluator rejection from at least one funded state.

After each transaction, capture the job, token balances, decoded contract/token
events, role authorizers, source account, ledger, resource costs, and explorer
link. The on-chain manifest must validate with status `deployment`; final
release acceptance requires the same manifest promoted to `verified` under
[evidence.schema.json](evidence.schema.json). CI must preserve the provisional
`evidence.deployment.json` and publish the independently checked
`evidence.verified.json` as a separate release asset.

No diagnostic environment that disables production resource limits can satisfy
testnet acceptance.
