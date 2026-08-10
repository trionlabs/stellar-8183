import { Address, StrKey } from "@stellar/stellar-sdk";
import type {
  ClientOptions,
  MethodOptions,
} from "@stellar/stellar-sdk/contract";

import { assertCommitment } from "./commitment.js";
import {
  type ContractResult,
  unwrapContractResult,
} from "./contract-result.js";
import { invariant } from "./errors.js";
import { connectKernel, kernelFromClient } from "./kernel-adapter.js";
import { createGuardedRestoreSigner } from "./restoration.js";
import type {
  CreateJobArgs,
  DecideArgs,
  FundArgs,
  InvocationOptions,
  Job,
  KernelAdapter,
  KernelClientBase,
  PreparedContractInvocation,
  PreparedInvocation,
  ReadOptions,
  SetBudgetArgs,
  SetProviderArgs,
  SubmitArgs,
} from "./kernel-types.js";
import { assertPositiveI128 } from "./units.js";

const encoder = new TextEncoder();
const EMPTY_BYTES = new Uint8Array();
const U64_MAX = (1n << 64n) - 1n;

function assertAddress(address: string, label: string): void {
  try {
    Address.fromString(address);
  } catch (cause) {
    throw new TypeError(`${label} must be a valid Stellar address`, { cause });
  }
}

function assertId(id: bigint): void {
  invariant(
    id >= 0n && id <= U64_MAX,
    "INVALID_ARGUMENT",
    "job id must fit in a Soroban u64",
    { id: id.toString() },
  );
}

function assertU64(value: bigint, label: string): void {
  invariant(
    value >= 0n && value <= U64_MAX,
    "INVALID_ARGUMENT",
    `${label} must fit in a Soroban u64`,
    { [label]: value.toString() },
  );
}

function optionsBytes(options?: Uint8Array): Uint8Array {
  const value = options ?? EMPTY_BYTES;
  invariant(
    value.length <= 1024,
    "INVALID_ARGUMENT",
    "hook options cannot exceed 1024 bytes",
    { actualLength: value.length },
  );
  return value;
}

function invocationOptions(
  options: InvocationOptions,
  networkPassphrase: string,
): MethodOptions {
  invariant(
    StrKey.isValidEd25519PublicKey(options.source),
    "INVALID_ARGUMENT",
    "source must be a G-account facilitator",
    { source: options.source },
  );
  const base: MethodOptions = {
    publicKey: options.source,
    timeoutInSeconds: options.timeoutInSeconds ?? 300,
    simulate: true,
    restore: false,
  };
  const withFee =
    options.fee === undefined ? base : { ...base, fee: options.fee };
  if (options.restore === undefined) {
    return withFee;
  }
  invariant(
    options.restore.networkPassphrase === networkPassphrase,
    "RESTORATION_POLICY_MISMATCH",
    "restoration policy network does not match the kernel adapter",
  );
  invariant(
    options.restore.signer.address === options.source,
    "RESTORATION_POLICY_MISMATCH",
    "restoration signer must match the invocation source",
  );
  return {
    ...withFee,
    restore: true,
    signTransaction: createGuardedRestoreSigner(options.restore),
  };
}

function readOptions(
  options: ReadOptions | undefined,
  networkPassphrase: string,
): MethodOptions {
  if (options?.source !== undefined) {
    invariant(
      StrKey.isValidEd25519PublicKey(options.source),
      "INVALID_ARGUMENT",
      "source must be a G-account facilitator",
      { source: options.source },
    );
  }
  const base: MethodOptions = {
    simulate: true,
    restore: false,
  };
  const withSource =
    options?.source === undefined
      ? base
      : { ...base, publicKey: options.source };
  if (options?.restore === undefined) {
    return withSource;
  }
  invariant(
    options.source !== undefined &&
      options.restore.signer.address === options.source,
    "RESTORATION_POLICY_MISMATCH",
    "restoration signer must match the read source",
  );
  invariant(
    options.restore.networkPassphrase === networkPassphrase,
    "RESTORATION_POLICY_MISMATCH",
    "restoration policy network does not match the kernel adapter",
  );
  return {
    ...withSource,
    restore: true,
    signTransaction: createGuardedRestoreSigner(options.restore),
  };
}

