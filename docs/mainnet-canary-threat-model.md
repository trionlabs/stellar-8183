# Mainnet canary threat-model update

Status: preparation only. No mainnet contract, asset, signer, or transaction has
been created by the month-two implementation. This document does not override
`AGENTS.md` or `docs/security.md`: an independent audit and explicit threat-model
review remain prerequisites. The Chapter Lead must separately accept whether a
valueless canary satisfies the grant's mainnet deliverable.

## Boundary and purpose

The proposed canary demonstrates that the pinned v0.1 kernel and SLA hook deploy
and execute on Stellar mainnet. It does not establish production safety,
independent evaluator judgment, customer demand, or permission to custody USDC.
Only dedicated operator-controlled accounts and a non-redeemable DEMO8183 asset
would participate. The customer pilot remains on testnet.

The contract source and ABI stay unchanged. Kernel code and its payment token
are immutable; hook admission is administered separately. No FROST committee,
arbitration, reputation writeback, or third-party website integration is added.

## Threats and controls

| Boundary | Failure or abuse | Required control |
| --- | --- | --- |
| Asset selection | Valuable token bound permanently, misleading symbol, or accidental valuable transfer | Independently verify the SAC contract ID from asset code, issuer, and public network; inspect issuer flags; use a dedicated asset with no sale, redemption, distribution, or monetary claim. A symbol is not proof. Never use USDC or an existing valuable asset. |
| Source and Wasm | Stale/local input or different deployed code | Pin source and toolchain; reject changed/untracked build inputs; reproduce optimized bytes twice; compare local and fetched kernel/hook SHA-256 hashes. Retain deployment creation transactions. |
| Wallet and network | Wrong account, network, terms, or excessive fees signed | Use fresh mainnet-only canary accounts, explicitly acknowledged network profiles, exact invocation/source/argument checks, bounded fees and time, and wallet review. Keep secrets outside the app and evidence. Budget XLM fees/reserves separately. |
| Evaluator | Bad approval, malicious rejection, or inactivity | Disclose the evaluator's unilateral authority. Use operator roles for compatibility testing; do not claim independent evaluation. Test expired refund separately. |
| Hook | Hook failure, wrong kernel binding, or excessive resources | Deploy the pinned SLA hook, verify `get_core`, admit only that hook for the canary, record admission, and inspect its review window. Refund dispatch must remain outside hooks. |
| Recipient and issuer | Removed trustline, authorization revocation, freeze, or blocked payout | Verify client/provider trustlines and authorization before funding and before the outcome. Preserve the client's ability to receive a refund. Permissionless invocation does not bypass token restrictions. |
| Storage and RPC | Archived state/code, stale simulation, missing transaction evidence | Use short supported expiries, retain funded state beyond expiry, freshly simulate and handle restoration under the existing policy, and capture transaction/state/event evidence promptly. RPC availability is not guaranteed. |
| Optional 8004 lookup | Unavailable registry or provider wallet changes | Check network/registry/ID and reread the wallet before funding; record an advisory snapshot. The read is not atomic with funding. Direct addresses remain available; settlement never consults the registry. |
| Browser and hosting | Compromised origin, dependency, profile, or injected description | Serve the reviewed static build over HTTPS, verify build metadata, escape rendered text, avoid arbitrary metadata fetches, and validate profiles/receipts. Keep the dependency limitations in `dependency-audit.md` visible. |

The Console trusts the configured RPC and signing extension. The read-only
evidence verifier also trusts its RPC. Captured balance snapshots are
observations with arithmetic checks; successful funding/payout events bind the
transfers, not the absolute historical balance observations.

## Predeployment record

The operator/reviewer must supply actual references for:

- Independent audit and threat-model review, including unresolved findings.
- Chapter Lead acceptance of the valueless-canary deliverable.
- Pinned source commit, toolchain, reproducible build outputs, and secret scans.
- Asset code, issuer, SAC ID, network, flags, distribution boundary, and purpose.
- Dedicated public role addresses, trustlines, and fee/reserve budget.
- Kernel/hook IDs, constructor arguments, fetched hashes, and hook admission.
- A separate acknowledged `mainnet-canary` Console profile.

Do not infer approval from blank fields, a successful build, an author-run test,
or the fact that the app supports a mainnet profile.

## Completion evidence and failure response

After the prerequisites are met, demonstrate completion, rejection of an
already-funded job, and expired refund. Publish mainnet-specific contract IDs,
transaction links, receipts, decoded events/authorizations, observed balances,
and the versioned evidence manifest. Run `verify:canary`; do not reuse or relabel
the testnet bundle. Record that the run is author-controlled.

If any invariant or verification fails, stop creating/funding jobs, retain public
failure evidence without secrets, and use permissionless expiry refunds where
recipient conditions allow. Immutable contracts have no administrative sweep or
rollback. A redeployment is a new contract and must not be presented as repair of
the old address. Valuable-asset launch remains outside this sprint.
