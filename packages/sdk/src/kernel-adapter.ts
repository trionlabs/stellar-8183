import { Address } from "@stellar/stellar-sdk";
import type {
  AssembledTransaction,
  ClientOptions,
  MethodOptions,
} from "@stellar/stellar-sdk/contract";
import type { xdr } from "@stellar/stellar-sdk";

import { invariant } from "./errors.js";
import { Client as GeneratedKernelClient } from "./generated/kernel.js";
import type {
  KernelAdapter,
  KernelClientBase,
  KernelMethod,
  PreparedInvocation,
} from "./kernel-types.js";

const KERNEL_METHODS = new Set<KernelMethod>([
  "create_job",
  "set_provider",
  "set_budget",
  "fund",
  "submit",
  "complete",
  "reject",
  "claim_refund",
  "get_job",
  "keep_alive",
  "propose_admin",
  "accept_admin",
  "set_hook",
  "is_hook",
  "get_token",
  "get_admin",
  "job_count",
]);

const NO_ARGUMENT_METHODS = new Set<KernelMethod>([
  "accept_admin",
  "get_token",
  "get_admin",
  "job_count",
]);

type DynamicMethod = (
  argsOrOptions?: Readonly<Record<string, unknown>> | MethodOptions,
  options?: MethodOptions,
) => Promise<AssembledTransaction<unknown>>;

function assertContractId(contractId: string): void {
  let parsed: Address;
  try {
    parsed = Address.fromString(contractId);
  } catch (cause) {
    throw new TypeError("contractId must be a valid Stellar contract address", {
      cause,
    });
  }
  invariant(
    parsed.type === "contract",
    "INVALID_ARGUMENT",
    "contractId must be a C-address",
    { contractId },
  );
}

/**
 * Adapter for either the checked-in generated client or an injected compatible
 * client. It deliberately depends only on the inherited Client surface.
 */
export class GeneratedKernelAdapter implements KernelAdapter {
  readonly contractId: string;
  readonly networkPassphrase: string;
  readonly rpcUrl: string;

  constructor(private readonly client: KernelClientBase) {
    this.contractId = client.options.contractId;
    this.networkPassphrase = client.options.networkPassphrase;
    this.rpcUrl = client.options.rpcUrl;
    assertContractId(this.contractId);
  }

  async invoke<T>(
    method: KernelMethod,
    args: Readonly<Record<string, unknown>> | undefined,
    options?: MethodOptions,
  ): Promise<PreparedInvocation<T>> {
    const dynamic = this.client as unknown as Record<string, unknown>;
    const candidate = dynamic[method];
    invariant(
      typeof candidate === "function",
      "INVALID_ARGUMENT",
      `kernel client does not expose ${method}`,
    );

    const invoke = candidate as DynamicMethod;
    const transaction = NO_ARGUMENT_METHODS.has(method)
      ? await invoke.call(this.client, options)
      : await invoke.call(this.client, args ?? {}, options);

    return {
      method,
      transaction: transaction as AssembledTransaction<T>,
    };
  }

  deserialize<T>(json: string): PreparedInvocation<T> {
    const transaction = this.client.txFromJSON<T>(json);
    const method = transaction.options.method;
    invariant(
      KERNEL_METHODS.has(method as KernelMethod),
      "INVALID_RELAY_INTENT",
      "serialized transaction does not invoke a kernel method",
      { method },
    );
    return { method: method as KernelMethod, transaction };
  }

  decodeResult<T>(method: KernelMethod, value: xdr.ScVal): T {
    return this.client.spec.funcResToNative(method, value) as T;
  }
}

export async function connectKernel(
  options: ClientOptions,
): Promise<GeneratedKernelAdapter> {
  assertContractId(options.contractId);
  const client = new GeneratedKernelClient(options);
  return new GeneratedKernelAdapter(client);
}

export function kernelFromClient(
  client: KernelClientBase,
): GeneratedKernelAdapter {
  return new GeneratedKernelAdapter(client);
}
