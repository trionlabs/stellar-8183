# Testnet verification and review

This review concerns the standalone Console and its existing immutable testnet
contracts. Three agents reviewed Standards, Spec, and Evidence separately, and
findings were checked with targeted tests and live RPC/browser probes. No
independent security audit or independent customer pilot has been completed.

## Standards

One medium availability finding was corrected. A confirmed transaction followed
by an RPC read failure previously lost its job ID/outcome at the UI boundary.
A signed transaction whose confirmation failed could also lose its hash. Typed
results now preserve those distinct states, save public recovery metadata, and
require status checks before repeating the affected action.

Recovery verifies the network-bound envelope hash, source, kernel, method, job
ID, confirmation status, and creation return value. `NOT_FOUND` remains unknown.
Tracking does not automatically resend or sign. Other jobs and their refunds
remain usable. Existing identity snapshots survive read-only recovery, while an
explicit provider change removes the prior claim.

Follow-up review closed two entry-point gaps: 8004 provider changes respect the
same pending-job barrier, and journal checks repeat immediately before action
execution after the review dialog. This reduces cross-tab races; local browser
tracking is not a distributed transaction lock.

No additional signing or escrow exploit was demonstrated. The native-host Rust
advisory exception remains guarded and unfixed upstream, as documented in
`dependency-audit.md`.

## Spec

Two confirmed usability defects were corrected:

- The documented `console:test` and `console:e2e` commands failed when ignored
  SDK build output was absent. They now build the SDK first. Both entrypoints
  passed in an isolated snapshot after verifying the SDK output was absent.
  CI now exercises the Console test bootstrap before the workspace build.
- Terminal progress previously marked every intermediate stage complete, even
  for Open cancellation or funded rejection without submission. Terminal views
  now show the actual outcome without inferring unrecorded history. Browser
  tests cover both rejection cases, completion, and expiry.

The previous browser suite did not connect/sign in live mode. An additional
author-run suite now exercises the actual Freighter API message protocol and
real testnet transactions, with signing confined to Node. It checks approval
rejection, account/network changes, direct provider assignment, funding, all
three terminal paths, balance deltas, reload, receipt export, and verification.
Injected confirmation and post-confirmation read failures recover the same job
without duplicate creation.

## Evidence

Two confirmed verifier defects were corrected:

- A fabricated source commit could previously pass the canary verifier when
  paired with real deployed hashes. Verification now requires the trusted v0.1
  source/build profile, including expected Wasm hashes and compiler identities.
  Other commits must exist locally and have identical tracked build-input
  objects. Unknown, unrelated, modified-build, or changed-hash claims fail before
  RPC verification. This matches a reviewed build profile rather than performing
  a fresh independent compilation on every verifier invocation.
- Receipt parsing accepted a numeric budget after checksum recomputation.
  Decimal integer fields now enforce their documented string type.

The original six CLI receipts passed live verification after these fixes. The
final hosted browser run created jobs 18-20 from the exact CI-reviewed source
commit. All hosted files matched the CI artifact before signing. The three
receipts passed an independent checksum, terminal-state, exact-budget event, and
source/role authorization review. All jobs 1-20 are terminal, their aggregate
funded liability is zero, and the kernel's DEMO8183 balance is zero. Public
reports label author control and do not present it as customer validation.

## Verification limits

- The automated wallet bridge does not prove the actual Freighter extension UI,
  a human approval session, or independent-user usability. Those remain part of
  the observed pilot.
- RPC is trusted, historical transaction retention is finite, and browser-local
  history can be unavailable or removed. Save portable receipts and references.
- Balance snapshots are captured observations with arithmetic/transfer checks;
  absolute historical balances are not authenticated by ledger proofs.
- 8004 bindings are advisory pre-funding snapshots, not atomic ownership proofs.
- Mainnet deployment remains pending the repository audit prerequisite and
  coordinator acceptance. No valuable-asset safety claim is made.

Standards: 1 confirmed finding corrected; Spec: 2 corrected, with live-browser
coverage added; Evidence: 2 corrected. No unresolved blocking defect was found
within this reviewed testnet scope. The external verification limits above remain.
