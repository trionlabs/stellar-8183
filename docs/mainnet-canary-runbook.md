# Mainnet Canary Runbook

This procedure deploys and exercises the pinned 8183 kernel and SLA hook from a local terminal. It does not use the Console UI or a browser wallet. Mainnet operations remain blocked until the source-bound authorization record contains real Chapter Lead, independent-audit, and threat-model references.

## Safety Boundary

- Real XLM is used only for account reserves and transaction fees.
- `DEMO8183` is a new, non-redeemable asset with no claim of value.
- Do not use USDC, distribute `DEMO8183`, or reuse production accounts.
- Signing keys must be OS secure-store identities named `canary-admin`, `canary-client`, `canary-provider`, and `canary-evaluator`.
- Never place a seed, secret key, or signing command in `.env`.

## Recommended Procedure

From the repository root, run:

```bash
./scripts/mainnet-canary-wizard.sh
```

The wizard validates authorization before credential setup, guides secure-store identity creation/import, verifies funding, presents a deterministic plan before any deployment, requires confirmation for each group of Mainnet writes, and verifies the final public evidence.

For manual operation, use the same sequence:

```bash
pnpm --filter @trionlabs/8183-console preflight:mainnet review
pnpm --filter @trionlabs/8183-console preflight:mainnet check
pnpm --filter @trionlabs/8183-console deploy:mainnet --prepare-plan
pnpm --filter @trionlabs/8183-console deploy:mainnet --execute-valueless-mainnet-canary
pnpm --filter @trionlabs/8183-console canary:mainnet --execute-valueless-mainnet-canary
pnpm --filter @trionlabs/8183-console assemble:canary artifacts/mainnet-canary
pnpm --filter @trionlabs/8183-console verify:canary artifacts/mainnet-canary/canary-evidence.json "$(stellar --config-dir .stellar/mainnet-canary keys address canary-client)"
```

The deployment command creates trustlines, issues exactly enough `DEMO8183` to bring the client canary account to 10 units, deploys deterministic contracts, verifies their bytecode and constructor state, and admits only the recorded SLA hook. Reruns reuse and verify the same contract IDs rather than silently creating replacements.

## Outputs

Private authorization stays under `deployments/private/`. Local deployment material and captured evidence are written under `artifacts/mainnet-canary/`; both locations are ignored by Git. Review the evidence before publishing selected files. The generated evidence is explicitly `author-run` and must not be represented as independent customer-pilot evidence.
