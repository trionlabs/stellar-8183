import { Keypair } from "@stellar/stellar-sdk";
import type {
  AssembledTransaction,
  MethodOptions,
} from "@stellar/stellar-sdk/contract";
import { Ok } from "@stellar/stellar-sdk/contract";
import { describe, expect, it } from "vitest";

import { AgenticCommerce } from "../src/agentic-commerce.js";
import type {
  KernelAdapter,
  KernelMethod,
  PreparedInvocation,
} from "../src/kernel-types.js";
import { contractAddress } from "./helpers.js";

interface InvocationCall {
  readonly method: KernelMethod;
  readonly args: Readonly<Record<string, unknown>> | undefined;
  readonly options: MethodOptions | undefined;
}

function recordingAdapter(result: unknown = undefined): {
  adapter: KernelAdapter;
  calls: InvocationCall[];
} {
  const calls: InvocationCall[] = [];
  const adapter: KernelAdapter = {
    contractId: contractAddress(),
    networkPassphrase: "test",
    rpcUrl: "https://rpc.test.invalid",
    invoke: async <T>(
      method: KernelMethod,
      args: Readonly<Record<string, unknown>> | undefined,
      options?: MethodOptions,
    ) => {
      calls.push({ method, args, options });
      return {
        method,
        transaction: { result } as AssembledTransaction<T>,
      } as PreparedInvocation<T>;
    },
    deserialize: () => {
      throw new Error("unused");
    },
    decodeResult: () => result as never,
  };
  return { adapter, calls };
}

describe("AgenticCommerce", () => {
  it("constructs the checked-in generated client without an ABI fetch", async () => {
    const contractId = contractAddress();
    const commerce = await AgenticCommerce.connect({
      contractId,
      networkPassphrase: "test",
      publicKey: Keypair.random().publicKey(),
      rpcUrl: "https://must-not-be-called.test.invalid",
    });

    expect(commerce.adapter.contractId).toBe(contractId);
    expect(commerce.adapter.rpcUrl).toBe(
      "https://must-not-be-called.test.invalid",
    );
  });

  it("maps ergonomic create arguments to the generated ABI", async () => {
    const { adapter, calls } = recordingAdapter();
    const commerce = new AgenticCommerce(adapter);
    const facilitator = Keypair.random().publicKey();
    const client = Keypair.random().publicKey();
    const evaluator = Keypair.random().publicKey();

    await commerce.createJob(
      {
        client,
        evaluator,
        expiresAt: 1234n,
        description: "inspect a dataset",
      },
      { source: facilitator },
    );

    expect(calls[0]).toMatchObject({
      method: "create_job",
      args: {
        client,
        provider: undefined,
        evaluator,
        expires_at: 1234n,
        desc: "inspect a dataset",
        hook: undefined,
      },
      options: {
        publicKey: facilitator,
        restore: false,
        simulate: true,
      },
    });
  });

  it("fails closed on separate automatic restoration by default", async () => {
    const { adapter, calls } = recordingAdapter();
    const commerce = new AgenticCommerce(adapter);
    const source = Keypair.random().publicKey();

    await commerce.claimRefund(9n, { source });
    expect(calls[0]!.options).toMatchObject({
      restore: false,
    });
    expect(calls[0]!.options).not.toHaveProperty("signTransaction");
  });

  it("maps state-changing methods and hook options", async () => {
    const { adapter, calls } = recordingAdapter();
    const commerce = new AgenticCommerce(adapter);
    const source = Keypair.random().publicKey();
    const actor = Keypair.random().publicKey();
    const provider = Keypair.random().publicKey();
    const hook = contractAddress(2);
    const hash = new Uint8Array(32).fill(7);

    await commerce.setProvider({ id: 1n, provider }, { source });
    await commerce.setBudget({ id: 1n, actor, amount: 10n }, { source });
    await commerce.fund({ id: 1n, expectedBudget: 10n }, { source });
    await commerce.submit({ id: 1n, workHash: hash }, { source });
    await commerce.complete({ id: 1n, reason: hash }, { source });
    await commerce.reject({ id: 2n }, { source });
    await commerce.keepAlive(1n, { source });
    await commerce.proposeAdmin(actor, { source });
    await commerce.acceptAdmin({ source });
    await commerce.setHook(hook, true, { source });

    expect(calls.map(({ method }) => method)).toEqual([
      "set_provider",
      "set_budget",
      "fund",
      "submit",
      "complete",
      "reject",
      "keep_alive",
      "propose_admin",
      "accept_admin",
      "set_hook",
    ]);
    expect(calls[0]!.args?.opt).toEqual(new Uint8Array());
    expect(calls[4]!.args?.reason).toEqual(hash);
  });

  it("rejects lossy or invalid inputs before simulation", async () => {
    const { adapter } = recordingAdapter();
    const commerce = new AgenticCommerce(adapter);
    const source = Keypair.random().publicKey();
    const actor = Keypair.random().publicKey();

    expect(() =>
      commerce.setBudget({ id: 1n, actor, amount: 0n }, { source }),
    ).toThrow(/positive/);
    expect(() =>
      commerce.submit({ id: 1n, workHash: new Uint8Array(31) }, { source }),
    ).toThrow(/32 bytes/);
    expect(() =>
      commerce.setProvider(
        { id: 1n, provider: actor, options: new Uint8Array(1025) },
        { source },
      ),
    ).toThrow(/1024/);
    expect(() =>
      commerce.claimRefund(1n, { source: contractAddress() }),
    ).toThrow(/G-account facilitator/);
  });

  it("returns read simulation results", async () => {
    const { adapter } = recordingAdapter(12n);
    const commerce = new AgenticCommerce(adapter);
    await expect(commerce.jobCount()).resolves.toBe(12n);
  });

  it("normalizes live null Option fields at the job boundary", async () => {
    const runtimeJob = {
      id: 1n,
      client: Keypair.random().publicKey(),
      provider: null,
      evaluator: Keypair.random().publicKey(),
      desc: "runtime option fixture",
      budget: 0n,
      expires_at: 2n,
      state: { tag: "Open", values: undefined },
      hook: null,
      work_hash: null,
      decision: null,
    };
    const { adapter } = recordingAdapter(new Ok(runtimeJob));
    const commerce = new AgenticCommerce(adapter);

    await expect(commerce.getJob(1n)).resolves.toEqual({
      ...runtimeJob,
      provider: undefined,
      hook: undefined,
      work_hash: undefined,
      decision: undefined,
    });
  });
});
