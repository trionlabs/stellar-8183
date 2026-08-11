# Testnet lifecycle demo

This Node-only demonstrator runs four real scenarios with distinct admin,
client, provider, evaluator, and fee-paying facilitator accounts:

1. permissionless expiry refund;
2. client rejection from `Open`;
3. evaluator rejection from `Funded`;
4. provider-negotiated completion.

All role approvals are signed Soroban auth entries. The facilitator refreshes
its account sequence, enforcing-simulates those signed entries, verifies the
final envelope, and submits it. Refund and rejection run first so the same
testnet USDC can be reused before completion. Refund timing is based on the
RPC-reported latest-ledger close time, not the local clock.

Startup refuses mismatched deployment inputs: the kernel admin/token, admitted
SLA hook, hook core, configured review window, and token decimals are all read
back on-chain before the first job is created.

`DEPLOYMENT_EVIDENCE_INPUT` must contain an ordered JSON array with the original
fully decoded kernel deployment, SLA-hook deployment, and hook-admission
transactions. Startup verifies their labels, methods, contract IDs, and admin
source and includes them in the raw capture.

Create that input immediately after deployment while RPC retains all three
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

Build the workspace, copy the documented `.env.example` values into
`apps/demo/.env`, then run:

```sh
pnpm --filter @trionlabs/stellar-8183-demo start:testnet
```

The five secret seeds are read only to construct in-process demo callbacks.
They are never logged or copied into evidence. The output is a secret-safe raw
capture (`stellar-8183/raw-testnet-capture/v1`), which release tooling combines
with deterministic build/deployment/publication data for the final evidence
schema. `RAW_EVIDENCE_OUTPUT` selects this demo capture; `EVIDENCE_OUTPUT` is
reserved for the separately assembled, schema-validated release manifest. The
demo refuses to overwrite an existing raw output and atomically checkpoints
after each finalized transaction, job snapshot, and scenario balance summary.
A partial checkpoint is an audit/recovery aid, not valid release evidence. The
demo queries the token's on-chain `decimals()` value and refuses to proceed
unless it is exactly seven.
