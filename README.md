# Soroban Agentic Commerce

[![CI](https://github.com/trionlabs/stellar-8183/actions/workflows/ci.yml/badge.svg)](https://github.com/trionlabs/stellar-8183/actions/workflows/ci.yml)

An immutable Soroban job-escrow kernel based on
[ERC-8183 Agentic Commerce](https://github.com/ethereum/ERCs/blob/a078cab5cc8e9581c15f76c091ed96eed28f02f7/ERCS/erc-8183.md),
with allowlisted policy hooks and a relayed-auth TypeScript SDK.

This project is testnet-only and unaudited. Do not use it with mainnet funds.
An official release deployment is valid only when its contract IDs, fetched
Wasm hashes, transactions, and source commit appear in a schema-valid evidence
manifest whose status is `verified`. A `deployment` manifest proves the on-chain
run but is still pending publication/provenance gates. The absence of
`deployments/testnet.json` means there is no endorsed deployment yet.

The tag workflow publishes the reviewed provisional manifest as
`evidence.deployment.json` together with its hash-bound, whitelist-only
`evidence.raw.json`. After the demo recording has been attached manually, a
separate workflow-dispatch gate reruns semantic validation and re-downloads and
verifies the release Wasm, GitHub attestations, npm tarball/provenance, and
recording before `scripts/promote-evidence.mjs` can add
`evidence.verified.json`. The provisional assets remain for audit history; only
the verified asset is final release evidence. Each manifest is hashed only
after serialization and has a detached `.sha256` release asset; a manifest
never embeds its own impossible self-hash.
To avoid a commit self-reference, `release.source_commit` names the clean
source/build/deployment commit. `v0.1.0` names its evidence-only child commit,
whose diff is exactly `deployments/testnet.json` and
`deployments/testnet.raw.json`; the release workflow enforces that relationship
before building or publishing.

## What it provides

- The complete six-state ERC-8183 lifecycle:
  Open → Funded → Submitted → Completed/Rejected/Expired.
- One immutable SEP-41 payment token per kernel deployment.
- Client/provider budget negotiation and exact-budget funding protection.
- Full payment on completion, full refund on rejection/expiry, and no protocol
  fees.
- Permissionless `claim_refund`, deliberately outside the hook system.
- Before/after callbacks for the other six mutations, with admin admission and
  atomic rollback.
- An immutable SLA hook that preserves an evaluator review window.
- Persistent per-job storage with threshold TTL extension, pinned Protocol 23
  same-envelope restoration keys, and an exact-key guarded separate
  restore-footprint fallback.
- `@trionlabs/stellar-8183`, covering the full ABI, commitments, token units,
  secret-whitelisted raw evidence capture, and strict multi-party relay
  validation.

The normative target is the draft at
`ethereum/ERCs@a078cab5cc8e9581c15f76c091ed96eed28f02f7`. Its embedded Solidity
sample conflicts with its own specification; this project follows the normative
prose. The reviewed discrepancies are recorded in
[ERC-8183 conformance](docs/erc-8183-conformance.md).

## Lifecycle

```text
Open ── fund ──────────────> Funded ── submit ──> Submitted ── complete ──> Completed
  │                            │                       │
  └─ client reject ─> Rejected├─ evaluator reject ───┴───────────────────> Rejected
                               └─ expired refund ──────┴───────────────────> Expired
```

The evaluator is a designated trusted address, not an arbitration system. At or
after expiry, a still-valid provider/evaluator action and a refund can race; the
first successful ledger transaction wins. Jobs that require an evaluation
buffer can opt into the SLA hook.

## Build and test

Pinned development tools are Rust 1.96.0, `wasm32v1-none`, Soroban SDK 27.0.3,
Stellar CLI 27.0.0, Node 22, pnpm 11.9.0, and Stellar SDK 16.2.0.

```sh
corepack enable
pnpm install --frozen-lockfile
make check
make build
./scripts/verify-release.sh
```

Deployable optimized Wasm is built through Stellar CLI:

```sh
./scripts/release-build.sh
```

The release artifacts are
`artifacts/release/stellar_8183_commerce.wasm` and
`artifacts/release/stellar_8183_sla_hook.wasm`. The release build embeds
`source_repo=github:trionlabs/stellar-8183`; publish that repository before
treating its SEP-55 provenance as meaningful.

See [testing.md](docs/testing.md) for the adversarial matrix and
[CONTRIBUTING.md](CONTRIBUTING.md) for change requirements.

## TypeScript SDK

After publication:

```sh
npm install @trionlabs/stellar-8183
```

Connect to the deployed kernel without giving the SDK a secret:

```ts
import { AgenticCommerce } from "@trionlabs/stellar-8183";

const commerce = await AgenticCommerce.connect({
  contractId,
  networkPassphrase,
  publicKey: facilitatorAddress,
  rpcUrl,
});
```

Mutation methods prepare and simulate an invocation; they do not silently sign
or submit it. `prepareRelay`, `authorizeRelay`, and `facilitateRelay` implement
the intended flow:

1. discover role authorization with recording-mode simulation;
2. sign the exact auth entry as client, provider, or evaluator;
3. validate it with enforcing-mode simulation;
4. strictly validate and rebuild the envelope with a distinct facilitator;
5. freshly simulate, sign as transaction source, submit, and wait for success.

The SDK takes SEP-43-compatible signer callbacks and does not accept or store
secret keys. See the [package guide](packages/sdk/README.md) for code and the
[EVM/Soroban mapping](docs/erc-8183-stellar-mapping.md) for the authorization
model.

## Stellar facts that affect integration

- Stellar ledgers currently close roughly every five seconds. That is not
  sub-second finality; always wait for a successful transaction result.
- A facilitator can pay transaction fees in XLM while another address
  authorizes the contract invocation.
- Fee sponsorship does not erase G-account reserve requirements. A normal
  client/provider G-account still needs an account reserve, and a classic asset
  trustline adds reserve. Sponsored reserves or C-account wallets are separate
  integration choices.
- Persistent and instance storage can archive. Since Protocol 23, fresh
  simulation can include archived entries in the same invocation envelope; the
  relay pins those exact keys. Stellar SDK's separate `restoreFootprint`
  fallback is disabled unless an independently derived exact-ledger-key,
  bounded-fee policy is supplied. Manually assembled stale transactions may
  fail.
- Successful events are transaction metadata, not permanent contract storage,
  and RPC event retention can be short. Capture evidence promptly.

The testnet release uses official test USDC:

| Property        | Value                                                      |
| --------------- | ---------------------------------------------------------- |
| Issuer          | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| SEP-41 contract | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| Decimals        | 7                                                          |

These are public testnet constants, not a live kernel deployment.

## Repository map

| Path                   | Purpose                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| `contracts/interfaces` | Shared jobs, hook context, errors, events, and callback client                   |
| `contracts/commerce`   | Immutable escrow kernel                                                          |
| `contracts/sla-hook`   | Reference review-window hook                                                     |
| `contracts/test-hooks` | Adversarial fixtures; not release policy contracts                               |
| `packages/sdk`         | TypeScript client and relay safety layer                                         |
| `docs`                 | Protocol, conformance, security, TTL, testing, and public evidence specification |

## Documentation

- [Exact contract ABI and events](docs/protocol.md)
- [ERC-8183 conformance and sample discrepancies](docs/erc-8183-conformance.md)
- [ERC/EVM to Stellar/Soroban mapping](docs/erc-8183-stellar-mapping.md)
- [Storage, TTL, archival, and restoration](docs/storage-and-ttl.md)
- [Security and threat model](docs/security.md)
- [Test and acceptance matrix](docs/testing.md)
- [Testnet/release runbook](docs/testnet-runbook.md)
- [Evidence JSON Schema](docs/evidence.schema.json) and
  [unfilled shape template](docs/evidence.template.json)
- [Assembler input template](docs/evidence-input.template.json)
- [Original statement of work](MAIN.md)

## Explicit non-goals

Version 0.1.0 does not include mainnet deployment, a security audit, disputes or
arbitration, threshold evaluators, identity/reputation, fees, pausing, token
sweeping, contract upgrades, per-job token selection, cross-chain jobs, or a
front-end.

## License

[MIT](LICENSE)
