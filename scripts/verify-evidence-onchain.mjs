#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateEvidenceSemantics } from "./validate-evidence.mjs";

function fail(hash, message) {
  throw new Error(
    `on-chain evidence verification failed for ${hash}: ${message}`,
  );
}

function requireEqual(actual, expected, hash, field) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      hash,
      `${field} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashArguments(args) {
  const framed = [];
  for (const argument of args) {
    const bytes = argument.toXDR();
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    framed.push(length, bytes);
  }
  return sha256(Buffer.concat(framed));
}

function toEventValue(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex");
  }
  if (Array.isArray(value)) {
    return value.map(toEventValue);
  }
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, entry]) => [
        String(key),
        toEventValue(entry),
      ]),
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toEventValue(entry)]),
    );
  }
  return String(value);
}

function decodeContractEvent(eventXdr, sdk, hash) {
  let event;
  try {
    event = sdk.xdr.ContractEvent.fromXDR(eventXdr, "base64");
  } catch {
    fail(hash, "RPC returned malformed contract event XDR");
  }
  const rawContractId = event.contractId();
  if (rawContractId === null) {
    fail(hash, "contract event omitted its contract ID");
  }
  const body = event.body().v0();
  const topics = body.topics().map((topic) => sdk.scValToNative(topic));
  const firstTopic = topics[0];
  return {
    contractId: sdk.Address.contract(Buffer.from(rawContractId)).toString(),
    name: typeof firstTopic === "string" ? firstTopic : "contract_event",
    decoded: {
      topics: topics.slice(1).map(toEventValue),
      data: toEventValue(sdk.scValToNative(body.data())),
    },
  };
}

function returnValueXdr(result, sdk, hash) {
  if (typeof result.resultMetaXdr !== "string") {
    fail(hash, "RPC response omitted resultMetaXdr");
  }
  let metadata;
  try {
    metadata = sdk.xdr.TransactionMeta.fromXDR(result.resultMetaXdr, "base64");
  } catch {
    fail(hash, "RPC returned malformed resultMetaXdr");
  }
  if (metadata.switch() !== 3 && metadata.switch() !== 4) {
    fail(hash, `unsupported transaction metadata version ${metadata.switch()}`);
  }
  const sorobanMetadata = metadata.value().sorobanMeta();
  if (sorobanMetadata === null) {
    fail(hash, "successful Soroban transaction omitted Soroban metadata");
  }
  const returnValue = sorobanMetadata.returnValue();
  return returnValue === null ? undefined : returnValue.toXDR("base64");
}

export function verifyResultEvidence(result, raw, sdk) {
  const retainedEvents = result.events?.contractEventsXdr;
  if (!Array.isArray(retainedEvents)) {
    fail(raw.hash, "RPC response omitted contract event XDR");
  }
  const contractEventsXdr = retainedEvents.flat();
  requireEqual(
    contractEventsXdr,
    raw.contractEventsXdr,
    raw.hash,
    "contractEventsXdr",
  );
  requireEqual(
    contractEventsXdr.map((event) => decodeContractEvent(event, sdk, raw.hash)),
    raw.decodedEvents,
    raw.hash,
    "decodedEvents",
  );
  requireEqual(
    returnValueXdr(result, sdk, raw.hash),
    raw.returnValueXdr,
    raw.hash,
    "returnValueXdr",
  );
}

function requireNativeEqual(actual, expected, hash, field) {
  const normalize = (value) => {
    if (value instanceof Uint8Array) {
      return Buffer.from(value).toString("hex");
    }
    if (typeof value === "bigint" || Number.isSafeInteger(value)) {
      return value.toString();
    }
    return value;
  };
  requireEqual(normalize(actual), normalize(expected), hash, field);
}

function verifyScenarioArguments(invocation, raw, context, sdk) {
  const args = invocation.args().map((argument) => sdk.scValToNative(argument));
  if (context.kind === "admit_hook") {
    requireEqual(args.length, 2, raw.hash, "set_hook argument count");
    requireNativeEqual(args[0], context.hookId, raw.hash, "set_hook.hook");
    requireNativeEqual(args[1], true, raw.hash, "set_hook.allowed");
    return;
  }

  const { scenario, transactionIndex, identities, hookId } = context;
  const snapshot = scenario.job_snapshots[transactionIndex];
  if (raw.method === "create_job") {
    requireEqual(args.length, 6, raw.hash, "create_job argument count");
    requireNativeEqual(
      args[0],
      identities.client,
      raw.hash,
      "create_job.client",
    );
    requireNativeEqual(args[1], undefined, raw.hash, "create_job.provider");
    requireNativeEqual(
      args[2],
      identities.evaluator,
      raw.hash,
      "create_job.evaluator",
    );
    requireNativeEqual(
      args[3],
      snapshot.expires_at,
      raw.hash,
      "create_job.expires_at",
    );
    requireEqual(
      sha256(Buffer.from(args[4], "utf8")),
      snapshot.description_sha256,
      raw.hash,
      "create_job.description",
    );
    requireNativeEqual(args[5], hookId, raw.hash, "create_job.hook");
    return;
  }

  requireNativeEqual(args[0], scenario.job_id, raw.hash, `${raw.method}.id`);
  if (raw.method === "claim_refund") {
    requireEqual(args.length, 1, raw.hash, "claim_refund argument count");
    return;
  }
  if (raw.method === "set_provider") {
    requireEqual(args.length, 3, raw.hash, "set_provider argument count");
    requireNativeEqual(
      args[1],
      identities.provider,
      raw.hash,
      "set_provider.provider",
    );
    requireNativeEqual(
      Buffer.from(args[2]).length,
      0,
      raw.hash,
      "set_provider.opt",
    );
    return;
  }
  if (raw.method === "set_budget") {
    requireEqual(args.length, 4, raw.hash, "set_budget argument count");
    requireNativeEqual(
      args[1],
      raw.authorizers[0],
      raw.hash,
      "set_budget.actor",
    );
    requireNativeEqual(
      args[2],
      snapshot.budget_base_units,
      raw.hash,
      "set_budget.amount",
    );
    requireNativeEqual(
      Buffer.from(args[3]).length,
      0,
      raw.hash,
      "set_budget.opt",
    );
    return;
  }
  if (raw.method === "fund") {
    requireEqual(args.length, 3, raw.hash, "fund argument count");
    requireNativeEqual(
      args[1],
      snapshot.budget_base_units,
      raw.hash,
      "fund.expected_budget",
    );
    requireNativeEqual(Buffer.from(args[2]).length, 0, raw.hash, "fund.opt");
    return;
  }
  if (raw.method === "submit") {
    requireEqual(args.length, 3, raw.hash, "submit argument count");
    requireNativeEqual(
      args[1],
      snapshot.deliverable_hash,
      raw.hash,
      "submit.work_hash",
    );
    requireNativeEqual(Buffer.from(args[2]).length, 0, raw.hash, "submit.opt");
    return;
  }
  if (raw.method === "complete" || raw.method === "reject") {
    requireEqual(args.length, 3, raw.hash, `${raw.method} argument count`);
    requireNativeEqual(
      args[1],
      snapshot.decision_hash,
      raw.hash,
      `${raw.method}.reason`,
    );
    requireNativeEqual(
      Buffer.from(args[2]).length,
      0,
      raw.hash,
      `${raw.method}.opt`,
    );
    return;
  }
  fail(raw.hash, `no high-level argument policy exists for ${raw.method}`);
}

async function rpc(url, method, params, id) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!response.ok) {
    throw new Error(`RPC ${method} returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.error !== undefined) {
    throw new Error(
      `RPC ${method} failed: ${payload.error.code} ${payload.error.message}`,
    );
  }
  return payload.result;
}

