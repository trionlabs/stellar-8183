# 8183 Agent Commerce Console

A standalone application for clients and providers of asynchronous digital
work. Use the existing escrow kernel to create, price, fund, submit, approve,
reject, or refund a job. No change is made to the v0.1 contract ABI.

[Open the hosted preview](https://trionlabs.github.io/stellar-8183/). It opens
on the verified Stellar Testnet deployment and never substitutes local jobs or
balances for on-chain state.

## Run locally

From the repository root:

```sh
corepack pnpm@11.9.0 install --frozen-lockfile
corepack pnpm@11.9.0 console:dev
```

Open `http://127.0.0.1:4173`. The reviewed Testnet profile is selected by
default. Connect Freighter on Testnet to create or change a job. Public jobs
can be loaded and outcome receipts can be verified without connecting a wallet.

Network settings offers the bundled verified Testnet deployment or a reviewed
Mainnet canary profile import. Raw RPC and contract fields are intentionally
not exposed in the product UI. Every mutation requires wallet approval.
The account needs XLM for transaction fees/reserves and any required token
trustline. This version uses direct source-account signing; it does not host a
facilitator or receive private keys. The existing SDK relay workflow is still
available to other applications.

Descriptions are public on-chain. Deliver files through an agreed channel;
the Console hashes file bytes locally and submits only their SHA-256 digest.
The selected evaluator is trusted to judge quality and may be the client.
At expiry, valid decisions and refunds can race; the first applied transaction
wins. Frozen assets or missing trustlines can also prevent token delivery.

## Test and build

```sh
corepack pnpm@11.9.0 console:test
corepack pnpm@11.9.0 --filter @trionlabs/8183-console exec playwright install chromium
corepack pnpm@11.9.0 console:e2e
corepack pnpm@11.9.0 console:build
```

The static application is in `apps/console/dist/`. Assets use relative URLs so
it can be hosted at a project subpath. Serve it over HTTPS or
localhost. It needs no server-side signing secret. Browser tests use installed
Chrome on macOS and bundled Chromium elsewhere; `PLAYWRIGHT_CHANNEL` overrides
the default. CI runs type checks, unit tests, and browser lifecycle tests.

## Fresh testnet deployment and automated evidence

```sh
./scripts/release-build.sh
corepack pnpm@11.9.0 --filter @trionlabs/8183-console deploy:testnet
corepack pnpm@11.9.0 --filter @trionlabs/8183-console pilot
```

The first command builds the pinned kernel/hook. The deployer creates new
testnet-only identities in ignored `.stellar/month-two`, funds them through
Friendbot, issues valueless DEMO8183, creates trustlines, deploys the unchanged
kernel/SLA hook, admits the hook, fetches Wasm, and compares hashes. Its public
profile and deployment data are in ignored `artifacts/month-two`.

The automated runner executes two completions, two funded rejections, and two
permissionless expired refunds, with one test token per job and the SLA hook.
It verifies the terminal transaction and job and exports canonical receipts.
All automated identities belong to the author. These runs are technical
integration evidence and do not satisfy the independent-participant milestone.

Never use these CLI-generated identities or the testnet runner on mainnet.
Do not publish `.stellar/`, signing traces, or raw key command output.

## Optional Stellar 8004 identity import

Select an Open job, then Import provider from 8004. Supply the network's
Identity Registry and numeric agent ID. The pinned Stellar v0.1 profile calls
`get_agent_wallet(u32)` directly through RPC. An absent wallet or archived
registry fails before funding. The proposed provider is shown before signing.

Recent live job IDs, terminal transaction pointers, and advisory identity
snapshots persist in local browser storage, scoped by network, kernel, and
token. They restore when the deployment and wallet reconnect. Changed provider
addresses invalidate the old snapshot. Deleting browser storage removes those
pointers; retain portable receipts.

Before funding an imported job, the registry is read again and must still
resolve to the on-chain provider. Its network, registry, agent ID, wallet, and
observed ledger are saved as a client snapshot. That snapshot is advisory;
there is a possible change between the preflight read and funding. It is not an atomic
on-chain identity guarantee. Once funded, no settlement action reads 8004.

Use Set provider to explicitly switch to the direct-address path if the
registry is unavailable. Import is optional; no 8004 website, indexer, SDK,
contract, or repository is modified. Arbitrary registration metadata/URIs are
not fetched or rendered.

## Transaction recovery

A confirmed transaction and a successful follow-up job read are separate
results. If the read fails, the Console saves the known job ID and transaction
pointer and offers Load confirmed job. It does not invent a job state or ask
you to repeat the confirmed action.

If signing succeeds but confirmation is unavailable, the public transaction
hash is tracked in a separate network/kernel/token-scoped journal. Check
transaction verifies the envelope and loads its result. `NOT_FOUND` remains
unknown; it is never treated as proof of failure. Pending creation blocks a
duplicate creation from that wallet, and a pending job action blocks further
actions for that job. Unrelated jobs and their refunds remain available.

Stop local tracking requires an explicit acknowledgement and downloads an
unverified public reference. It does not cancel a transaction. Inspect wallet
activity and Stellar Expert before preparing another action; a duplicate job
can result if the first creation actually succeeded. Storage failure leaves
tracking in memory only, with a warning to retain public IDs/hashes.

## Live browser integration (author-run)

The optional suite uses the installed Freighter API's actual window-message
protocol, real RPC, and dedicated author-controlled testnet signers behind a
Node callback. No secret enters the page. It does not exercise the real
Freighter extension approval UI or count as an independent customer session.

After preparing the dedicated testnet deployment and committing the reviewed
application inputs:

```sh
RUN_LIVE_TESTNET=1 corepack pnpm@11.9.0 --filter @trionlabs/8183-console test:live
```

It builds a static preview, then tests rejected approval, changed account,
wrong network, three terminal outcomes, receipt export/verification, reload,
and injected confirmation/read failures without duplicate creation. It checks
client/provider balance deltas and writes a public report under ignored
`artifacts/month-two/browser-live/` with source and application-file hashes.

`CONSOLE_LIVE_URL` selects a hosted preview instead. Hosted checks require its
`build.json` source commit to equal the checked-out commit and every deployed
application file to match the local build before any signing occurs.

## Receipt format and verification

The format is `stellar-8183/outcome/v1`. Decimal integers use strings, all
object keys are lexicographically sorted by the existing SDK's `canonicalJson`,
and `sha256` covers the UTF-8 bytes of the canonical `receipt` object. The
exported envelope is `{receipt, sha256}`. Hashing a URL is never substituted
for hashing the evidence bytes. The checksum is not a digital signature.

Use Verify receipt in the Console or:

```sh
corepack pnpm@11.9.0 --filter @trionlabs/8183-console verify:receipt receipt.json profile.json PUBLIC_G_ACCOUNT
```

Live verification checks the selected network/kernel/token, immutable terminal
job fields, successful transaction ledger/hash, invocation method, and job ID.
It trusts the configured RPC. It does not certify work quality, evaluator
independence, or historic 8004 ownership. Capture evidence promptly: RPC
transaction retention is finite. Unavailable RPC results fail verification.

A loaded terminal job can recover a receipt by supplying its terminal
transaction hash. Receipts and job IDs are portable; this application does not
claim a complete wallet-wide job index or permanent event history.

## Mainnet canary preparation

The Console supports a separate `mainnet-canary` profile, requires explicit
acknowledgement, and checks the immutable token's symbol/decimals before
funding. The canary symbol is DEMO8183. A symbol alone is not an asset safety
proof; the operator must verify issuer, token ID, and non-redeemability.

No mainnet deployer is run automatically. `AGENTS.md` and `docs/security.md`
require an independent audit before wider deployment, and the proposal still
requires the Chapter Lead to accept the valueless-canary boundary. There is
also no funded mainnet deployment signer in this workflow. Valuable-asset
deployment is not permitted by this implementation.

After the Chapter Lead accepts the valueless-canary boundary, prepare a
source-bound authorization record for independent review:

```sh
corepack pnpm@11.9.0 --filter @trionlabs/8183-console \
  preflight:mainnet prepare
```

The command refuses a dirty worktree, rebuilds the release twice, and writes an
ignored, owner-readable template to
`deployments/private/mainnet-authorization.json`. Fill it with the actual
Chapter Lead approval, independent audit, and threat-model review references.
It deliberately rejects placeholders, unresolved critical/high findings, or a
review that is not independent from the builder.

Provision four distinct, minimally funded `canary-admin`, `canary-client`,
`canary-provider`, and `canary-evaluator` identities in the Stellar CLI OS
secure store or on a hardware wallet. Never place signing material in `.env`.
Then run the read-only gate:

```sh
corepack pnpm@11.9.0 --filter @trionlabs/8183-console \
  preflight:mainnet check
```

It checks the exact reviewed commit and Wasm hashes, Mainnet health, public
role addresses, account separation, and XLM availability. It does not sign or
submit a transaction. A successful preflight is readiness evidence, not a
deployment or permission to skip human transaction review.

See `docs/mainnet-canary-threat-model.md` for the prepared threat model,
predeployment record, evidence requirements, and failure response. Its blank
approval references are not deployment authorization.

`src/canary.ts` defines the separate strict evidence profile, and
`tools/verify-canary.ts` checks deployed Wasm, token metadata, creation and hook
admission transactions, hook binding, terminal jobs, and exact-budget payout
events. It rejects duplicate jobs and Open-state rejection as refund evidence.
It also records the pinned build toolchain, observed before/funded/terminal
balances, exact arithmetic, and funding transaction references. The verifier
re-fetches successful funding and payout events; observed snapshots alone are
not treated as proof of payment. Historical absolute balance snapshots are
captured observations, not independently authenticated ledger proofs; the
verifier authenticates the referenced transfers and checks snapshot arithmetic.
Source, Wasm hashes, compiler/CLI identities, and build inputs must also match
the trusted reviewed v0.1 profile in `tools/provenance.ts`. An alternative source
commit is accepted only if available in local Git and its contract/build input
objects match that profile exactly. Fetch the declared commit before verifying
such a manifest. A new contract build profile requires separate review; hashes
supplied by an untrusted manifest are not themselves a provenance anchor.

```sh
corepack pnpm@11.9.0 --filter @trionlabs/8183-console verify:canary canary-evidence.json PUBLIC_G_ACCOUNT
```

The evidence format deliberately labels automated canary runs `author-run` and
does not promote or rewrite the historical v0.1 release manifest.

## Independent pilot protocol

Recruit one unaffiliated client with their own wallet. Collect consent and a
written nonbinding pilot confirmation. Conduct three problem interviews, two
before submission if following the current CDP. Ask for a recurring real
workflow before showing the solution.

Run a guided baseline, then a final unassisted client session. The participant
creates and funds six testnet jobs: two complete, two receive funded evaluator
rejections, and two expire and are refunded. The team may operate provider and
evaluator roles; do not claim evaluator independence. Include at least one
direct provider and, when a real testnet registration is available, one 8004
import. Never receive or operate the participant's key.

Metrics are opt-in, local, and contain only event names and elapsed seconds.
No wallet address, job text, or file contents are collected. Export the report
manually. Separate author-run and independent-session evidence.

The final report must record first-funded-job time, errors, assistance, issue
links for the largest repeated blockers, and a continue/change/stop decision.
If fewer than three repeated blockers appear, report the actual count rather
than inventing issues. A negative adoption result is a valid learning outcome.
