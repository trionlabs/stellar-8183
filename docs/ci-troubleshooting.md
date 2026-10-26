# CI failure diagnosis and verification

## Failure identified

The Console run at source `f9743ed` failed its Rust dependency audit:
[run 40238838391](https://github.com/trionlabs/stellar-8183/actions/runs/40238838391).
Rust contract tests and TypeScript checks passed. The failed audit then skipped
the secret scan because both steps were in one job. A later run of `fc3f95e`
passed after the documented, guarded native-host exception was added.

Older Dependabot runs also failed the npm audit on older lockfiles. For example,
[run 39801403687](https://github.com/trionlabs/stellar-8183/actions/runs/39801403687)
reported high-severity Axios, follow-redirects, and Vite findings. These failures
occurred before its TypeScript tests could run; they are not evidence of a new
Console or Pages deployment failure.

The root cause was established directly from the failed steps and advisory
output, so speculative runtime hypotheses were unnecessary. The pass/fail loop
used the actual run and local audits:

```sh
gh run view 40238838391 --repo trionlabs/stellar-8183 --exit-status
corepack pnpm@11.9.0 audit --json
```

The first reproduces the historical failure as exit status 1. The npm audit
returned 1 with the remaining moderate TOML finding before the parser update,
then 0 with no findings after installing the pinned 1.9.1 patch.

## Changes and verification

- Rust dependency audit, npm dependency audit, and secret scanning have no job
  dependency on each other. TypeScript tests also run independently of audits.
- The existing `Dependency and secret audit` check is retained as an aggregate
  gate. It requires success from all three jobs; failure, cancellation, or a
  skipped check cannot turn it green. No `continue-on-error` is used.
  The actual gate script was exercised with ten cases: all-success, plus
  failure/cancellation/skipping in each of the three upstream results.
- Job timeouts bound stalled execution. Secret-tool downloads retry transient
  failures while retaining the pinned archive digest check.
- The workspace installs the patched TOML parser. An SDK HTTP integration test
  checks actual metadata resolution and parsing errors without external traffic.
- Actionlint validates `ci.yml`. The historical v0.1 release workflow and its
  intentionally disabled npm publication job are unchanged.

`docs/dependency-audit.md` records the remaining Rust host-only exception and
its revocation conditions. Contract source, toolchain, immutable v0.1 artifacts,
mainnet restrictions, and release publication permissions are unchanged.

## Inspect the correct source

```sh
gh pr checks 44 --repo trionlabs/stellar-8183
gh run list --repo trionlabs/stellar-8183 --branch feat/agent-commerce-console
curl --fail https://trionlabs.github.io/stellar-8183/build.json
```

Historical failed runs retain their original result. Compare their commit with
the current PR head and the deployed `build.json`; do not rerun an old commit
expecting it to pick up a newer lockfile or workflow. These changes are on the
implementation PR until it is merged; unrelated older bot branches retain their
own lockfiles. Nothing here deletes or hides failed runs.
