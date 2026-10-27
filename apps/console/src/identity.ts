import {
  Account,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  address,
  contract,
  uint,
  type AgentBinding,
  type AgentRef,
  type Profile,
} from "./model.js";

// Canonical Stellar8004 v0.1 deployments from the upstream SDK config at
// trionlabs/stellar-8004 commit 5920792f5fd1467c9bb9f9f801ac579dbfdf59e3.
export const STELLAR_8004_IDENTITY_REGISTRIES = Object.freeze({
  testnet: "CDE3K4COIAGWNNJQQLL26SYI3KBJF5FUDHXG5FA6GYDJCG7T5V7FIWZH",
  "mainnet-canary": "CBGPDCJIHQ32G42BE7F2CIT3YW6XRN5ED6GQJHCRZSNAYH6TGMCL6X35",
}) satisfies Readonly<Record<Profile["id"], string>>;

export function defaultIdentityRegistry(network: Profile["id"]): string {
  return contract(STELLAR_8004_IDENTITY_REGISTRIES[network]);
}

export async function resolveAgent(
  profile: Profile,
  reference: AgentRef,
  source: string,
): Promise<AgentBinding> {
  if (reference.network !== profile.id)
    throw new Error("Agent identity belongs to a different network.");
  contract(reference.identityRegistry);
  const id = uint(reference.agentId);
  if (id > 0xffff_ffffn)
    throw new Error("The Stellar 8004 v0.1 profile uses a u32 agent ID.");
  const server = new rpc.Server(profile.rpcUrl, {
    allowHttp: profile.rpcUrl.startsWith("http:"),
  });
  const tx = new TransactionBuilder(new Account(source, "0"), {
    networkPassphrase: profile.networkPassphrase,
    fee: "100",
  })
    .addOperation(
      new Contract(reference.identityRegistry).call(
        "get_agent_wallet",
        nativeToScVal(Number(id), { type: "u32" }),
      ),
    )
    .setTimeout(60)
    .build();
  const result = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(result) || !result.result)
    throw new Error(
      "Identity lookup failed. The registry may need restoration. Use a direct provider address or try again later.",
    );
  const provider: unknown = scValToNative(result.result.retval);
  if (typeof provider !== "string")
    throw new Error("This agent has no bound wallet.");
  return {
    ...reference,
    provider: address(provider),
    resolvedAtLedger: result.latestLedger,
  };
}

export function assertBinding(
  profile: Profile,
  binding: AgentBinding,
  provider: string,
): void {
  const fields = [
    "network",
    "identityRegistry",
    "agentId",
    "provider",
    "resolvedAtLedger",
  ];
  if (
    !binding ||
    Object.keys(binding).sort().join() !== fields.sort().join() ||
    !Number.isSafeInteger(binding.resolvedAtLedger) ||
    binding.resolvedAtLedger <= 0 ||
    uint(binding.agentId) > 0xffff_ffffn
  )
    throw new Error("Invalid saved agent binding.");
  if (binding.network !== profile.id || binding.provider !== provider)
    throw new Error(
      "The imported agent wallet no longer matches this job's provider. Resolve the identity again or explicitly use the direct-address path.",
    );
  contract(binding.identityRegistry);
  address(binding.provider);
}
