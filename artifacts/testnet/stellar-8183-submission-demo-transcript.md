# Soroban Agentic Commerce live submission demo transcript

Video: `artifacts/testnet/stellar-8183-submission-demo.mp4`

Duration: 78.307 seconds

This is an exact-window recording of a real macOS Terminal followed by a Playwright-controlled Chrome window. It live-verifies previously finalized July 30, 2026 Stellar testnet evidence; it does not submit a new transaction. The canonical machine-evidence recording remains `demo.mp4`.

Source capture SHA-256: `a766c05a8c9b80850e20e5f3ad19a5837149db544455cf77860fb75b923e759c`

## 00:00:00.200

This is ERC-8183-style job escrow on Stellar. A real Terminal is on pinned public main, commit b9d4134.

## 00:00:08.100

All 19 evidence-tooling tests pass. Semantic validation checks consistency, not provenance.

## 00:00:14.240

Horizon confirms job 4: success, ledger 3,872,500, identical hash.

## 00:00:20.802

The ledger endpoint returns its real public ledger hash.

## 00:00:25.980

The permissionless refund is independently successful in ledger 3,872,461 and returns the full escrow.

## 00:00:34.242

Its ledger endpoint returns the second public hash.

## 00:00:38.100

Now Playwright opens Stellar Expert itself. The completion page shows the full URL, successful status, ledger, and complete invocation.

## 00:00:48.300

The second live navigation shows the successful claim_refund invocation and its ledger.

## 00:00:53.400

This is functional testnet evidence, not a new transaction submission and not audited production software. Mutation methods only prepare and simulate; relay signing is delegated to callbacks, and the facilitator submits. The SDK never accepts or stores secret keys. The live kernel differs from the v0.1.0 release, so byte-for-byte provenance is not claimed. npm remains unpublished.
