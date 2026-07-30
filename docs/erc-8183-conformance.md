# ERC-8183 conformance

## Normative source and precedence

This implementation targets the ERC-8183 draft at the immutable commit
[`ethereum/ERCs@a078cab5cc8e9581c15f76c091ed96eed28f02f7`](https://github.com/ethereum/ERCs/blob/a078cab5cc8e9581c15f76c091ed96eed28f02f7/ERCS/erc-8183.md).
The commit, rather than the moving draft, is the conformance baseline for
version 0.1.0.

Conformance is resolved in this order:

1. RFC 2119/8174 requirements in the pinned ERC's normative prose.
2. The explicit Soroban adaptations in this document and
   [protocol.md](protocol.md).
3. The pinned ERC's rationale and examples as non-normative guidance.
4. The embedded Solidity reference implementation as non-normative sample
   code.

This ordering matters. The sample contract conflicts with the specification in
ways that would weaken escrow safety if copied.

## Normative lifecycle mapping

| ERC requirement                                                                                    | Soroban behavior                                                                                                        | Status                                                      |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Six states: Open, Funded, Submitted, Completed, Rejected, Expired                                  | The same six states and no additional lifecycle state                                                                   | Conformant                                                  |
| Client creates a job with a future expiry and nonzero evaluator                                    | `create_job` validates both and records the authorizing client                                                          | Conformant                                                  |
| Provider may be absent at creation and set once later by the client                                | `Option<Address>` represents absence; `set_provider` is client-authorized and Open-only                                 | Conformant                                                  |
| Client or provider may negotiate the budget while Open                                             | `set_budget` accepts an explicit actor, verifies it is the client or provider, then requires that actor's authorization | Conformant                                                  |
| Funding requires a provider, nonzero budget, client authorization, and exact expected-budget match | `fund` enforces all four conditions and transfers the deployment's SEP-41 token into escrow                             | Conformant                                                  |
| Only the provider submits from Funded                                                              | `submit` enforces provider authorization and Funded state                                                               | Conformant                                                  |
| Only the evaluator completes from Submitted                                                        | `complete` enforces evaluator authorization and atomically pays the provider                                            | Conformant                                                  |
| Client rejects from Open; evaluator rejects from Funded or Submitted                               | `reject` derives the required authorizer from current state and refunds funded escrow atomically                        | Conformant                                                  |
| Refund is available at or after expiry from Funded or Submitted                                    | `claim_refund` is permissionless, non-hookable, sets Expired, and atomically refunds the client                         | Conformant, using the ERC's recommended permissionless form |
| One payment token per contract is sufficient                                                       | The constructor fixes one immutable SEP-41 token per deployment                                                         | Conformant                                                  |
| Platform fees are optional                                                                         | No platform or evaluator fee is implemented                                                                             | Conformant                                                  |
| Hooks wrap setProvider, setBudget, fund, submit, complete, and reject, but never claimRefund       | The same action set is dispatched; `create_job` is also deliberately not hookable                                       | Conformant                                                  |
| Before-hook failure blocks an action; after-hook failure rolls the action back                     | Contract calls are atomic and both callback failures abort the complete invocation                                      | Conformant                                                  |
| Events expose the lifecycle and value movement                                                     | Structured Soroban contract events cover the recommended ERC event set                                                  | Conformant                                                  |

The contract does not impose a “refund always wins” rule after expiry. At or
after the boundary, `claim_refund` is eligible, while another transition that is
otherwise valid remains eligible. The first successful transaction applied to
the ledger wins and makes later transitions invalid. This preserves the pinned
ERC's ordering semantics. The reference SLA hook can impose an earlier submit
cutoff for jobs that opt into it.

## Soroban adaptations and deliberate restrictions

These changes preserve the protocol's intent while making invalid states and
resource abuse harder to express:

- EVM zero addresses become `Option<Address>` where absence is meaningful.
  Evaluator, admin, token, and a newly assigned provider are concrete Soroban
  addresses.
- `uint256` job identifiers become checked `u64` identifiers. Exhaustion fails;
  identifiers never wrap or overwrite a prior job.
- SEP-41 amounts are signed `i128`, so every budget-setting and funding path
  rejects values less than or equal to zero.
- `bytes32` commitments become `BytesN<32>`.
- Descriptions must be valid UTF-8 and contain 1 through 512 encoded bytes.
  Hook options are opaque to the kernel but capped at 1,024 bytes.
- Funding at or after the expiry timestamp is rejected. Expiry cannot be used
  to create newly funded escrow.
- Hook addresses must be admitted by the current administrator when a job is
  created. Removal prevents new use but does not rewrite or disable hooks on
  existing jobs.
- The kernel and SLA hook have no upgrade entrypoint. The only administration
  is two-step admin rotation and hook admission.
- A stable not-found error is returned instead of a zero-valued job.
- Persistent storage and restoration are part of the protocol's liveness
  design; see [storage-and-ttl.md](storage-and-ttl.md).

These restrictions are part of this implementation's public interface. They
must not be relaxed in a patch release without re-running the complete
conformance and security suite.

## Conflicts in the pinned Solidity sample

The following are discrepancies in the sample embedded in the same pinned ERC.
They are not ambiguities in this port:

| Topic                    | Normative prose                                                               | Embedded sample                                                            | Resolution here                                              |
| ------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Budget authorizer        | Client or provider may call `setBudget`                                       | Checks only `msg.sender == provider`                                       | Authorize either recorded role                               |
| Positive funding         | `fund` must reject a zero budget                                              | Transfers only when budget is positive, but otherwise marks the job Funded | Reject non-positive budgets                                  |
| Front-running protection | `fund(jobId, expectedBudget)` must compare the expectation with stored budget | Sample omits `expectedBudget` entirely                                     | Require exact expectation                                    |
| Submit source state      | Only Funded may move to Submitted                                             | Sample also accepts Open when budget is zero                               | Permit Funded only                                           |
| `setProvider` hooks      | Listed as hookable with opaque options                                        | Sample has no options or callback                                          | Dispatch both callbacks                                      |
| Job creation hooks       | Hookable-function table omits `createJob`                                     | Sample calls an after-hook from `createJob`                                | Never hook creation                                          |
| Hook payload             | Table defines function arguments plus opaque options                          | Sample prefixes several payloads with `msg.sender`                         | Use typed Soroban context defined by this port               |
| Expiry validation        | Creation requires a timestamp in the future                                   | Sample imposes an undocumented extra five-minute minimum                   | Require strictly future expiry; SLA policy belongs in a hook |
| Evaluator fee            | Only an optional platform fee is specified                                    | Sample also deducts an evaluator fee                                       | No fees                                                      |

For review, the relevant sample begins near
[`setBudget`](https://github.com/ethereum/ERCs/blob/a078cab5cc8e9581c15f76c091ed96eed28f02f7/ERCS/erc-8183.md?plain=1#L575)
and continues through
[`claimRefund`](https://github.com/ethereum/ERCs/blob/a078cab5cc8e9581c15f76c091ed96eed28f02f7/ERCS/erc-8183.md?plain=1#L690).

## Out of scope for conformance

Version 0.1.0 does not provide fees, arbitration, dispute resolution, reputation,
identity, threshold evaluation, per-job tokens, pausing, asset sweeping, contract
upgrades, cross-chain jobs, or a mainnet deployment. None is required by the
pinned base protocol.
