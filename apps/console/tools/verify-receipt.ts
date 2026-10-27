import { readFile } from "node:fs/promises";
import { LiveCommerce, verifyOnChain } from "../src/live.js";
import { parseReceipt } from "../src/receipt.js";
import { validateProfile, type Profile } from "../src/model.js";

const [receiptPath, profilePath, readerAddress] = process.argv.slice(2);
if (!receiptPath || !profilePath || !readerAddress)
  throw new Error(
    "Usage: pnpm verify:receipt <receipt.json> <profile.json> <public G-account>",
  );
const receipt = await parseReceipt(await readFile(receiptPath, "utf8"));
const profile = validateProfile(
  JSON.parse(await readFile(profilePath, "utf8")) as Profile,
);
const reader = new LiveCommerce(profile, {
  address: readerAddress,
  sign: async () => {
    throw new Error("Read-only verifier cannot sign.");
  },
});
console.log(await verifyOnChain(receipt, profile, reader));
