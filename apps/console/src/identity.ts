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
  if (binding.network !== profile.id || binding.provider !== provider)
    throw new Error(
      "The imported agent wallet no longer matches this job's provider. Resolve the identity again or explicitly use the direct-address path.",
    );
  contract(binding.identityRegistry);
}