/**
 * Ergonomic wrapper over the complete kernel ABI.
 *
 * Mutations return an assembled, simulated invocation. They do not sign or
 * submit the requested invocation implicitly. The SDK's separate
 * restoreFootprint fallback is off unless the caller supplies a guarded
 * policy. Protocol-23 same-envelope archived entries remain part of the
 * prepared invocation; use the relay workflow to pin their exact keys.
 */
export class AgenticCommerce {
  constructor(readonly adapter: KernelAdapter) {}

  static async connect(options: ClientOptions): Promise<AgenticCommerce> {
    return new AgenticCommerce(await connectKernel(options));
  }

  static fromClient(client: KernelClientBase): AgenticCommerce {
    return new AgenticCommerce(kernelFromClient(client));
  }

  createJob(
    args: CreateJobArgs,
    options: InvocationOptions,
  ): Promise<PreparedContractInvocation<bigint>> {
    assertAddress(args.client, "client");
    if (args.provider !== undefined) {
      assertAddress(args.provider, "provider");
    }
    assertAddress(args.evaluator, "evaluator");
    if (args.hook !== undefined) {
      assertAddress(args.hook, "hook");
    }
    assertU64(args.expiresAt, "expiresAt");
    const descriptionLength = encoder.encode(args.description).length;
    invariant(
      descriptionLength >= 1 && descriptionLength <= 512,
      "INVALID_ARGUMENT",
      "description must contain 1 to 512 UTF-8 bytes",
      { actualLength: descriptionLength },
    );

    return this.adapter.invoke<ContractResult<bigint>>(
      "create_job",
      {
        client: args.client,
        provider: args.provider,
        evaluator: args.evaluator,
        expires_at: args.expiresAt,
        desc: args.description,
        hook: args.hook,
      },
      invocationOptions(options, this.adapter.networkPassphrase),
    );
  }

  setProvider(
    args: SetProviderArgs,
    options: InvocationOptions,
  ): Promise<PreparedContractInvocation<void>> {
    assertId(args.id);
    assertAddress(args.provider, "provider");
    return this.adapter.invoke<ContractResult<void>>(
      "set_provider",
      {
        id: args.id,
        provider: args.provider,
        opt: optionsBytes(args.options),
      },
      invocationOptions(options, this.adapter.networkPassphrase),
    );
  }

  setBudget(
    args: SetBudgetArgs,
    options: InvocationOptions,
  ): Promise<PreparedContractInvocation<void>> {
    assertId(args.id);
    assertAddress(args.actor, "actor");
    assertPositiveI128(args.amount);
    return this.adapter.invoke<ContractResult<void>>(
      "set_budget",
      {
        id: args.id,
        actor: args.actor,
        amount: args.amount,
        opt: optionsBytes(args.options),
      },
      invocationOptions(options, this.adapter.networkPassphrase),
    );
  }

  fund(
    args: FundArgs,
    options: InvocationOptions,
  ): Promise<PreparedContractInvocation<void>> {
    assertId(args.id);
    assertPositiveI128(args.expectedBudget);
    return this.adapter.invoke<ContractResult<void>>(
      "fund",
      {
        id: args.id,
        expected_budget: args.expectedBudget,
        opt: optionsBytes(args.options),
      },
      invocationOptions(options, this.adapter.networkPassphrase),
    );
  }

  submit(
    args: SubmitArgs,
    options: InvocationOptions,
  ): Promise<PreparedContractInvocation<void>> {
    assertId(args.id);
    assertCommitment(args.workHash);
    return this.adapter.invoke<ContractResult<void>>(
      "submit",
      {
        id: args.id,
        work_hash: args.workHash,
        opt: optionsBytes(args.options),
      },
      invocationOptions(options, this.adapter.networkPassphrase),
    );
  }

  complete(
    args: DecideArgs,
    options: InvocationOptions,
  ): Promise<PreparedContractInvocation<void>> {
    return this.decide("complete", args, options);
  }

