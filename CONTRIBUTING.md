# Contributing

Thank you for helping make the escrow kernel smaller, safer, and easier to
verify.

## Ground rules

- Treat the pinned ERC normative prose and [protocol ABI](docs/protocol.md) as
  public compatibility contracts.
- Preserve `MAIN.md` as the original statement of work. Corrections and
  implementation decisions belong in `README.md` or `docs/`.
- Never commit a seed, secret key, `.env`, npm token, RPC credential, signing
  payload containing private material, or private testnet deployment file.
- Keep mainnet deployment, fees, upgrades, arbitration, identity, reputation,
  and threshold evaluators out of version 0.1.x unless the project scope is
  explicitly revised.
- Report suspected vulnerabilities privately to `deniz@trionlabs.dev` before
  opening a public issue.

## Development setup

The repository pins Rust 1.96.0 with `wasm32v1-none`, Soroban SDK 27.0.3,
Stellar CLI 27.0.0, Node 22, pnpm 11.9.0, and Stellar SDK 16.2.0.

```sh
corepack enable
pnpm install --frozen-lockfile
cargo test --workspace
pnpm check
```

Build deployable contracts with Stellar CLI rather than a raw Cargo Wasm
command:

```sh
stellar contract build --locked --optimize
```

## Before submitting a change

Run:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
pnpm check
./scripts/release-build.sh
./scripts/verify-release.sh
git diff --check
```

If a command is temporarily unavailable because generated bindings or a release
artifact has not been produced, explain that explicitly in the pull request. Do
not weaken or skip a release gate to make CI green.

## Contract changes

A contract-facing change must update all affected layers in the same pull
request:

1. Rust interface and implementation.
2. Exact-auth native-host tests and, when the change affects deployable
   behavior, public-testnet execution of the optimized Wasm. Do not describe
   native-host tests as compiled-Wasm integration.
3. Generated TypeScript bindings and high-level SDK adapter.
4. [protocol.md](docs/protocol.md), conformance mapping, security analysis, and
   resource snapshots.
5. Evidence schema when the public evidence shape changes.

Do not renumber a released contract error or reinterpret a released event.
Adding a function, type variant, field, or error is an ABI change and requires a
compatibility decision, even when Rust considers it source-compatible.

Tests that use blanket authorization mocks are useful for setup but are not
sufficient evidence for role security. At least one test per authorized path
must assert the exact invocation tree.

## SDK changes

- Keep private keys behind signer callbacks. Node keypair helpers are for demos,
  not implicit production key storage.
- Treat transaction XDR and RPC responses as hostile input.
- Keep recording-mode and enforcing-mode simulation distinct.
- Keep Stellar SDK's separate `restoreFootprint` fallback disabled unless the
  caller supplied an independently derived exact ledger-key allowlist, fee
  ceiling, bounded lifetime, network, and expected facilitator signer.
- Keep the full simulated footprint and Protocol 23 same-envelope archived-key
  set pinned in the trusted relay intent across authorization and facilitation.
- Add hostile-envelope tests for any new relay surface.
- Run `npm pack --dry-run` and inspect the complete file list.
- Test the tarball from a clean external consumer, not only within the
  monorepo.

## Documentation and evidence

Use primary, immutable sources where possible. Never add a deployed contract
ID, transaction hash, artifact hash, explorer link, npm URL, attestation, or
test result until it has been independently fetched and verified.

The SDK's `RawEvidenceCapture` is deliberately not the release manifest. It is
secret-whitelisted input to deterministic release assembly.
`docs/evidence.template.json` is intentionally not schema-valid while it
contains placeholders. Once filled, it first validates with status
`deployment`. A release is complete only after publication fields are
independently verified, status is promoted to `verified`, and the manifest
validates again against `docs/evidence.schema.json`. A deployment manifest must
not contain publication URLs. The release keeps it as
`evidence.deployment.json`; the guarded finalization workflow adds a separate
`evidence.verified.json` rather than rewriting the historical input. Neither
manifest may embed its own digest; hash the completed bytes externally and
publish the detached `.sha256` file.

Release evidence also uses a deliberate two-commit sequence. The manifest's
`release.source_commit` is the clean source/build/deployment commit. Its
immediate child may add only `deployments/testnet.json` and its hash-bound,
secret-safe `deployments/testnet.raw.json`, and that child receives the release
tag. This removes the impossible requirement for a committed file to contain
its own enclosing commit hash.

Never construct the manifest by editing
`docs/evidence.template.json`. Use `scripts/assemble-evidence.mjs` with the raw
capture and `docs/evidence-input.template.json`, then run both
`scripts/validate-evidence.mjs` and the strict JSON Schema validation. Changes
to either evidence tool require adversarial tests for inconsistent raw fields,
authorization, accounting, artifact hashes, and overwrite refusal.

Stellar network settings change. If testnet is no longer Protocol 27 or the
official test-USDC identifiers differ, stop the release, update code and
documentation together, and repeat the full testnet run.

## Pull requests

Keep changes narrowly scoped and describe:

- the user-visible behavior;
- security and liveness consequences;
- ABI/storage compatibility;
- tests run and their results;
- resource-cost movement;
- any remaining limitation.

By contributing, you agree that your contribution is licensed under the
repository's [MIT License](LICENSE).
