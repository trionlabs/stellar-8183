# Month-two grant evidence

Start with `grant-evidence-index.json`. It separates the current source-bound
Testnet engineering demo, the verified Mainnet canary, and the pseudonymous
independent pilot. The pilot evidence discloses the coordinator-approved proxy
execution mode and does not claim that the participant personally signed.

`testnet-demo-evidence.json` records the deployed Console at commit
`963c4c551139ce90a671ee46e94b7586749ff2ca` and jobs 31-33. The job states were
read directly from the Testnet contract again on 2026-10-27. The recording hash
is included, but its `publicUrl` remains null until the approved video is uploaded
and anonymous access is verified.

The Mainnet bundle is tracked at
`../../artifacts/mainnet-canary/canary-evidence.json`; its archive and verifier
instructions are documented in `../../docs/mainnet-canary-evidence.md`.

`independent-pilot-evidence.json` contains six real Testnet jobs from a fresh
disposable participant-reference wallet: two completions, two funded rejections,
and two expired refunds. The unaffiliated participant and coordinator approvals
were reported by the project lead and remain access-controlled. The public JSON
contains no participant name or secret. The proxy transaction paths are complete;
interviews, observed onboarding metrics, and the adoption decision are not.

## Historical author-run Testnet evidence

Network: Stellar testnet. Asset: non-redeemable DEMO8183. All roles in this
technical run were author-controlled. Independent customer participation and
mainnet deployment are not asserted.

Kernel: [CDQQSB...VFUNW](https://stellar.expert/explorer/testnet/contract/CDQQSBNGKJ6CR2VG65P73OJUIMHOLYNFJWXCLKANOACJ4MXXQDJVFUNW)

SLA hook: [CBWMY2...NKXWW7](https://stellar.expert/explorer/testnet/contract/CBWMY236VV2HVQOZKXYPW6UMNC3H2W4WLGVJSHALNCYC7IDT27NKXWW7)

The kernel/hook source is pinned to `97363501078154c65179208985e56ebb3b326ec7`.
The Console changes do not modify that contract source or ABI. The fetched Wasm
hashes match clean reproducible builds; versions and hashes are in the manifest.

| Job | Outcome          | Terminal transaction                                                                                                       |
| --- | ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 7   | Completed        | [c19c9537...](https://stellar.expert/explorer/testnet/tx/c19c9537840b7e519611ae87c734ca64eb9345756298867ede3a49ae216906fc) |
| 8   | Funded rejection | [1d3ba42f...](https://stellar.expert/explorer/testnet/tx/1d3ba42fc846d25dfbafba455ec524c4b1c457046cbc50fa60fb06a341520782) |
| 9   | Expired refund   | [80ca579e...](https://stellar.expert/explorer/testnet/tx/80ca579eda979bba2d2eca301cd981e5238d34cb692b79eda526d6ad1d8e8b67) |
| 10  | Completed        | [a762fea5...](https://stellar.expert/explorer/testnet/tx/a762fea5578c5cbf1b0fa6480723d2b65c15928a7087d16d24635747b4667d80) |
| 11  | Funded rejection | [641cb4d1...](https://stellar.expert/explorer/testnet/tx/641cb4d1876deabd6263ad9e82ed44c5b54059418c9c9f9f2bfde2117149c0fc) |
| 12  | Expired refund   | [0ea9af17...](https://stellar.expert/explorer/testnet/tx/0ea9af178155ea207e1fcde1839ab30b3e6f01a95b9050ffcf8c5b6f636d24cf) |

The latest source-bound browser run used the locally built Console from
`dfc993333893ec731622670589cec5499edaeee9`. It hashed every production file
before signing and produced these additional author-controlled jobs:

| Job | Outcome          | Terminal transaction                                                                                                       |
| --- | ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 21  | Completed        | [1c7d52f7...](https://stellar.expert/explorer/testnet/tx/1c7d52f7cd78cc389266323a8fdc8d973c65352dd3c0ec4364d48febcc3f1c84) |
| 22  | Funded rejection | [7ec381d7...](https://stellar.expert/explorer/testnet/tx/7ec381d79f7cc4bab7e5362a60d99b6b0b31a233c8c4d9522e824b4edb4b082b) |
| 23  | Expired refund   | [1debdcdd...](https://stellar.expert/explorer/testnet/tx/1debdcdd146bee14e9ac094aeb2d6f01864d910749956abf592ecca0a1b5fe5b) |

`browser-author-run.json` records the application hashes, wallet boundary,
submitted methods, and portable receipts. It explicitly says this is not an
independent participant or actual extension-UI session. Verify its detached
checksum with:

```sh
(cd deployments/month-two && shasum -a 256 -c browser-author-run.json.sha256)
```

`canary-evidence.json` is a canonical versioned evidence bundle with six portable
receipts and captured balance observations. Its filename identifies the evidence
profile, not the network: `profile.id` explicitly says `testnet`.
`transaction-archive.json` retains public deployment, funding, and settlement XDR
with decoded events and authorization trees before finite RPC retention expires.
These are public ledger records, not private signing traces.

Verify while the transactions remain available from the configured RPC:

```sh
shasum -a 256 -c deployments/month-two/canary-evidence.json.sha256
corepack pnpm@11.9.0 --filter @trionlabs/8183-console verify:canary ../../deployments/month-two/canary-evidence.json GC2OHQG6JNXJYV36A4Q7NOUIVEUZZYPFYH747H6C3AWXQII2WCOVSFSS
```

The read-only verifier authenticates terminal jobs, successful referenced
transactions, exact-budget payout/refund events, and deployed code. It checks
the arithmetic of captured balances; it does not authenticate their absolute
historical values by ledger proofs. An expired RPC record fails live verification;
the archive preserves the original public response for subsequent review.
