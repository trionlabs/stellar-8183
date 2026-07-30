# `@trionlabs/stellar-8183`

TypeScript client for the Soroban Agentic Commerce kernel. The package wraps
the complete contract ABI and implements a strict multi-party relay workflow:
role accounts sign Soroban authorization entries, while a distinct facilitator
pays the transaction fee and submits the envelope.

## Client setup

The package constructs its checked-in Stellar CLI 27 generated client locally;
startup does not fetch the deployed Wasm specification:

```ts
import { AgenticCommerce } from "@trionlabs/stellar-8183";

const commerce = await AgenticCommerce.connect({
  contractId,
  networkPassphrase,
  publicKey: facilitatorAddress,
  rpcUrl,
});
```

Another compatible generated Stellar contract client can still be injected
without changing application code:

```ts
const commerce = AgenticCommerce.fromClient(generatedClient);
```

Mutation methods only prepare and simulate. They never sign or submit the
requested invocation implicitly. The generated client's separate
`restoreFootprint` fallback is disabled by default (`restore: false`). If
simulation requests that fallback, opt in only with ledger keys derived
independently of the untrusted restoration request, a complete-transaction fee
ceiling, a short lifetime ceiling, the expected network, and the expected
facilitator signer:

```ts
const invocation = await commerce.claimRefund(jobId, {
  source: facilitator.address,
  restore: {
    signer: facilitator,
    networkPassphrase,
    expectedLedgerKeyXdr: trustedLedgerKeyXdr,
    maxFee: "10000000",
    maxTransactionLifetimeSeconds: 300,
  },
});
```

The SDK wraps that policy with `createGuardedRestoreSigner`. It accepts only one
source-less `restoreFootprint` operation, an exact read-write footprint with no
read-only keys, finite time bounds, consistent Soroban resource data, and the
configured fee ceiling. It also verifies that the wallet preserved the
transaction body and added exactly one valid facilitator signature. Stellar
SDK 16.2 may then submit the separate restoration transaction and freshly
simulate the requested invocation. Never populate the trusted key allowlist
from the same RPC response that requested restoration.

This separate restore-preamble policy is distinct from Protocol 23
same-envelope restoration already present in a successfully simulated invoke
transaction. `prepareRelay` canonicalizes the complete read-only/read-write
footprint and resolves archived-entry indices to their exact read-write ledger
keys in `RelayIntent.footprint`. Client and facilitator validation reject any
later footprint or archived-key-list change. `restore: false` does not remove
those same-envelope entries. A caller that bypasses the relay must inspect and
policy-check the final prepared envelope itself.

## Relayed authorization

```ts
import {
  StellarRelayRpc,
  authorizeRelay,
  facilitateRelay,
  prepareRelay,
} from "@trionlabs/stellar-8183";

const invocation = await commerce.submit(
  { id: 1n, workHash },
  { source: facilitator.address },
);
const rpc = new StellarRelayRpc(rpcUrl);
const { request, intent } = prepareRelay(invocation, {
  maxFee: "10000000",
});
const authorized = await authorizeRelay({
  adapter: commerce.adapter,
  rpc,
  request,
  intent,
  signer: provider,
});
const receipt = await facilitateRelay({
  adapter: commerce.adapter,
  rpc,
  request: authorized,
  intent,
  facilitator,
});
```

`intent` is trusted policy, not merely request metadata. Keep it locally or
transport it over an authenticated channel. Each stage verifies the network,
source, finite time bounds, fee ceiling, contract/function/argument XDR,
authorization identities/nonces/invocation trees, auth expiry, full ledger-key
footprint, and Protocol 23 archived-entry key set. Before submission the
facilitator rebuilds the exact signed-auth invoke operation with its freshly
fetched account sequence, re-simulates in enforcing mode, and verifies the
final Ed25519 envelope signature. Receipts include authorizers, argument and
envelope SHA-256 commitments, decoded contract events, close timestamps,
declared instructions, read/write bytes and footprint entries, resource fee,
inclusion fee, and total fee.

The initial recording simulation and its RPC are a trust boundary because they
select the first footprint that `prepareRelay` records. For higher-value use,
derive expected keys independently or compare multiple trusted RPCs. Enforcing
simulation may legitimately update resource scalar estimates while preserving
the invocation, authorization roots, and pinned key sets; `maxFee` remains the
hard economic ceiling for the final transaction.

The SDK accepts SEP-43-compatible signing callbacks and never accepts or stores
secret keys.

`EvidenceRecorder` produces only a secret-whitelisted
`stellar-8183/raw-testnet-capture/v1` capture. It is not the final release
manifest; release tooling adds build, deployment, publication, and attestation
data before validating `docs/evidence.schema.json`. The demo additionally
records client/provider/evaluator/escrow token deltas around every submitted
transaction.
