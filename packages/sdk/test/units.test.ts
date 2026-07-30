import { describe, expect, it } from "vitest";

import {
  I128_MAX,
  canonicalJson,
  commitmentBytes,
  commitmentFromHex,
  commitmentJson,
  commitmentToHex,
  formatUnits,
  parseUnits,
} from "../src/index.js";

describe("token units", () => {
  it("parses Stellar's seven decimal places exactly", () => {
    expect(parseUnits("1")).toBe(10_000_000n);
    expect(parseUnits("0.0000001")).toBe(1n);
    expect(parseUnits("-12.34")).toBe(-123_400_000n);
  });

  it("formats without floating point or trailing zeroes", () => {
    expect(formatUnits(12_340_000n)).toBe("1.234");
    expect(formatUnits(-1n)).toBe("-0.0000001");
    expect(formatUnits(0n)).toBe("0");
  });

  it("rejects exponent notation and excess precision", () => {
    expect(() => parseUnits("1e3")).toThrow(/plain decimal/);
    expect(() => parseUnits("1.00000001")).toThrow(/fractional digits/);
  });

  it("rejects values outside i128", () => {
    expect(() => parseUnits((I128_MAX + 1n).toString(), 0)).toThrow(/i128/);
  });
});

describe("commitments", () => {
  it("matches the SHA-256 test vector", () => {
    expect(commitmentToHex(commitmentBytes("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("sorts object keys deterministically", () => {
    const left = { z: true, a: { y: 2, x: "value" } };
    const right = { a: { x: "value", y: 2 }, z: true };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(commitmentToHex(commitmentJson(left))).toBe(
      commitmentToHex(commitmentJson(right)),
    );
  });

  it("round-trips hexadecimal commitments", () => {
    const hex = "ab".repeat(32);
    expect(commitmentToHex(commitmentFromHex(hex))).toBe(hex);
  });

  it("rejects cycles and malformed commitments", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalJson(cycle as never)).toThrow(/cycle/);
    expect(() => commitmentFromHex("00")).toThrow(/32 bytes/);
  });
});
