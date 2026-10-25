# Dependency audit assessment

Reviewed on 2026-10-25. Exceptions below do not constitute an independent audit
or permission to deploy the unaudited escrow on mainnet.

## Native test host: RUSTSEC-2026-0387

[RustSec's advisory](https://rustsec.org/advisories/RUSTSEC-2026-0387.html)
describes secret-dependent timing in `crypto-bigint`; the advertised patched
series begins at 0.7.6. The pinned Soroban SDK's native host uses 0.5.5 through
`elliptic-curve` 0.13.8 and `soroban-env-host` 27.0.1. Replacing that dependency
with a new major version is not a compatible lockfile-only update.

The project does not run a production Soroban host or use this Rust dependency
to sign user transactions. Rust tests use generated public addresses and mock
authorization. Wallet signing and CLI identities are outside the Rust host.
This assessment is limited to this repository's usage, not Stellar validators
or other applications using these crates.

The SDK selects the native host under `cfg(not(target_family="wasm"))` and the
guest for Wasm, as documented in its
[27.0.3 manifest](https://github.com/stellar/rs-soroban-sdk/blob/v27.0.3/soroban-sdk/Cargo.toml).
The following locked dependency graph checks confirmed the distinction:

```sh
cargo tree --locked -i crypto-bigint
cargo tree --locked -i crypto-bigint --target wasm32v1-none
node scripts/check-wasm-dependencies.mjs
```

The first shows only native host paths; the second has no entries. On that
evidence, CI ignores this single advisory while a preceding guard fails if
`crypto-bigint` enters the production Wasm normal/build dependency graph. All
other vulnerability findings remain blocking. Raw `cargo audit` without this
explicit exception still reports the advisory; no patched-dependency claim is
made.

Revoke/reassess the exception if the guard fails, Rust code starts signing or
processing secret scalar values, a production host is introduced, the SDK is
updated, or a compatible upstream fix becomes available. Retain the immutable
release's contract-source/Wasm provenance until a separately reviewed release.

## JavaScript: GHSA-r4xh-jqrq-34v2

The final pnpm audit reports one moderate transitive
[`smol-toml` advisory](https://github.com/advisories/GHSA-r4xh-jqrq-34v2), with
zero high or critical findings. It advertises 1.8.1 as patched, but that version
was unavailable from the configured npm registry at review time. The installed
version is 1.7.1 through `@stellar/stellar-sdk` 16.2.0.

The Console calls contract/RPC and wallet APIs. It does not call Stellar TOML
discovery or fetch agent metadata URLs, which limits exposure to the affected
parser. The dependency remains vulnerable for consumers that do call that API;
do not pass untrusted TOML through it. No pnpm advisory is suppressed; CI
continues to reject high/critical findings. Adopt the compatible patch once it
is available and rerun workspace and browser checks.
