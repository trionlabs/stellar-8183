# Testnet deployment, demonstration, and evidence runbook

This runbook produces release evidence; it does not contain deployment results.
Contract IDs, transaction hashes, Wasm hashes, job IDs, and explorer URLs remain
absent until observed and independently verified.

## Fixed testnet inputs

| Property                  | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| Network                   | Stellar testnet                                            |
| Passphrase                | `Test SDF Network ; September 2015`                        |
| RPC                       | `https://soroban-testnet.stellar.org`                      |
| Expected protocol         | 27; query again immediately before deployment              |
| Test USDC issuer          | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| Test USDC SEP-41 contract | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| Test USDC decimals        | 7                                                          |
| Demonstration budget      | `10000000` base units = 1 test USDC                        |

The token identifiers come from Stellar's official
[x402 asset table](https://developers.stellar.org/docs/build/agentic-payments/x402).
Test assets have no monetary value.

Stellar ledgers currently close roughly every five seconds. Do not describe this
as sub-second finality and do not implement a fixed five-second sleep as a
consensus check. Poll transaction status and ledger timestamps.

## 1. Local and testnet technical gates

Stop before any deployment unless all are true:

- The source tree is clean at an exact commit that will be recorded as the
  source/build/deployment commit.
- `MAIN.md` has not changed.
- Every currently implemented local gate in [testing.md](testing.md) passes.
- No critical/high security or self-review finding remains open.
- Stellar CLI is exactly 27.0.0 and testnet reports Protocol 27 with the expected
  passphrase.
- Two isolated optimized builds are byte-identical.
- The Wasm interface matches [protocol.md](protocol.md).
- Release Wasm embeds
  `source_repo=github:trionlabs/stellar-8183`.

The repository need not be public and npm authentication need not be configured
for this provisional technical run. Those are publication gates, not conditions
for learning whether the contracts work on testnet. Until the later publication
gates pass, the result may have only `status: "deployment"` and must not be
described as an endorsed or verified release.

Record, but do not publish, the output of:

```sh
git rev-parse HEAD
git status --short
rustc --version
stellar --version
node --version
pnpm --version
stellar network info --network testnet --output json-formatted
```

If the reported protocol or public token constants differ from this document,
do not override the check. Reassess compatibility and update the release.

## 2. Local verification and reproducible artifacts

From a clean checkout:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
pnpm install --frozen-lockfile
pnpm check
./scripts/verify-release.sh
./scripts/release-build.sh
```

Expected release files:

```text
artifacts/release/stellar_8183_commerce.wasm
artifacts/release/stellar_8183_sla_hook.wasm
```

Save each byte length and SHA-256. Inspect both artifacts:

```sh
stellar contract info interface \
  --wasm artifacts/release/stellar_8183_commerce.wasm \
  --output json-formatted

stellar contract info meta \
  --wasm artifacts/release/stellar_8183_commerce.wasm \
  --output json-formatted

stellar contract info interface \
  --wasm artifacts/release/stellar_8183_sla_hook.wasm \
  --output json-formatted

stellar contract info meta \
  --wasm artifacts/release/stellar_8183_sla_hook.wasm \
  --output json-formatted
```

Reject an artifact if metadata points at a different repository, the interface
differs, the optimized file exceeds the network limit, or clean-build hashes
differ.

## 3. Provision five distinct identities

Use dedicated, valueless testnet identities:

- `acp-admin`
- `acp-client`
- `acp-provider`
- `acp-evaluator`
- `acp-facilitator`

The administrator deploys and admits the hook. The client, provider, and
evaluator sign only their role authorization entries during the demo. The
facilitator is the transaction source, consumes its own sequence number, signs
the envelope, and pays inclusion/resource fees.

Stellar CLI can generate and Friendbot-fund an identity with:

```sh
stellar keys generate <identity-name> \
  --network testnet \
  --fund \
  --secure-store
```

Use the OS secure store where the calling workflow supports it. The Node demo
uses signer callbacks configured from the untracked `.env`; if local test
secrets are needed there, enter them without terminal echo and never call a
command that prints them. Public addresses can be obtained safely with:

```sh
stellar keys public-key <identity-name>
```

Before continuing:

- Verify all five public addresses are different.
- Friendbot-fund enough XLM for normal G-account reserves.
- Add the official test-USDC classic trustline to client, provider, and
  evaluator. The evaluator receives no protocol fee, but the evidence run
  reads its zero balance to prove that property. For an identity stored in
  Stellar CLI:

```sh
stellar tx new change-trust \
  --network testnet \
  --source-account <identity-name> \
  --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
```

- Use [Circle's testnet faucet](https://faucet.circle.com) to send test USDC to
  the client's public address.
- Verify client, provider, and evaluator trustlines and balances from a fresh
  network query.

A facilitator paying fees does not pay another G-account's minimum reserve.
Normal accounts need XLM to exist, and each trustline adds a reserve
requirement. Sponsored reserves and C-account agents are valid follow-on
patterns, not assumptions in this demo.

## 4. Prepare secret-safe configuration

Copy `.env.example` to the ignored `apps/demo/.env`, then fill only locally:

- the five dedicated test secrets;
- a positive `SLA_REVIEW_SECS`;
- an explicit `MAX_FEE_STROOPS` based on fresh simulations;
- later, only the contract IDs and hashes verified in the next step.

Do not source the file into a recorded shell, commit it, attach it to a release,
or include it in an npm tarball. Start the terminal recording only after key
provisioning and redact shell history, notifications, and unrelated windows.

## 5. Deploy and admit the contracts

Deploy the immutable kernel with the admin public address and official test-USDC
contract:

```sh
stellar contract deploy \
  --network testnet \
  --source-account acp-admin \
  --wasm artifacts/release/stellar_8183_commerce.wasm \
  --optimize=false \
  --alias stellar-8183-kernel \
  -- \
  --admin <ADMIN_G_ADDRESS> \
  --token CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
```

Deploy the immutable SLA hook with the resulting kernel ID and a positive review
window:

```sh
stellar contract deploy \
  --network testnet \
  --source-account acp-admin \
  --wasm artifacts/release/stellar_8183_sla_hook.wasm \
  --optimize=false \
  --alias stellar-8183-sla-hook \
  -- \
  --core <KERNEL_CONTRACT_ID> \
  --review_secs <POSITIVE_SECONDS>
```

`--optimize=false` is mandatory here because the files in `artifacts/release`
are already optimized and hash-frozen. CLI 27 optimization is not guaranteed
to be byte-idempotent when applied a second time.

Admit it:

```sh
stellar contract invoke \
  --network testnet \
  --source-account acp-admin \
  --id <KERNEL_CONTRACT_ID> \
  -- \
  set_hook \
  --hook <SLA_HOOK_CONTRACT_ID> \
  --allowed true
```

Record all three successful transaction hashes from the CLI output. While RPC
still retains them, build the SDK and capture the complete public deployment
transactions:

```sh
mkdir -p artifacts/testnet
pnpm --filter @trionlabs/stellar-8183 build

node scripts/capture-deployment-transactions.mjs \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  --admin <ADMIN_G_ADDRESS> \
  --kernel-id <KERNEL_CONTRACT_ID> \
  --kernel-hash <KERNEL_DEPLOYMENT_TRANSACTION_HASH> \
  --hook-id <SLA_HOOK_CONTRACT_ID> \
  --hook-hash <SLA_HOOK_DEPLOYMENT_TRANSACTION_HASH> \
  --admit-hash <HOOK_ADMISSION_TRANSACTION_HASH> \
  --output artifacts/testnet/deployment-transactions.json
```

The capture command refuses a non-testnet RPC, wrong source, contract/hash
shape, failed or missing transaction, fee-bump envelope, extra/overridden
operation, wrong function target, or existing output. Review the three
whitelist-only records before setting
`DEPLOYMENT_EVIDENCE_INPUT=artifacts/testnet/deployment-transactions.json`.

Immediately verify:

- `get_token()` is the official test-USDC contract.
- `get_admin()` is the intended administrator.
- `is_hook(SLA_HOOK_CONTRACT_ID)` is true.
- The hook's `get_core()` equals the kernel and `review_secs()` equals the
  constructor value.
- Constructor and admission transactions succeeded at the recorded ledgers.

Fetch deployed Wasm to new files and compare it with local artifacts:

```sh
stellar contract fetch \
  --network testnet \
  --id <KERNEL_CONTRACT_ID> \
  --out-file artifacts/testnet/kernel.fetched.wasm

stellar contract fetch \
  --network testnet \
  --id <SLA_HOOK_CONTRACT_ID> \
  --out-file artifacts/testnet/sla-hook.fetched.wasm

shasum -a 256 \
  artifacts/release/stellar_8183_commerce.wasm \
  artifacts/testnet/kernel.fetched.wasm

shasum -a 256 \
  artifacts/release/stellar_8183_sla_hook.wasm \
  artifacts/testnet/sla-hook.fetched.wasm
```

Each local/fetched pair must match exactly. A mismatch is a failed deployment,
not a documentation exception.

## 6. Execute relayed scenarios

For every state-changing role action:

1. Build the exact trusted intent.
2. Run recording-mode simulation.
3. Have only the required role sign its auth entry with a short expiration.
4. Run client enforcing-mode simulation.
5. Give the signed envelope and the separately trusted intent to the
   facilitator.
6. Validate envelope shape, network, function/arguments, authorizers, time
   bounds, fee ceiling, and absence of facilitator authorization.
7. Rebuild with the facilitator's current source account.
8. Run fresh facilitator enforcing-mode simulation. The trusted intent must
   still match the full footprint and any Protocol 23 same-envelope archived
   read-write keys. If simulation requests a separate restore-preamble
   transaction, stop: restore only through `createGuardedRestoreSigner` with an
   independently derived exact ledger-key allowlist, bounded fee and lifetime,
   expected network, and expected facilitator; then restart at step 1.
9. Sign the envelope, submit, poll to terminal success, then query state and
   balances again.

Use the SDK's `prepareRelay`, `authorizeRelay`, and `facilitateRelay` flow rather
than substituting CLI transaction-source authorization. A valid demo must show
the facilitator G-address as source and the client/provider/evaluator as signed
authorization-entry authorizers.

After filling `apps/demo/.env`, execute the four scenarios:

```sh
pnpm build
pnpm --filter @trionlabs/stellar-8183-demo start:testnet
```

### Completion

1. Create with no provider, distinct evaluator, future expiry, and the admitted
   SLA hook.
2. Set the provider as client.
3. Exercise negotiation by letting both permitted roles set a positive budget;
   finish at exactly `10000000`.
4. Fund with `expected_budget = 10000000`.
5. Submit a reproducible SHA-256 deliverable commitment while the SLA review
   window still fits.
6. Complete with an optional reproducible decision commitment.

Expected net token deltas for this isolated job are client `-10000000`,
provider `+10000000`, and kernel `0` after settlement. There are no fee
deductions.

### Permissionless expiry refund

1. Create, assign provider, set a positive budget, and fund.
2. Poll the network's latest ledger timestamp; do not use the local clock as the
   authority.
3. Once `ledger.timestamp >= expires_at`, prepare `claim_refund`.
4. Submit with the facilitator as source and no role authorization entry.

The job must be Expired, the full budget must return to the client, and no hook
callback may appear. Client net token delta is zero across funding/refund.

### Rejections

- Create an Open job and reject it with client authorization. Assert zero token
  movement.
- Fund a separate job and reject it with evaluator authorization. Assert a full
  client refund and zero retained liability.

After every step, verify the decoded job and exact token balances before
preparing the next transaction.

## 7. Capture evidence immediately

RPC event history is intentionally short-lived. For each transaction, capture
at once:

- hash, ledger sequence, close time, success result, and Stellar Expert URL;
- transaction source and all auth-entry authorizers;
- exact contract, function, and a SHA-256 of canonical arguments/envelope;
- decoded kernel and SEP-41 events;
- post-transaction `Job`;
- client, provider, kernel, and relevant evaluator balances with exact deltas;
- instruction/read/write resources and both fee components.

Stellar Expert link forms are:

```text
https://stellar.expert/explorer/testnet/contract/<CONTRACT_ID>
https://stellar.expert/explorer/testnet/tx/<TRANSACTION_HASH>
```

The SDK demo writes a `stellar-8183/raw-testnet-capture/v1` object to
`RAW_EVIDENCE_OUTPUT`. It is a secret-whitelisted capture of receipts, event
XDR, resources, jobs, and balances—not the release manifest. Preserve it as an
input artifact and never relabel it.

The demo starts after deployment. Deployment tooling must write the three
original, fully decoded `EvidenceTransaction` objects as a JSON array at
`DEPLOYMENT_EVIDENCE_INPUT`. The required ordered label/function pairs are
`deploy_kernel`/`__constructor`,
`deploy_sla_hook`/`__constructor`, and `admit_hook`/`set_hook`. The demo checks
that order, each configured contract ID, and the admin source before adding the
records through `EvidenceRecorder.recordExternalTransaction()`. Do not rename
`set_hook` to `admit_hook`: the former is the actual function and the latter is
only the evidence step. Preserve the original result/event XDR, decoded
authorizers/events, argument and envelope hashes, close times, resources, and
fees. Never infer a missing field from a label.

The demo creates `RAW_EVIDENCE_OUTPUT` with exclusive-create semantics before
the first scenario, then atomically checkpoints after each finalized
transaction, job snapshot, and scenario balance summary. A late RPC failure
therefore leaves a partial audit trail but never a valid final manifest; reruns
must use a new path or deliberately archive the old capture.

Stage the canonical secret-safe capture at the tracked release path:

```sh
cp "$RAW_EVIDENCE_OUTPUT" deployments/testnet.raw.json
```

Copy [evidence-input.template.json](evidence-input.template.json) to the ignored
`artifacts/testnet` directory and fill only observed tool outputs, the deployed
SLA review window, independently built/fetched artifact paths, the packed SDK
tarball path, and the reviewed recording path. The two `*_rebuild_wasm` paths
must be independent clean-build outputs, not aliases of the release paths.

Then use the checked-in assembler; do not hand-fill the release manifest:

```sh
node scripts/assemble-evidence.mjs \
  --raw deployments/testnet.raw.json \
  --metadata artifacts/testnet/evidence-input.json \
  --output "$EVIDENCE_OUTPUT"
```

The assembler refuses unknown/missing metadata, reused clean-build paths,
nonidentical local/rebuilt/fetched Wasm, a malformed raw source commit, wrong
scenario labels/order/auth/state/balances, inconsistent cross-references, and
an existing output. For the same raw bytes, metadata, and artifact bytes it
emits byte-identical canonical JSON. It hashes the raw capture, Wasm, npm
tarball, and recording itself.

Run the independent semantic validator and JSON Schema validator:

```sh
node scripts/validate-evidence.mjs \
  deployments/testnet.json \
  deployments/testnet.raw.json

npx --yes \
  --package=ajv-cli@5.0.0 \
  --package=ajv-formats@3.0.1 \
  ajv validate \
  --spec=draft2020 \
  --strict=true \
  -c ajv-formats \
  --all-errors \
  --errors=text \
  -s docs/evidence.schema.json \
  -d deployments/testnet.json
```

While testnet RPC still retains every transaction, re-fetch and decode the
submitted envelopes:

```sh
node scripts/verify-evidence-onchain.mjs \
  deployments/testnet.json \
  deployments/testnet.raw.json
```

This separate live gate reruns semantic validation, fetches every transaction
by hash, requires terminal success and matching ledger/close metadata, verifies
the exact envelope and result XDR, recomputes the transaction/envelope/argument
hashes, decodes the one invoke-host-function operation, and compares its source,
contract, function, authorization addresses, and declared Soroban resources.
For each deployment it additionally requires `createContractV2`, matches the
embedded Wasm hash and constructor-argument commitment, checks the address
preimage, and derives the recorded contract ID from that preimage and the
testnet network ID.
Run it immediately: a later `NOT_FOUND` caused by testnet/RPC retention is not
permission to mark an unverified transaction as valid.

[evidence.template.json](evidence.template.json) remains an intentionally
invalid shape reference; it is not an input to the assembler. A valid
`deployment` manifest proves the captured build and on-chain scenarios but is
not final release evidence. Schema validity is necessary but not sufficient.
The semantic validator cross-binds the raw-capture hash and fields, role
identities, constructors, Wasm hashes, exact four scenario sequences,
authorizers, snapshots, events, ledger range, explorer links, and balance
arithmetic. Independently open every explorer URL and re-fetch both contract
Wasm files as a final human check.

The artifact array contains exactly `kernel_wasm`, `sla_hook_wasm`,
`sdk_tarball`, `raw_testnet_capture`, and `demo_recording`. The raw artifact
must name `deployments/testnet.raw.json` and match its exact byte count and
SHA-256. The array must not contain
the evidence manifest itself: embedding the manifest's own SHA-256 would require
an impossible circular fixed point. Hash each manifest only after its final JSON
bytes exist. The release workflow publishes those hashes as detached
`evidence.deployment.json.sha256` and `evidence.verified.json.sha256` files and
checks each detached digest against a fresh download.

The evidence and recording must contain no seed, secret, credential, `.env`
contents, auth-entry signature bytes that policy treats as sensitive, clipboard
overlay, or terminal history from provisioning.

## 8. Publish and verify

This phase has additional gates. Before it starts, the target GitHub repository
must exist publicly, the exact source/build/deployment commit must be pushed
unchanged, public CI must pass all implemented gates, the npm scope must be
controlled, and release/npm authentication must be configured without placing
credentials in the repository.

The release uses two commits to avoid asking a JSON file to contain the hash of
the commit that contains that same file:

1. Push the exact source/build/deployment commit to
   `https://github.com/trionlabs/stellar-8183`. This is the commit recorded in
   `release.source_commit` and used for the provisional testnet build and
   deployment.
2. Review the schema-valid `deployments/testnet.json` and its hash-bound
   secret-safe `deployments/testnet.raw.json`, then create one evidence-only
   child commit containing exactly those two files. Do not commit the
   recording. `git diff --name-only HEAD^ HEAD` must print only:

   ```text
   deployments/testnet.json
   deployments/testnet.raw.json
   ```

3. Tag the evidence-only child commit `v0.1.0` and push the tag. The workflow
   requires `release.source_commit == HEAD^` and rejects any other file change
   between the source commit and tagged commit.
4. Let the tag workflow build the same Wasm with embedded
   `source_repo=github:trionlabs/stellar-8183`, create provenance attestations,
   publish the GitHub release with `evidence.deployment.json`,
   `evidence.raw.json`, and both detached checksums, and publish the exact
   hash-recorded `@trionlabs/stellar-8183@0.1.0` tarball with npm provenance.
5. Download release Wasm and npm tarball into a clean directory and recompute
   hashes.
6. Follow the
   [SEP-55 verification flow](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0055.md)
   from deployed Wasm hash to repository and exact commits. The GitHub
   attestation binds the tagged evidence commit; the manifest identifies its
   immediate source parent, and the enforced exact two-file diff plus
   byte-identical Wasm hash connects the two without circularity.
7. Install the registry package in a clean Node 22 consumer and run its import
   smoke test.
8. Upload the secret-free recording to the existing release. This step is
   deliberately manual because the recording is not committed:

   ```sh
   gh release upload v0.1.0 /absolute/path/to/demo.mp4 \
     --repo trionlabs/stellar-8183
   ```

   Recompute the downloaded asset's SHA-256 and require it to equal
   `demo.recording_sha256`.

9. Verify all public links from a logged-out browser.
10. Dispatch `.github/workflows/release.yml` with `release_tag=v0.1.0` and the
    recording's public GitHub-release URL. The finalization job independently:
    - validates that the checked-in and released deployment manifests are
      byte-identical, does the same for the raw capture, checks both detached
      hashes, and reruns semantic validation;
    - matches both released Wasm files to the local and fetched deployment
      hashes and checks their `source_repo` metadata;
    - cryptographically verifies both GitHub attestations against the exact
      tag, commit, repository, and workflow on a GitHub-hosted runner;
    - downloads the npm tarball, matches its recorded SHA-256, requires SLSA
      provenance metadata, runs `npm audit signatures`, and imports the
      installed package;
    - downloads the recording without credentials and matches its recorded
      SHA-256;
    - invokes `scripts/promote-evidence.mjs` with only those verified URLs,
      validates the result, uploads `evidence.verified.json`, downloads it
      again, and compares the bytes.

The promotion script changes only `status`, `generated_at`, the five publication
URLs, and their three verification flags. It refuses to overwrite its input,
accept pre-populated publication fields, or use a recording outside the tagged
GitHub release. Given the same deployment manifest and explicit arguments, its
output is byte-deterministic.

Do not call a `deployment` manifest final. Completion requires status
`verified`. It also remains blocked while any URL is private, any attestation
points to another commit, npm provenance is missing, the recording hash differs,
or deployed/release Wasm hashes differ. Keep `evidence.deployment.json` as the
immutable historical input; do not replace it with the verified asset.

## Failure handling

- Recording simulation failure: do not request signatures.
- Enforcing simulation failure: discard the prepared transaction and diagnose;
  do not submit with padded resources.
- Stale ledger footprint or archived state: re-simulate and preserve the new
  restore list.
- Unknown submission result: poll the original hash until status or time bounds
  resolve; do not issue a semantically duplicate transaction blindly.
- Token/trustline failure: fix the account condition, then create a fresh
  simulation and authorization entry.
- Wrong constructor value or Wasm mismatch: abandon the deployment and redeploy
  correctly. Contracts are immutable.
- Testnet reset: mark all old evidence stale and rerun deployment plus all
  scenarios.
- Suspected secret exposure: stop recording and release work, rotate/discard all
  affected test identities, and audit repository history and artifacts before
  continuing.
