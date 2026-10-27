# Mainnet Canary Runbook

This procedure deploys and exercises the pinned 8183 kernel and SLA hook from a local terminal. It does not use the Console UI or a browser wallet. The Chapter Lead has accepted a valueless Mainnet canary as the month-two deliverable; this exception does not authorize valuable assets or production use.

## Safety Boundary

- Real XLM is used only for account reserves and transaction fees.
- `DEMO8183` is a new, non-redeemable asset with no claim of value.
- Do not use USDC, distribute `DEMO8183`, or reuse production accounts.
- The recovered account is retained as the funding-only `canary-admin` alias. It transfers at most 16 XLM to fresh `canary-deployer`, `canary-client`, `canary-provider`, and `canary-evaluator` accounts and is never assigned a contract or job role. Generated canary keys use the OS secure store. Imported raw `S...` keys and 32-byte hexadecimal Ed25519 seeds use Stellar CLI's permission-restricted, ignored identity file because secure-store import currently accepts seed phrases only. Ethereum/secp256k1 private keys are not Stellar account keys.
- Never place a seed, secret key, or signing command in `.env`.

## Recommended Procedure

From the repository root, run:

```bash
./scripts/mainnet-canary-wizard.sh
```

The wizard imports one funding identity through a hidden CLI prompt, generates four isolated canary identities, transfers a capped 16 XLM into them, validates the reproducible build, presents a deterministic plan before deployment, requires confirmation for each group of Mainnet writes, and verifies the final public evidence.

For manual operation, use the same sequence:

```bash
pnpm --filter @trionlabs/8183-console setup:mainnet --fund-mainnet-roles
pnpm --filter @trionlabs/8183-console preflight:mainnet check
pnpm --filter @trionlabs/8183-console deploy:mainnet --prepare-plan
pnpm --filter @trionlabs/8183-console deploy:mainnet --execute-valueless-mainnet-canary
pnpm --filter @trionlabs/8183-console canary:mainnet --execute-valueless-mainnet-canary
pnpm --filter @trionlabs/8183-console assemble:canary artifacts/mainnet-canary
pnpm --filter @trionlabs/8183-console verify:canary artifacts/mainnet-canary/canary-evidence.json "$(stellar --config-dir .stellar/mainnet-canary keys address canary-client)"
```

The deployment command creates trustlines, issues exactly enough `DEMO8183` to bring the client canary account to 10 units, deploys deterministic contracts, verifies their bytecode and constructor state, and admits only the recorded SLA hook. Reruns reuse and verify the same contract IDs rather than silently creating replacements.

## Outputs

Local identities, deployment material, and captured evidence are written under `.stellar/mainnet-canary/` and `artifacts/mainnet-canary/`; both locations are ignored by Git. Review the evidence before publishing selected files. The generated evidence is explicitly `author-run` and must not be represented as independent customer-pilot evidence.
