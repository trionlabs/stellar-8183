# Storage, TTL, archival, and restoration

Escrow liveness depends on treating TTL as an ordinary state lifecycle, not an
exception. A Unix expiry timestamp does not keep a Soroban ledger entry live.

## Week 1 storage layout

| Data                       | Storage class         | Keying                              | Reason                                                                                |
| -------------------------- | --------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| Admin, token, next job ID  | Instance              | Fixed keys in the contract instance | Small deployment-wide configuration loaded on every invocation                        |
| Job                        | Persistent            | One `Job(id)` entry per job         | Escrow state must be recoverable and jobs must not create an unbounded instance entry |
| Escrow funds               | SEP-41 token contract | Kernel contract address             | Value is held by the token contract, not serialized into kernel storage               |

Temporary storage is never used for jobs or configuration. Temporary entries
are permanently deleted when their TTL reaches zero and cannot safely represent
escrow liabilities.

## Extension policy

The implementation derives the current network maximum through
`env.storage().max_ttl()`; it does not hard-code a number of days.

- `create_job` extends the new persistent job entry and the kernel instance/code
  to the network maximum.
- A successful mutation checks the remaining TTL. When it is below half the
  current maximum, the job is extended to the maximum.
- Instance extension uses the same half-maximum threshold and extends both the
  contract instance and its Wasm code.
- `keep_alive(id)` is permissionless and force-extends the named job plus
  instance/code.
- Reads do not silently charge rent by extending a job. A caller that wants an
  archival record kept hot invokes `keep_alive`.

TTL is measured in ledgers, while job expiry is measured in ledger timestamp
seconds. Converting a timestamp interval to a ledger count would depend on an
unstable close-time estimate, so the contract does not pretend that a maximum
TTL guarantees availability until an arbitrary far-future timestamp. Explicit
extension and restoration are required parts of the design.

## What archival means after Protocol 23

Persistent or instance storage that reaches zero TTL is archived rather than
destroyed. Starting in Protocol 23, an ordinary Soroban invocation can restore
archived persistent, instance, and required code entries before contract
execution when those keys are included in the transaction restore list.
Stellar RPC simulation normally discovers the required keys. Restoration and
renewed rent consume resources and fees.

Therefore:

- An archived funded job is unavailable until restored, not destroyed.
- A manually assembled or stale transaction that omits restoration data can
  fail before contract execution.
- Every client submission path must simulate immediately before signing and
  submitting the final envelope.
- A keeper improves hot-state availability and cost predictability but is not a
  trusted liveness dependency.

See Stellar's
[state archival documentation](https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival)
and
[production storage strategies](https://developers.stellar.org/docs/build/guides/storage/storage-strategies).

## Required verification

- New jobs and instance/code are extended to the intended threshold.
- Mutations above the half-maximum threshold do not perform a redundant bump.
- Mutations below the threshold extend the job and instance/code.
- `keep_alive` force-extends a known job and rejects an unknown job.
- A later terminal-path milestone must demonstrate that an archived funded job
  can be restored and refunded exactly once after expiry.
- Production resource limits remain enabled for conformance tests.
