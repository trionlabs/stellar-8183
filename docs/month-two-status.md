# Month-two implementation status

This is a follow-on implementation and technical validation report. The Mainnet
compatibility canary and coordinator-approved independent-pilot proxy
transactions are complete. Direct customer interviews, observed onboarding, and
the adoption decision remain pending. The historical v0.1 release and immutable
contract profile are unchanged.

The [hosted Console](https://trionlabs.github.io/stellar-8183/) is available for
review. Its [build metadata](https://trionlabs.github.io/stellar-8183/build.json)
records the exact published application source. CI checks on the pull request
refer to their own commit; inspect the hashes when comparing older run results.

## Delivered

- Standalone wallet-based Console in `apps/console`, pinned to the verified
  Testnet deployment by default, with all escrow actions, review before signing,
  bounded fees, local file hashing, and portable receipts. Mainnet requires an
  explicitly reviewed canary profile; no local job or balance substitute exists.
- Optional direct-contract Stellar 8004 lookup using `get_agent_wallet(u32)`.
  The canonical identity registry is selected by network by default and may be
  explicitly overridden. The wallet is rechecked before funding; settlement
  does not read the registry. A provider address can be supplied directly. No
  external project is modified.
- Public job pointers and advisory bindings survive browser reloads. This is
  local history, not a complete wallet index. Receipts can be checked separately.
- Fresh DEMO8183 testnet deployment of the existing kernel and SLA hook, with
  fetched Wasm matching two clean, byte-identical builds.
- Multiple author-run on-chain jobs cover all terminal paths. The canonical
  Testnet bundle contains jobs 7-12, while the current source-bound browser demo
  contains jobs 31-33 in `deployments/month-two/testnet-demo-evidence.json`.
- A separate mainnet-canary evidence format and read-only verifier, including
  build versions, contract hashes, deployment references, exact-budget transfers,
  and arithmetic over captured balance observations.
- A mainnet-canary threat-model update in `docs/mainnet-canary-threat-model.md`,
  with explicit prerequisites and failure handling.
- A terminal-only Mainnet canary runner with named local CLI signing,
  deterministic planning, deployment recovery, three lifecycle paths, and
  public evidence assembly in `scripts/mainnet-canary-wizard.sh`.
- A verified Mainnet canary using the valueless `DEMO8183` asset, with public
  contract IDs, reproducible Wasm hashes, decoded transactions, portable
  receipts, and completion, rejection, and expired-refund evidence in
  `docs/mainnet-canary-evidence.md`.
- Pseudonymous independent-pilot transaction evidence for jobs 34-39, using a
  fresh disposable Testnet wallet and the coordinator-approved proxy execution
  exception. The evidence explicitly records that the participant did not
  personally sign and publishes no participant name or secret.
- Browser lifecycle tests, wallet/security regression tests, static build and
  browser tests in CI, and a fail-closed, repeatable GitHub Pages publisher.

## Verification

The current checks cover 29 Rust tests, 180 JavaScript/TypeScript and evidence tests,
and six browser tests. An additional opt-in author-run browser suite executes
three real Testnet jobs and injects RPC recovery failures. The latest
source-bound run used commit `963c4c551139ce90a671ee46e94b7586749ff2ca`
and produced live-read-verified jobs 31-33. Formatting, Clippy, type checks, SDK packaging,
generated bindings, reproducible Wasm builds, and secret scans are included.
Live evidence was re-fetched from Stellar RPC; the Testnet demo, Mainnet canary,
and grant evidence index are linked from `deployments/month-two/`.

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
authenticated by ledger proofs. Customer validation remains pending. The
Mainnet canary is verified but is not a production deployment or audit.

## Required external work

1. Complete the customer-development portion of `docs/month-two-pilot.md`. The
   coordinator-approved proxy transaction paths are published, but interviews,
   observed onboarding metrics, blocker findings, and a continue/change/stop
   decision have not been invented and remain pending.
2. Supply the actual submission/start dates and send the final SOW/CDP through
   the agreed coordinator process. Nothing has been messaged or submitted to
   Irem or the grant team by this implementation.

## Run and review

```sh
corepack pnpm@11.9.0 install --frozen-lockfile
corepack pnpm@11.9.0 console:dev
corepack pnpm@11.9.0 check
corepack pnpm@11.9.0 console:e2e
```

The app starts on the bundled verified Testnet profile. Creating or changing a
job needs Freighter on Testnet, XLM for fees, a DEMO8183 trustline, and test
tokens. Public jobs and receipts remain readable without a wallet. See the Console
README and pilot runbook for participant setup and evidence commands.
