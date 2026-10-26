import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Address,
  Contract,
  Keypair,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import { Ok } from "@stellar/stellar-sdk/contract";
import {
  AgenticCommerce,
  type Job,
  type KernelAdapter,
  type PreparedContractInvocation,
} from "@trionlabs/stellar-8183";
import {
  ConfirmedJobReadError,
  LiveCommerce,
  UnconfirmedTransactionError,
  type PendingSubmission,
} from "../src/live.js";
import { JobMemory, type LocalStorage } from "../src/storage.js";
import * as identity from "../src/identity.js";
import {
  Rehearsal,
  rehearsalAccounts as accounts,
  rehearsalProfile as profile,
} from "../src/rehearsal.js";

afterEach(() => vi.restoreAllMocks());

function openJob(owner: string, id = 42n): Job {
  const rehearsal = new Rehearsal();
  return {
    ...rehearsal.create(
      {
        description: "Research report",
        evaluator: accounts.evaluator,
        provider: accounts.provider,
        expiresAt: BigInt(rehearsal.now + 3600),
      },
      owner,
    ).job,
    id,
    budget: 10n,
  };
}
function transaction(
  key: Keypair,
  method: PendingSubmission["method"],
  jobId = 42n,
  kernel = profile.kernel,
  passphrase = profile.networkPassphrase,
): Transaction {
  return new TransactionBuilder(new Account(key.publicKey(), "0"), {
    fee: "100",
    networkPassphrase: passphrase,
  })
    .addOperation(
      new Contract(kernel).call(
        method,
        ...(method === "create_job"
          ? [new Address(key.publicKey()).toScVal()]
          : [
              nativeToScVal(jobId, { type: "u64" }),
              nativeToScVal(10n, { type: "i128" }),
            ]),
      ),
    )
    .setTimeout(120)
    .build();
}
function success(
  tx: Transaction,
  id = 42n,
): rpc.Api.GetSuccessfulTransactionResponse {
  // Only fields read by recovery are supplied; no RPC or secret material is used.
  return {
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    txHash: tx.hash().toString("hex"),
    ledger: 123,
    envelopeXdr: tx.toEnvelope(),
    returnValue: nativeToScVal(id, { type: "u64" }),
  } as rpc.Api.GetSuccessfulTransactionResponse;
}
function pending(
  tx: Transaction,
  method: PendingSubmission["method"],
  jobId = "42",
): PendingSubmission {
  return {
    hash: tx.hash().toString("hex"),
    method,
    source: tx.source,
    ...(method === "create_job" ? {} : { jobId }),
  };
}
function fixture() {
  const key = Keypair.random();
  const sign = vi.fn(async (xdr: string) => {
    const signed = TransactionBuilder.fromXDR(xdr, profile.networkPassphrase);
    if (!(signed instanceof Transaction))
      throw new Error("Expected a normal transaction");
    signed.sign(key);
    return signed.toXDR();
  });
  const live = new LiveCommerce(profile, { address: key.publicKey(), sign });
  const adapter: KernelAdapter = {
    contractId: profile.kernel,
    rpcUrl: profile.rpcUrl,
    networkPassphrase: profile.networkPassphrase,
    invoke: async () => {
      throw new Error("Unexpected SDK invocation");
    },
    deserialize: () => {
      throw new Error("Unexpected SDK deserialize");
    },
    decodeResult: () => {
      throw new Error("Unexpected SDK decoding");
    },
  };
  const core = new AgenticCommerce(adapter);
  vi.spyOn(AgenticCommerce, "connect").mockResolvedValue(core);
  vi.spyOn(live, "tokenInfo").mockResolvedValue({
    symbol: profile.symbol,
    decimals: profile.decimals,
  });
  return { key, sign, live, core };
}
function prepared<T>(
  tx: Transaction,
  method: PendingSubmission["method"],
  value: T,
  mode: "success" | "sdk-throw" | "not-found" = "success",
): PreparedContractInvocation<T> {
  const op = tx.operations[0];
  if (op?.type !== "invokeHostFunction")
    throw new Error("Expected contract invocation");
  type Assembled = PreparedContractInvocation<T>["transaction"];
  const signAndSend: Assembled["signAndSend"] = async (options) => {
    const signer = options?.signTransaction;
    if (typeof signer !== "function")
      throw new Error("Missing signer callback");
    const signed = await signer(tx.toXDR());
    if (mode === "sdk-throw") throw new Error("RPC unavailable after signing");
    const envelope = TransactionBuilder.fromXDR(
      signed.signedTxXdr,
      profile.networkPassphrase,
    );
    if (!(envelope instanceof Transaction))
      throw new Error("Expected signed transaction");
    const response =
      mode === "success"
        ? success(envelope)
        : {
            status: rpc.Api.GetTransactionStatus.NOT_FOUND,
            txHash: tx.hash().toString("hex"),
          };
    return {
      getTransactionResponse: response,
      sendTransactionResponse: { hash: tx.hash().toString("hex") },
      result: new Ok(value),
    } as unknown as Awaited<ReturnType<Assembled["signAndSend"]>>;
  };
  return {
    method,
    transaction: {
      options: { args: op.func.invokeContract().args() },
      signAndSend,
    } as Assembled,
  };
}
function memory(): LocalStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe("confirmed transactions survive failed follow-up reads", () => {
  it("retains the confirmed created ID and outcome without inventing job state", async () => {
    const { live, key, core } = fixture(),
      tx = transaction(key, "create_job");
    vi.spyOn(core, "createJob").mockResolvedValue(
      prepared(tx, "create_job", 42n),
    );
    vi.spyOn(live, "read").mockRejectedValue(
      new Error("RPC unavailable after confirmation"),
    );
    const attempt = live.create({
      description: "Research report",
      evaluator: accounts.evaluator,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });
    await expect(attempt).rejects.toBeInstanceOf(ConfirmedJobReadError);
    await expect(attempt).rejects.toMatchObject({
      jobId: 42n,
      outcome: {
        hash: tx.hash().toString("hex"),
        ledger: 123,
        method: "create_job",
      },
    });
  });
  it("retains the latest pre-funding identity snapshot after confirmed funding", async () => {
    const { live, key, core } = fixture(),
      tx = transaction(key, "fund");
    const binding = {
      network: "testnet" as const,
      identityRegistry: profile.kernel,
      agentId: "1",
      provider: accounts.provider,
      resolvedAtLedger: 50,
    };
    const fresh = { ...binding, resolvedAtLedger: 55 };
    vi.spyOn(identity, "resolveAgent").mockResolvedValue(fresh);
    vi.spyOn(core, "fund").mockResolvedValue(prepared(tx, "fund", undefined));
    vi.spyOn(live, "read")
      .mockResolvedValueOnce(openJob(key.publicKey()))
      .mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(live.act(42n, "fund", {}, binding)).rejects.toMatchObject({
      name: "ConfirmedJobReadError",
      jobId: 42n,
      binding: fresh,
      outcome: { method: "fund", hash: tx.hash().toString("hex") },
    });
  });
});

