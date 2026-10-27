import { once } from "node:events";
import { createServer } from "node:http";
import { Networks, StellarToml } from "@stellar/stellar-sdk";
import { expect, it } from "vitest";

it("resolves asset metadata and reports invalid TOML through the updated parser", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("Content-Type", "text/plain");
    response.end(
      requests.length === 1
        ? [
            'VERSION = "2.0.0"',
            'NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"',
            "[DOCUMENTATION]",
            'ORG_NAME = "Test fixture"',
            "[[CURRENCIES]]",
            'code = "DEMO8183"',
            'status = "test"',
            "display_decimals = 7",
          ].join("\n")
        : 'VERSION = "unterminated',
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const socket = server.address();
    if (!socket || typeof socket === "string")
      throw new Error("Expected a local TCP listener");
    const domain = `127.0.0.1:${socket.port}`;
    const options = { allowHttp: true, timeout: 1000 };
    const metadata = await StellarToml.Resolver.resolve(domain, options);
    expect(metadata.NETWORK_PASSPHRASE).toBe(Networks.TESTNET);
    expect(metadata.DOCUMENTATION?.ORG_NAME).toBe("Test fixture");
    expect(metadata.CURRENCIES).toEqual([
      { code: "DEMO8183", status: "test", display_decimals: 7 },
    ]);
    await expect(StellarToml.Resolver.resolve(domain, options)).rejects.toThrow(
      "stellar.toml is invalid",
    );
    expect(requests).toEqual([
      "/.well-known/stellar.toml",
      "/.well-known/stellar.toml",
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
