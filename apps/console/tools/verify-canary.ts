import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Account,
  Address,
  Contract,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import { parseCanaryEvidence } from "../src/canary.js";
import {
  LiveCommerce,
  verifyOnChain,
  hasSettlementEvent,
} from "../src/live.js";
import { digest } from "../src/receipt.js";
import { verifyBuildProvenance } from "./provenance.js";

const [evidencePath, readerAddress] = process.argv.slice(2);
if (!evidencePath || !readerAddress)
  throw new Error(
    "Usage: pnpm verify:canary <evidence.json> <public G-account>",
  );
const evidence = await parseCanaryEvidence(
  await readFile(evidencePath, "utf8"),
);
await verifyBuildProvenance(evidence, resolve(import.meta.dirname, "../../.."));
const reader = new LiveCommerce(evidence.profile, {
  address: readerAddress,
  sign: async () => {
    throw new Error("Read-only verifier cannot sign.");
  },
});
const [kernelWasm, hookWasm] = await Promise.all([
  reader.server.getContractWasmByContractId(evidence.profile.kernel),
  reader.server.getContractWasmByContractId(evidence.hook),
]);
if (
  (await digest(kernelWasm)) !== evidence.kernelWasmSha256 ||
  (await digest(hookWasm)) !== evidence.hookWasmSha256
)
  throw new Error("Deployed Wasm hash does not match evidence.");
await reader.tokenInfo();
for (const [name, hash] of Object.entries(evidence.deploymentTransactions)) {
  const result = await reader.server.getTransaction(hash);
  if (result.status !== "SUCCESS")
    throw new Error(
      `${name} transaction is not available as a successful RPC result. Archive evidence is required after RPC retention expires.`,
    );
  const tx = TransactionBuilder.fromXDR(
    result.envelopeXdr,
    evidence.profile.networkPassphrase,
  );
  if (
    !(tx instanceof Transaction) ||
    tx.hash().toString("hex") !== hash ||
    tx.operations.length !== 1
  )
    throw new Error(`Unexpected ${name} transaction.`);
  const operation = tx.operations[0];
  if (operation?.type !== "invokeHostFunction")
    throw new Error(`${name} is not a Soroban transaction.`);
  if (name === "admission") {
    if (operation.func.switch().name !== "hostFunctionTypeInvokeContract")
      throw new Error("Hook admission is not a contract call.");
    const call = operation.func.invokeContract();
    if (
      Address.fromScAddress(call.contractAddress()).toString() !==
        evidence.profile.kernel ||
      call.functionName().toString() !== "set_hook" ||
      scValToNative(call.args()[0]!) !== evidence.hook ||
      scValToNative(call.args()[1]!) !== true
    )
      throw new Error("Hook admission does not match evidence.");
  } else {
    if (
      operation.func.switch().name !== "hostFunctionTypeCreateContractV2" ||
      !result.returnValue ||
      scValToNative(result.returnValue) !==
        (name === "kernel" ? evidence.profile.kernel : evidence.hook)
    )
      throw new Error(
        `${name} deployment does not create the stated contract.`,
      );
  }
}
const hookCall = new TransactionBuilder(new Account(readerAddress, "0"), {
  fee: "100",
  networkPassphrase: evidence.profile.networkPassphrase,
})
  .addOperation(new Contract(evidence.hook).call("get_core"))
  .setTimeout(60)
  .build();
const hookResult = await reader.server.simulateTransaction(hookCall);
if (
  !rpc.Api.isSimulationSuccess(hookResult) ||
  !hookResult.result ||
  scValToNative(hookResult.result.retval) !== evidence.profile.kernel
)
  throw new Error("SLA hook is not bound to the kernel.");
for (const receipt of evidence.receipts) {
  console.log(
    `job ${receipt.receipt.jobId}: ${await verifyOnChain(receipt, evidence.profile, reader)}`,
  );
  const tx = await reader.server.getTransaction(
    receipt.receipt.terminalTransaction.hash,
  );
  if (tx.status !== "SUCCESS" || !hasSettlementEvent(receipt, tx))
    throw new Error(
      "Missing exact-budget payout/refund event. An Open-state rejection is not a funded rejection.",
    );
  const accounting = evidence.balanceAccounting.find(
    (b) => b.jobId === receipt.receipt.jobId,
  )!;
  const funding = await reader.server.getTransaction(
    accounting.fundingTransaction,
  );
  if (funding.status !== "SUCCESS")
    throw new Error("Funding transaction is unavailable or unsuccessful.");
  const fundedTx = TransactionBuilder.fromXDR(
    funding.envelopeXdr,
    evidence.profile.networkPassphrase,
  );
  if (
    !(fundedTx instanceof Transaction) ||
    fundedTx.hash().toString("hex") !== accounting.fundingTransaction ||
    fundedTx.operations.length !== 1
  )
    throw new Error("Invalid funding envelope.");
  const op = fundedTx.operations[0];
  if (
    op?.type !== "invokeHostFunction" ||
    op.func.switch().name !== "hostFunctionTypeInvokeContract"
  )
    throw new Error("Funding is not a contract call.");
  const call = op.func.invokeContract();
  if (
    Address.fromScAddress(call.contractAddress()).toString() !==
      evidence.profile.kernel ||
    call.functionName().toString() !== "fund" ||
    !call.args()[0] ||
    !call.args()[1] ||
    scValToNative(call.args()[0]!) !== BigInt(receipt.receipt.jobId) ||
    scValToNative(call.args()[1]!) !== BigInt(receipt.receipt.budget) ||
    funding.ledger > tx.ledger
  )
    throw new Error("Funding does not match the stated job and budget.");
}
console.log(
  "Canary code, token, deployments, hook admission, and three terminal paths verified. This is author-run compatibility evidence; independent customer participation is not asserted.",
);