describe("signed transactions with unknown final status", () => {
  it.each(["denied", "unsigned"] as const)(
    "does not journal an action when the wallet returns %s",
    async (mode) => {
      const { live, key, core, sign } = fixture(),
        tx = transaction(key, "create_job");
      vi.spyOn(core, "createJob").mockResolvedValue(
        prepared(tx, "create_job", 42n),
      );
      if (mode === "denied")
        sign.mockRejectedValue(new Error("Wallet denied the action"));
      else sign.mockResolvedValue(tx.toXDR());
      const attempt = live.create({
        description: "Research report",
        evaluator: accounts.evaluator,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
      });
      await expect(attempt).rejects.not.toBeInstanceOf(
        UnconfirmedTransactionError,
      );
      await expect(attempt).rejects.toThrow(
        mode === "denied" ? "denied" : "valid signature",
      );
    },
  );
  it.each(["sdk-throw", "not-found"] as const)(
    "retains the signed hash when the SDK returns %s",
    async (mode) => {
      const { live, key, core, sign } = fixture(),
        tx = transaction(key, "create_job");
      vi.spyOn(core, "createJob").mockResolvedValue(
        prepared(tx, "create_job", 42n, mode),
      );
      const read = vi.spyOn(live, "read");
      await expect(
        live.create({
          description: "Research report",
          evaluator: accounts.evaluator,
          expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
        }),
      ).rejects.toMatchObject({
        name: "UnconfirmedTransactionError",
        submission: pending(tx, "create_job"),
      });
      expect(sign).toHaveBeenCalledOnce();
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("retains the job ID and fresh identity snapshot for an unconfirmed fund", async () => {
    const { live, key, core } = fixture(),
      tx = transaction(key, "fund");
    const binding = {
      network: "testnet" as const,
      identityRegistry: profile.kernel,
      agentId: "1",
      provider: accounts.provider,
      resolvedAtLedger: 50,
    };
    const fresh = { ...binding, resolvedAtLedger: 55 };
    vi.spyOn(identity, "resolveAgent").mockResolvedValue(fresh);
    vi.spyOn(core, "fund").mockResolvedValue(
      prepared(tx, "fund", undefined, "sdk-throw"),
    );
    vi.spyOn(live, "read").mockResolvedValue(openJob(key.publicKey()));
    const attempt = live.act(42n, "fund", {}, binding);
    await expect(attempt).rejects.toBeInstanceOf(UnconfirmedTransactionError);
    await expect(attempt).rejects.toMatchObject({
      submission: pending(tx, "fund"),
      binding: fresh,
    });
  });
});

describe("read-only submission recovery", () => {
  it("keeps NOT_FOUND unknown and derives the created job ID only from a confirmed return", async () => {
    const { live, key, sign } = fixture(),
      tx = transaction(key, "create_job"),
      item = pending(tx, "create_job");
    const status = vi.spyOn(live.server, "getTransaction");
    status
      .mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        txHash: item.hash,
      } as rpc.Api.GetMissingTransactionResponse)
      .mockResolvedValueOnce(success(tx));
    const read = vi
      .spyOn(live, "read")
      .mockResolvedValue(openJob(key.publicKey()));
    await expect(live.recoverSubmission(item)).resolves.toEqual({
      status: "unknown",
    });
    expect(read).not.toHaveBeenCalled();
    await expect(live.recoverSubmission(item)).resolves.toMatchObject({
      status: "confirmed",
      record: {
        job: { id: 42n },
        outcome: { hash: item.hash, method: "create_job", ledger: 123 },
      },
    });
    expect(sign).not.toHaveBeenCalled();
  });
  it("checks the failed envelope before declaring a transaction failed", async () => {
    const { live, key } = fixture(),
      tx = transaction(key, "fund"),
      item = pending(tx, "fund");
    vi.spyOn(live.server, "getTransaction").mockResolvedValue({
      ...success(tx),
      status: rpc.Api.GetTransactionStatus.FAILED,
    } as rpc.Api.GetFailedTransactionResponse);
    const read = vi.spyOn(live, "read");
    await expect(live.recoverSubmission(item)).resolves.toEqual({
      status: "failed",
    });
    await expect(
      live.recoverSubmission({ ...item, source: accounts.provider }),
    ).rejects.toThrow("source");
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["hash", "source", "method", "jobId"] as const)(
    "rejects changed pending %s before reading a job",
    async (field) => {
      const { live, key } = fixture(),
        tx = transaction(key, "fund"),
        item = pending(tx, "fund");
      vi.spyOn(live.server, "getTransaction").mockResolvedValue(success(tx));
      const changed = {
        ...item,
        [field]: {
          hash: "ab".repeat(32),
          source: accounts.provider,
          method: "submit",
          jobId: "43",
        }[field],
      };
      const read = vi.spyOn(live, "read");
      await expect(
        live.recoverSubmission(changed as PendingSubmission),
      ).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("rejects another kernel or network", async () => {
    const { live, key } = fixture();
    for (const tx of [
      transaction(key, "fund", 42n, profile.token),
      transaction(
        key,
        "fund",
        42n,
        profile.kernel,
        "Public Global Stellar Network ; September 2015",
      ),
    ]) {
      vi.spyOn(live.server, "getTransaction").mockResolvedValueOnce(
        success(tx),
      );
      await expect(
        live.recoverSubmission(pending(tx, "fund")),
      ).rejects.toThrow();
    }
  });
  it("preserves a confirmed recovery pointer if the subsequent job read fails", async () => {
    const { live, key } = fixture(),
      tx = transaction(key, "create_job");
    vi.spyOn(live.server, "getTransaction").mockResolvedValue(success(tx));
    vi.spyOn(live, "read").mockRejectedValue(new Error("RPC unavailable"));
    await expect(
      live.recoverSubmission(pending(tx, "create_job")),
    ).rejects.toMatchObject({
      name: "ConfirmedJobReadError",
      jobId: 42n,
      outcome: { hash: tx.hash().toString("hex") },
    });
  });
});

describe("public recovery pointers and pending journals", () => {
  it("persists a confirmed pointer without a fabricated job", () => {
    const storage = memory(),
      store = new JobMemory(storage, profile);
    const outcome = { hash: "ab".repeat(32), ledger: 123, method: "complete" };
    store.savePointer(42n, outcome);
    const restored = new JobMemory(storage, profile);
    expect(restored.ids()).toEqual([42n]);
    expect(
      restored.restore({
        job: {
          ...openJob(accounts.client),
          state: { tag: "Completed", values: undefined },
        },
      }).outcome,
    ).toEqual(outcome);
  });
  it("retains multiple pending hashes across reloads, scopes deployments, and clears only the selected hash", () => {
    const storage = memory(),
      store = new JobMemory(storage, profile),
      key = Keypair.random();
    const first = pending(transaction(key, "create_job"), "create_job"),
      second = pending(transaction(key, "fund"), "fund");
    store.savePending(first);
    store.savePending(second);
    expect(new JobMemory(storage, profile).pending()).toEqual([second, first]);
    for (const other of [
      { ...profile, kernel: profile.token },
      { ...profile, token: profile.kernel },
      { ...profile, id: "mainnet-canary" as const },
    ])
      expect(new JobMemory(storage, other).pending()).toEqual([]);
    store.clear();
    expect(store.pending()).toEqual([second, first]);
    store.clearPending(first.hash);
    expect(store.pending()).toEqual([second]);
  });
  it("rejects secret-shaped metadata and never evicts an unresolved signed transaction", () => {
    const store = new JobMemory(memory(), profile),
      key = Keypair.random(),
      item = pending(transaction(key, "create_job"), "create_job");
    const hostile = { ...item, privateKey: "must not serialize" };
    expect(() => store.savePending(hostile)).toThrow("metadata");
    for (let index = 0; index < 100; index++)
      store.savePending({
        ...item,
        hash: index.toString(16).padStart(64, "0"),
      });
    expect(() => store.savePending({ ...item, hash: "ff".repeat(32) })).toThrow(
      "Resolve pending",
    );
    expect(store.pending()).toHaveLength(100);
    expect(store.pending().some((entry) => entry.hash === "0".repeat(64))).toBe(
      true,
    );
  });
});
