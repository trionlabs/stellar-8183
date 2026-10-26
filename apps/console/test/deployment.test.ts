import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { VERIFIED_TESTNET_PROFILE } from "../src/deployment.js";
import { validateProfile } from "../src/model.js";

describe("default deployment", () => {
  it("ships the same reviewed testnet profile in code and the public file", async () => {
    const publicProfile = validateProfile(
      JSON.parse(
        await readFile(
          new URL("../public/testnet-profile.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    expect(publicProfile).toEqual(VERIFIED_TESTNET_PROFILE);
    expect(publicProfile.id).toBe("testnet");
    expect(publicProfile.symbol).toBe("DEMO8183");
    expect(publicProfile.canaryAcknowledged).toBe(false);
  });
});