function loadStellarSdk() {
  try {
    const requireFromSdk = createRequire(resolve("packages/sdk/package.json"));
    return requireFromSdk("@stellar/stellar-sdk");
  } catch (cause) {
    throw new Error(
      "install the pinned workspace dependencies before live XDR verification",
      { cause },
    );
  }
}

function addressAuthorizers(operation, sdk) {
  const addresses = [];
  for (const entry of operation.auth ?? []) {
    const address = sdk.inspectAuthEntry(entry).address;
    if (address !== null) {
      addresses.push(address);
    }
  }
  return [...new Set(addresses)].sort();
}

function deploymentContractId(preimage, networkPassphrase, sdk) {
  const hashPreimage = sdk.xdr.HashIdPreimage.envelopeTypeContractId(
    new sdk.xdr.HashIdPreimageContractId({
      networkId: sdk.hash(Buffer.from(networkPassphrase)),
      contractIdPreimage: preimage,
    }),
  );
  return sdk.StrKey.encodeContract(sdk.hash(hashPreimage.toXDR()));
}

function verifyDeploymentOperation(
  operation,
  raw,
  sdk,
  networkPassphrase,
  expectedWasmSha256,
) {
  const hostFunction = operation.func;
  requireEqual(
    hostFunction.switch().value,
    sdk.xdr.HostFunctionType.hostFunctionTypeCreateContractV2().value,
    raw.hash,
    "deployment host function",
  );
  requireEqual(raw.method, "__constructor", raw.hash, "deployment method");

  const deployment = hostFunction.createContractV2();
  requireEqual(
    deployment.executable().switch().value,
    sdk.xdr.ContractExecutableType.contractExecutableWasm().value,
    raw.hash,
    "deployment executable",
  );
  requireEqual(
    deployment.executable().wasmHash().toString("hex"),
    expectedWasmSha256,
    raw.hash,
    "deployment Wasm hash",
  );
  requireEqual(
    hashArguments(deployment.constructorArgs()),
    raw.argumentsSha256,
    raw.hash,
    "constructor argumentsSha256",
  );

  const preimage = deployment.contractIdPreimage();
  requireEqual(
    preimage.switch().value,
    sdk.xdr.ContractIdPreimageType.contractIdPreimageFromAddress().value,
    raw.hash,
    "contract ID preimage type",
  );
  requireEqual(
    sdk.Address.fromScAddress(preimage.fromAddress().address()).toString(),
    raw.source,
    raw.hash,
    "contract ID preimage address",
  );
  requireEqual(
    deploymentContractId(preimage, networkPassphrase, sdk),
    raw.contractId,
    raw.hash,
    "derived contract ID",
  );
}

