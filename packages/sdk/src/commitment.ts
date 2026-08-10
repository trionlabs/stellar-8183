import { hash } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";

import { AgenticCommerceError, invariant } from "./errors.js";

const HEX_32_PATTERN = /^[0-9a-fA-F]{64}$/;
const textEncoder = new TextEncoder();

type CanonicalJsonPrimitive = boolean | null | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/**
 * Deterministic JSON encoding used by commitmentJson.
 *
 * Object keys are sorted lexicographically. Undefined, bigint, non-finite
 * numbers, non-plain objects, and cycles are rejected instead of being
 * silently coerced.
 */
export function canonicalJson(value: CanonicalJsonValue): string {
  const visiting = new Set<object>();

  const visit = (current: CanonicalJsonValue): string => {
    if (
      current === null ||
      typeof current === "boolean" ||
      typeof current === "string"
    ) {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      invariant(
        Number.isFinite(current),
        "INVALID_COMMITMENT",
        "commitment JSON cannot contain a non-finite number",
      );
      return JSON.stringify(current);
    }
    invariant(
      typeof current === "object",
      "INVALID_COMMITMENT",
      "commitment JSON contains an unsupported value",
    );
    invariant(
      !visiting.has(current),
      "INVALID_COMMITMENT",
      "commitment JSON cannot contain a cycle",
    );
    visiting.add(current);
    try {
      if (Array.isArray(current)) {
        return `[${current.map((entry) => visit(entry)).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(current) as object | null;
      invariant(
        prototype === Object.prototype || prototype === null,
        "INVALID_COMMITMENT",
        "commitment JSON objects must be plain objects",
      );
      return `{${Object.keys(current)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${visit(
              (current as Record<string, CanonicalJsonValue>)[key]!,
            )}`,
        )
        .join(",")}}`;
    } finally {
      visiting.delete(current);
    }
  };

  return visit(value);
}

export function commitmentBytes(
  input: string | Uint8Array,
): Uint8Array<ArrayBuffer> {
  const bytes = typeof input === "string" ? textEncoder.encode(input) : input;
  return Uint8Array.from(hash(Buffer.from(bytes)));
}

export function commitmentJson(
  value: CanonicalJsonValue,
): Uint8Array<ArrayBuffer> {
  return commitmentBytes(canonicalJson(value));
}

export function commitmentToHex(commitment: Uint8Array): string {
  assertCommitment(commitment);
  return Array.from(commitment, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function commitmentFromHex(hex: string): Uint8Array<ArrayBuffer> {
  invariant(
    HEX_32_PATTERN.test(hex),
    "INVALID_COMMITMENT",
    "commitment must be exactly 32 bytes of hexadecimal",
  );
  return Uint8Array.from(
    hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16)),
  );
}

export function assertCommitment(
  commitment: Uint8Array,
): Uint8Array<ArrayBufferLike> {
  if (commitment.length !== 32) {
    throw new AgenticCommerceError(
      "INVALID_COMMITMENT",
      "commitment must be exactly 32 bytes",
      { actualLength: commitment.length },
    );
  }
  return commitment;
}
