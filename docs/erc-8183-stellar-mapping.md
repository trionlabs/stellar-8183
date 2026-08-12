# ERC-8183 to Soroban mapping

This document explains semantic mappings. It is not a claim that EVM and
Soroban execution are mechanically interchangeable.

| ERC/EVM concept                        | Stellar/Soroban equivalent                                                                   | Consequence                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `msg.sender` / ERC-2771 `_msgSender()` | Explicit role address plus `Address::require_auth()`                                         | The contract verifies authorization for the economic actor, not the transaction submitter                            |
| Trusted forwarder                      | Native signed Soroban authorization entries                                                  | No trusted-forwarder address or appended calldata is needed                                                          |
| Gas payer is caller                    | A separate G-account transaction source pays inclusion and resource fees                     | Client, provider, and evaluator can authorize an invocation without being the source account                         |
| ERC-20 deployment address              | SEP-41 token contract address                                                                | Constructor receives a token contract, not a classic asset issuer address                                            |
| `approve` + `transferFrom`             | Nested SEP-41 `transfer(from, to, amount)` with `from` authorization                         | Funding needs no persistent allowance; the signed invocation tree covers the transfer                                |
| `uint256` token amount                 | SEP-41 `i128` amount                                                                         | Negative and zero values must be rejected explicitly; SDKs must use integer base units                               |
| ERC-20 decimals                        | SEP-41 `decimals()`                                                                          | Never assume decimals for arbitrary deployments; official testnet USDC currently uses seven                          |
| `address(0)` optional role/hook        | `Option<Address>`                                                                            | Absence is typed rather than represented by an invalid address                                                       |
| `bytes32`                              | `BytesN<32>`                                                                                 | Deliverable and decision commitments stay fixed-width                                                                |
| `bytes calldata`                       | `Bytes`                                                                                      | Hook options remain opaque but are bounded to control resource use                                                   |
| Solidity mapping                       | Persistent storage under a typed per-job key                                                 | Each job has an independent TTL and ledger footprint                                                                 |
| Constructor/immutable variables        | Soroban constructor plus instance storage, with no Wasm-update entrypoint                    | Token choice is fixed for the lifetime of a deployment                                                               |
| `block.timestamp`                      | `Env::ledger().timestamp()`                                                                  | Expiry uses the monotonically increasing ledger close time, not local wall-clock time                                |
| Revert/custom error                    | Stable contract error                                                                        | A failed invocation rolls back contract state, nested token movement, and hook effects atomically                    |
| Solidity events                        | Soroban contract events                                                                      | Successful events are in transaction metadata; capture them promptly because RPC event retention is limited          |
| Reentrancy guard                       | Soroban host call-frame protections plus explicit state/value ordering and adversarial tests | Ordinary contract re-entry is prohibited, but malicious cross-contract behavior and rollback still require testing   |
| Per-call gas stipend for a hook        | Transaction-level Soroban resource limits                                                    | There is no EVM-style hook gas parameter; admission, payload bounds, simulation, and network limits bound execution  |
| “Storage forever”                      | Persistent/instance TTL, archival, and restoration                                           | State can archive but is recoverable; clients must simulate to populate restoration data                             |
| Probabilistic confirmations            | SCP externalizes a ledger                                                                    | A successful transaction is normally observed on a ledger close, currently roughly every five seconds—not sub-second |

## Relayed authorization

A relayed action has two distinct signatures:

1. The role signs the Soroban authorization entry for the exact invocation tree.
2. The facilitator signs the transaction envelope as its G-account source,
   consumes its own sequence number, and pays XLM-denominated fees.

The initial recording-mode simulation discovers required authorization entries.
After those entries are signed, the client and facilitator must each perform a
fresh enforcing-mode simulation. The enforcing simulation validates signatures,
executes custom account authorization, and includes accurate resources. The
relay pins the complete footprint and any Protocol 23 same-envelope archived
read-write keys in the trusted intent. If simulation instead requests a
separate restore-preamble transaction, the relay fails closed: restore first
through the SDK's independently derived exact-key and bounded-fee policy, then
restart authorization from a fresh recording simulation.

For `fund`, the client's authorization tree includes the kernel call and the
nested SEP-41 transfer from the client into the kernel. Changing the contract,
function, arguments, network, or invocation tree invalidates the authorization.
The SDK must not reduce this to an unconstrained “fund any job” signature.

The facilitator treats incoming XDR as hostile. Before rebuilding and signing,
it validates the network passphrase, one-operation envelope shape, exact target
contract/function/arguments, time bounds, fee ceiling, complete set of expected
authorizers, absence of unexpected authorizers, and absence of any authorization
by or operation source equal to the facilitator.

See Stellar's official
[auth-entry signing guide](https://developers.stellar.org/docs/build/guides/transactions/signing-soroban-invocations)
for the recording/enforcing distinction.

## Token and account caveats

The facilitator paying transaction fees does not imply that every G-account can
hold USDC with zero XLM:

- A normal G-account must exist and satisfy its minimum reserve.
- A classic USDC trustline is a subentry and raises that reserve.
- The client needs a USDC trustline and balance; a G-account provider needs a
  trustline before receiving USDC.
- Sponsored reserves can shift the reserve burden, and C-account wallets can
  authorize contract calls differently, but neither is part of the version
  0.1.0 testnet demonstration.

The official
[minimum-balance documentation](https://developers.stellar.org/docs/learn/fundamentals/lumens)
currently describes a 0.5 XLM base reserve, but this is a network setting and
must be queried or rechecked for each deployment.

## Stellar-specific optimizations

- Store each job under its own persistent key rather than an unbounded instance
  map. A transaction loads only the job it touches.
- Keep only small deployment configuration in instance storage.
- Use direct SEP-41 transfer authorization instead of an allowance write plus a
  later spend.
- Bump TTL only below a threshold; repeated maximum extensions waste rent.
- Stop automatic job TTL bumps after settlement while retaining explicit
  `keep_alive` and restoration.
- Pass a complete typed hook context so a hook does not callback-read kernel
  storage.
- Bound user-controlled strings and bytes before storage or cross-contract
  dispatch.
- Re-simulate immediately before submission rather than guessing footprints,
  resources, fees, or restoration entries.

## Source references

- [SEP-41 token interface](https://developers.stellar.org/docs/tokens/token-interface)
- [Soroban authorization](https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization)
- [Signing Soroban contract invocations](https://developers.stellar.org/docs/build/guides/transactions/signing-soroban-invocations)
- [State archival](https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival)
- [Stellar ledgers](https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/ledgers)