export function verifyInvokeOperation(
  operation,
  raw,
  sdk,
  networkPassphrase,
  expectedWasmSha256,
  argumentContext,
) {
  requireEqual(
    operation.type,
    "invokeHostFunction",
    raw.hash,
    "operation.type",
  );
  requireEqual(operation.source, undefined, raw.hash, "operation.source");
  const hostFunction = operation.func;
  if (
    hostFunction.switch().value !==
    sdk.xdr.HostFunctionType.hostFunctionTypeInvokeContract().value
  ) {
    if (!raw.label.startsWith("deploy_")) {
      fail(raw.hash, "non-deployment transaction is not invoke-contract");
    }
    verifyDeploymentOperation(
      operation,
      raw,
      sdk,
      networkPassphrase,
      expectedWasmSha256,
    );
    requireEqual(
      addressAuthorizers(operation, sdk),
      [...raw.authorizers].sort(),
      raw.hash,
      "authorizers",
    );
    return;
  }
  if (raw.label.startsWith("deploy_")) {
    fail(raw.hash, "deployment transaction invokes an existing contract");
  }

  const invocation = hostFunction.invokeContract();
  requireEqual(
    sdk.Address.fromScAddress(invocation.contractAddress()).toString(),
    raw.contractId,
    raw.hash,
    "contractId",
  );
  requireEqual(
    invocation.functionName().toString(),
    raw.method,
    raw.hash,
    "method",
  );
  requireEqual(
    hashArguments(invocation.args()),
    raw.argumentsSha256,
    raw.hash,
    "argumentsSha256",
  );
  requireEqual(
    addressAuthorizers(operation, sdk),
    [...raw.authorizers].sort(),
    raw.hash,
    "authorizers",
  );
  if (argumentContext !== undefined) {
    verifyScenarioArguments(invocation, raw, argumentContext, sdk);
  }
}

