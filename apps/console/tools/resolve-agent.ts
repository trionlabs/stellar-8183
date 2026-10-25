import { readFile } from "node:fs/promises";
import { resolveAgent } from "../src/identity.js";
import { validateProfile, type Profile } from "../src/model.js";

const [profilePath, registry, agentId, source] = process.argv.slice(2);
if (!profilePath || !registry || !agentId || !source)
  throw new Error(
    "Usage: pnpm resolve:agent <profile.json> <identity-registry> <agent-id> <public G-account>",
  );
const profile = validateProfile(
  JSON.parse(await readFile(profilePath, "utf8")) as Profile,
);
console.log(
  JSON.stringify(
    await resolveAgent(
      profile,
      { network: profile.id, identityRegistry: registry, agentId },
      source,
    ),
    null,
    2,
  ),
);
