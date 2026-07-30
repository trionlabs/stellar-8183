# Storage, TTL, archival, and restoration

Escrow liveness depends on treating TTL as an ordinary state lifecycle, not an
exception. A Unix expiry timestamp does not keep a Soroban ledger entry live.

## Storage layout

| Data                                     | Storage class         | Keying                              | Reason                                                                                |
| ---------------------------------------- | --------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| Admin, pending admin, token, next job ID | Instance              | Fixed keys in the contract instance | Small deployment-wide configuration loaded on every invocation                        |
| Job                                      | Persistent            | One `Job(id)` entry per job         | Escrow state must be recoverable and jobs must not create an unbounded instance entry |
| Hook admission                           | Persistent            | One `Hook(address)` entry per hook  | Admission grows independently and need not load on unrelated invocations              |
| Escrow funds                             | SEP-41 token contract | Kernel contract address             | Value is held by the token contract, not serialized into kernel storage               |

Temporary storage is never used for jobs, configuration, or hook admission.
Temporary entries are permanently deleted when their TTL reaches zero and
cannot safely represent escrow liabilities.

## Extension policy

The implementation derives the current network maximum through
`env.storage().max_ttl()`; it does not hard-code a number of days.

- `create_job` extends the new persistent job entry and the kernel instance/code
  to the network maximum.
- A successful nonterminal mutation checks the remaining TTL. When it is below
  half the current maximum, the job is extended to the maximum.
- Instance extension uses the same half-maximum threshold and extends both the
  contract instance and its Wasm code.
- `keep_alive(id)` is permissionless and extends the named job plus
  instance/code, even for a terminal job.
- Automatic mutation-time job bumps stop after Completed, Rejected, or Expired.
  Settled history therefore does not consume maximum rent forever solely because
  it is read.
- Reads do not silently charge rent by extending a job. A caller that wants an
  archival record kept hot invokes `keep_alive`.

TTL is measured in ledgers, while job expiry is measured in ledger timestamp
seconds. Converting a timestamp interval to a ledger count would depend on an
unstable close-time estimate, so the contract does not pretend that a maximum
TTL guarantees availability until an arbitrary far-future timestamp. Explicit
extension and restoration are required parts of the design.

## What archival means after Protocol 23

The SOW describes an archived funded job as potentially stranded. That was a
valid design risk, but archival is not irreversible for persistent or instance
storage.

Starting in Protocol 23, an ordinary Soroban invocation can automatically
restore archived persistent, instance, and required code entries before the
contract runs when those keys are present in the transaction restore list.
Stellar RPC simulation normally discovers the archived keys and places them in
that list. Restoration and renewed rent consume resources and fees.

Therefore:

- An archived funded job is unavailable until restored, not destroyed.
- Protocol 23+ simulation can identify the archived job, instance, and code
  required by `claim_refund`. A successful ordinary simulation may carry them
  in the invocation envelope; the relay pins their exact keys.
- A manually assembled or stale transaction that omits restoration data can
  fail before contract execution.
- A keeper improves hot-state availability and cost predictability but is not a
  trusted liveness dependency.

Every SDK submission path must simulate immediately before signing/submitting
the final envelope. The generated client's separate `restoreFootprint` fallback
is disabled by default; `restore: false` does not remove Protocol 23
same-envelope archived entries. The relay does not carry a separate
restore-preamble request through authorization: if enforcing simulation
requests that operation, it fails closed and authorization must be restarted
after restoration.

Protocol 23 same-envelope restoration is a separate case. When a successful
invoke simulation already contains archived-entry indices, `prepareRelay`
resolves them to exact read-write ledger keys and pins them together with the
entire read-only/read-write footprint in `RelayIntent`. Every later client and
facilitator validation rejects a changed footprint or archived-key set.
Direct prepared-transaction callers that do not use the relay must inspect and
policy-check the final envelope themselves.

The first recording simulation and its RPC select the footprint that becomes
the relay policy, so they are a trust boundary. High-value callers should
derive expected ledger keys independently or compare trusted RPCs. Enforcing
simulation may adjust instruction/byte/fee estimates without changing the
pinned key sets; the final total transaction fee is still bounded by
`RelayIntent.maxFee`.

The explicit opt-in policy accepts only an independently derived, exact list of
ledger-key XDR values, a ceiling for the complete transaction fee, a bounded
transaction lifetime, the expected network passphrase, and the expected
facilitator signer. `createGuardedRestoreSigner` then verifies that the wallet
request contains exactly one source-less `restoreFootprint` operation, no memo
or unsupported preconditions, no read-only footprint keys, precisely the
allowlisted read-write keys, consistent Soroban fee data, and no pre-existing
signature. It also verifies that the wallet did not mutate the transaction and
added exactly one valid facilitator signature. Never derive the allowlist from
the same untrusted RPC response that requested restoration.

See Stellar's
[state archival documentation](https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival)
and
[production storage strategies](https://developers.stellar.org/docs/build/guides/storage/storage-strategies).

## Failure and recovery procedure

If simulation reports restoration:

1. Stop the current relay attempt; do not ask a raw `signTransaction` callback
   to approve the RPC-produced envelope.
2. Independently derive the expected kernel instance, kernel code, and
   requested persistent job/admission ledger keys.
3. Supply those exact keys plus the fee/lifetime/network/signer policy to the
   SDK's guarded restoration path.
4. Wait for the separate restoration transaction to succeed and independently
   read the restored state.
5. Rebuild the requested invocation and restart recording-mode authorization;
   prior simulation resources and authorization requirements are stale.
6. Run enforcing-mode simulation again, submit, then re-read the job and token
   balances. Any same-envelope archived-entry keys in the successful invocation
   remain bound by `RelayIntent.footprint`.

Stellar SDK 16.2 implements this opt-in recovery with a separate
`RestoreFootprintOp`. It is never enabled implicitly, and a successful restore
does not authorize or submit the requested refund.

## Required tests

- New jobs and instance/code are extended to the intended threshold.
- Mutations above the half-maximum threshold do not perform a redundant bump.
- Mutations below the threshold extend the job and instance/code.
- Terminal transitions stop automatic job extension.
- `keep_alive` works for nonterminal and terminal jobs.
- The native host advances a funded job past its storage TTL and demonstrates
  restoration followed by refund. The public testnet gate executes the
  optimized Wasm lifecycle but does not claim to force long-lived state into
  archival during the release run.
- After ledger time reaches expiry, the restored job refunds exactly once.
- The default SDK path keeps the separate restore-footprint fallback disabled.
- Guarded restoration rejects extra/missing keys, read-only keys, extra
  operations, operation sources, memos, unsupported preconditions, wrong
  network/source, stale or excessive time bounds, excessive/inconsistent fees,
  pre-signed envelopes, wallet body mutation, and wrong/extra signatures.
- Live evidence records fee/resource data for every demonstrated transaction;
  it does not label a transaction as archival restoration unless one actually
  occurred.

Production resource limits remain enabled for the conformance test. Any
unmetered diagnostic run must be labeled separately and cannot be used as
completion evidence.
