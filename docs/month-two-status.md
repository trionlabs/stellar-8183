# Month-two implementation status

This is a testnet implementation and technical validation report. It is not a
claim that the follow-on grant, customer discovery, or mainnet milestone is
complete. The historical v0.1 release and immutable contracts are unchanged.

The [hosted Console](https://trionlabs.github.io/stellar-8183/) is available for
review. Its [build metadata](https://trionlabs.github.io/stellar-8183/build.json)
records the exact published application source. CI checks on the pull request
refer to their own commit; inspect the hashes when comparing older run results.

## Delivered

- Standalone wallet-based Console in `apps/console`, with an offline rehearsal,
  live network profiles, all escrow actions, review before signing, bounded fees,
  local file hashing, and portable receipts.
- Optional direct-contract Stellar 8004 lookup using `get_agent_wallet(u32)`.
  The wallet is rechecked before funding; settlement does not read the registry.
  A provider address can be supplied directly. No external project is modified.
- Public job pointers and advisory bindings survive browser reloads. This is
  local history, not a complete wallet index. Receipts can be checked separately.
- Fresh DEMO8183 testnet deployment of the existing kernel and SLA hook, with
  fetched Wasm matching two clean, byte-identical builds.
- Twelve author-run on-chain jobs across two runs. The published evidence uses
  the final six: two completions, two funded rejections, two expired refunds.
- A separate mainnet-canary evidence format and read-only verifier, including
  build versions, contract hashes, deployment references, exact-budget transfers,
  and arithmetic over captured balance observations.
- A mainnet-canary threat-model update in `docs/mainnet-canary-threat-model.md`,
  with explicit prerequisites and failure handling; no approval is inferred.
- Browser lifecycle tests, wallet/security regression tests, static build and
  browser tests in CI, and a first-publication GitHub Pages script.

## Verification

The final local checks cover 29 Rust tests, 123 JavaScript/TypeScript tests,
and six browser tests, including the hosted GitHub Pages application. Formatting,
Clippy, type checks, SDK packaging, generated
bindings, reproducible Wasm builds, and secret scans are included. Live evidence
was re-fetched from Stellar RPC; the bundle is in `deployments/month-two/`.

The full npm audit now reports zero findings after pinning the installable
`smol-toml` 1.9.1 patch. A local HTTP integration test covers the SDK's real
TOML resolver with both valid metadata and invalid input. Rust, npm, and secret
scans run independently, and the combined security gate requires all three.

The raw Cargo audit also reports RUSTSEC-2026-0387 in the pinned SDK's native
Soroban test host. It is absent from the production Wasm dependency graph. CI
has one explicit, guarded host-only exception; the underlying dependency has not
been upgraded or described as fixed. See `docs/dependency-audit.md` for the
evidence and revocation conditions. The upstream `paste` maintenance notice also
remains informational.

## Review findings

### Standards

Four findings were corrected: funding terms changing after review; receipt token
not bound to the immutable kernel; stale provider bindings during receipt export;
and deployment provenance not bound to clean, pinned build inputs. Regression
tests cover the fixes, including ignored/untracked Cargo build inputs.

### Spec

Funding review, identity persistence, and toolchain/balance evidence gaps were
corrected. Balance snapshots remain captured observations; arithmetic and
referenced transfers are verified, but absolute historical balances are not
authenticated by ledger proofs. Customer validation and mainnet remain pending.

## Required external work

1. Conduct the independent pilot using `docs/month-two-pilot.md`. No participant
   confirmation, interview, consent, independent signature, usability metric, or
   adoption decision has been invented. Author-run jobs do not count toward it.
2. Resolve the audit requirement in the repository's security policy and obtain
   the Chapter Lead's acceptance of the valueless-mainnet-canary boundary before
   deployment. No mainnet signer has been provisioned or funded in this work.
3. Once permitted, deploy the same pinned Wasm with a dedicated non-redeemable
   asset, capture mainnet-specific evidence, and verify it with `verify:canary`.
   The testnet snapshot must not be relabeled as mainnet evidence.
4. Supply the actual submission/start dates and send the final SOW/CDP through
   the agreed coordinator process. Nothing has been messaged or submitted to
   Irem or the grant team by this implementation.

## Run and review

```sh
corepack pnpm@11.9.0 install --frozen-lockfile
corepack pnpm@11.9.0 console:dev
corepack pnpm@11.9.0 check
corepack pnpm@11.9.0 console:e2e
```

The app starts in a clearly labeled local rehearsal. Use Network settings to
load the bundled verified testnet profile. Live operation needs Freighter on
testnet, XLM for fees, a DEMO8183 trustline, and demo tokens. See the Console
README and pilot runbook for participant setup and evidence commands.