function verifyResources(transaction, raw) {
  const extension = transaction.toEnvelope().v1().tx().ext();
  if (extension.switch() !== 1) {
    fail(raw.hash, "transaction has no Soroban resource extension");
  }
  const data = extension.sorobanData();
  const resources = data.resources();
  const declared = BigInt(data.resourceFee().toString());
  const total = BigInt(transaction.fee);
  requireEqual(
    {
      instructions: resources.instructions(),
      readBytes: resources.diskReadBytes(),
      writeBytes: resources.writeBytes(),
      readOnlyEntries: resources.footprint().readOnly().length,
      readWriteEntries: resources.footprint().readWrite().length,
      declaredResourceFee: declared.toString(),
      inclusionFee: (total - declared).toString(),
      totalFee: total.toString(),
    },
    raw.resources,
    raw.hash,
    "resources",
  );
}

export async function verifyEvidenceOnchain(evidence, raw, rawBytes) {
  validateEvidenceSemantics(evidence, raw, rawBytes);
  const sdk = loadStellarSdk();
  let requestId = 1;
  const argumentContexts = new Map();
  argumentContexts.set(evidence.contracts.hook_admission_transaction.hash, {
    kind: "admit_hook",
    hookId: evidence.contracts.sla_hook.contract_id,
  });
  for (const scenario of evidence.scenarios) {
    scenario.transactions.forEach((transaction, transactionIndex) => {
      argumentContexts.set(transaction.hash, {
        kind: "scenario",
        scenario,
        transactionIndex,
        identities: evidence.identities,
        hookId: evidence.contracts.sla_hook.contract_id,
      });
    });
  }

  for (const transaction of raw.transactions) {
    const result = await rpc(
      evidence.network.rpc_url,
      "getTransaction",
      { hash: transaction.hash },
      requestId++,
    );
    requireEqual(result.status, "SUCCESS", transaction.hash, "status");
    requireEqual(result.txHash, transaction.hash, transaction.hash, "txHash");
    requireEqual(result.ledger, transaction.ledger, transaction.hash, "ledger");
    requireEqual(
      Number(result.createdAt),
      transaction.createdAt,
      transaction.hash,
      "createdAt",
    );
    requireEqual(
      result.resultXdr,
      transaction.resultXdr,
      transaction.hash,
      "resultXdr",
    );
    verifyResultEvidence(result, transaction, sdk);
    if (typeof result.envelopeXdr !== "string") {
      fail(transaction.hash, "RPC response omitted envelopeXdr");
    }
    requireEqual(
      sha256(Buffer.from(result.envelopeXdr, "base64")),
      transaction.envelopeSha256,
      transaction.hash,
      "envelopeSha256",
    );

    const decoded = sdk.TransactionBuilder.fromXDR(
      result.envelopeXdr,
      evidence.network.passphrase,
    );
    if (!(decoded instanceof sdk.Transaction)) {
      fail(
        transaction.hash,
        "fee-bump envelopes are outside this evidence profile",
      );
    }
    requireEqual(
      decoded.hash().toString("hex"),
      transaction.hash,
      transaction.hash,
      "transaction hash",
    );
    requireEqual(
      decoded.source,
      transaction.source,
      transaction.hash,
      "source",
    );
    requireEqual(
      decoded.operations.length,
      1,
      transaction.hash,
      "operation count",
    );
    const expectedWasmSha256 =
      transaction.label === "deploy_kernel"
        ? evidence.contracts.kernel.local_wasm_sha256
        : transaction.label === "deploy_sla_hook"
          ? evidence.contracts.sla_hook.local_wasm_sha256
          : undefined;
    verifyInvokeOperation(
      decoded.operations[0],
      transaction,
      sdk,
      evidence.network.passphrase,
      expectedWasmSha256,
      argumentContexts.get(transaction.hash),
    );
    verifyResources(decoded, transaction);
  }
  return true;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function main() {
  const [manifestPath, rawPath, ...rest] = process.argv.slice(2);
  if (manifestPath === undefined || rawPath === undefined || rest.length > 0) {
    throw new Error(
      "usage: node scripts/verify-evidence-onchain.mjs MANIFEST_JSON RAW_CAPTURE_JSON",
    );
  }
  const rawBytes = readFileSync(rawPath);
  await verifyEvidenceOnchain(
    readJson(manifestPath),
    JSON.parse(rawBytes.toString("utf8")),
    rawBytes,
  );
  process.stdout.write("Live RPC/XDR evidence verification passed.\n");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