  reject(
    args: DecideArgs,
    options: InvocationOptions,
  ): Promise<PreparedContractInvocation<void>> {
    return this.decide("reject", args, options);
  }

  claimRefund(
    id: bigint,
    options: InvocationOptions,
  ): Promise<PreparedContractInvocation<void>> {
    assertId(id);
    return this.adapter.invoke<ContractResult<void>>(
      "claim_refund",
      { id },
      invocationOptions(options, this.adapter.networkPassphrase),
    );
  }

  keepAlive(
    id: bigint,
    options: InvocationOptions,
  ): Promise<PreparedContractInvocation<void>> {
    assertId(id);
    return this.adapter.invoke<ContractResult<void>>(
      "keep_alive",
      { id },
      invocationOptions(options, this.adapter.networkPassphrase),
    );
  }

  proposeAdmin(
    admin: string,
    options: InvocationOptions,
  ): Promise<PreparedInvocation<void>> {
    assertAddress(admin, "admin");
    return this.adapter.invoke<void>(
      "propose_admin",
      { admin },
      invocationOptions(options, this.adapter.networkPassphrase),
    );
  }

  acceptAdmin(
    options: InvocationOptions,
  ): Promise<PreparedContractInvocation<void>> {
    return this.adapter.invoke<ContractResult<void>>(
      "accept_admin",
      undefined,
      invocationOptions(options, this.adapter.networkPassphrase),
    );
  }

  setHook(
    hook: string,
    allowed: boolean,
    options: InvocationOptions,
  ): Promise<PreparedInvocation<void>> {
    assertAddress(hook, "hook");
    return this.adapter.invoke<void>(
      "set_hook",
      { hook, allowed },
      invocationOptions(options, this.adapter.networkPassphrase),
    );
  }

  async getJob(id: bigint, options?: ReadOptions): Promise<Job> {
    assertId(id);
    const result = (
      await this.adapter.invoke<ContractResult<Job>>(
        "get_job",
        { id },
        readOptions(options, this.adapter.networkPassphrase),
      )
    ).transaction.result;
    const job = unwrapContractResult(result, "get_job");
    // Stellar SDK 16.2 declares Soroban Option<T> as T | undefined, while
    // live RPC decoding currently produces null for None. Keep that runtime
    // mismatch behind this ergonomic boundary.
    return {
      ...job,
      provider: job.provider ?? undefined,
      hook: job.hook ?? undefined,
      work_hash: job.work_hash ?? undefined,
      decision: job.decision ?? undefined,
    };
  }

  async isHook(hook: string, options?: ReadOptions): Promise<boolean> {
    assertAddress(hook, "hook");
    return (
      await this.adapter.invoke<boolean>(
        "is_hook",
        { hook },
        readOptions(options, this.adapter.networkPassphrase),
      )
    ).transaction.result;
  }

  async getToken(options?: ReadOptions): Promise<string> {
    return (
      await this.adapter.invoke<string>(
        "get_token",
        undefined,
        readOptions(options, this.adapter.networkPassphrase),
      )
    ).transaction.result;
  }

  async getAdmin(options?: ReadOptions): Promise<string> {
    return (
      await this.adapter.invoke<string>(
        "get_admin",
        undefined,
        readOptions(options, this.adapter.networkPassphrase),
      )
    ).transaction.result;
  }

  async jobCount(options?: ReadOptions): Promise<bigint> {
    return (
      await this.adapter.invoke<bigint>(
        "job_count",
        undefined,
        readOptions(options, this.adapter.networkPassphrase),
      )
    ).transaction.result;
  }

  private decide(
    method: "complete" | "reject",
    args: DecideArgs,
    options: InvocationOptions,
  ): Promise<PreparedContractInvocation<void>> {
    assertId(args.id);
    if (args.reason !== undefined) {
      assertCommitment(args.reason);
    }
    return this.adapter.invoke<ContractResult<void>>(
      method,
      {
        id: args.id,
        reason: args.reason,
        opt: optionsBytes(args.options),
      },
      invocationOptions(options, this.adapter.networkPassphrase),
    );
  }
}
