import * as freighter from "@stellar/freighter-api";
import { StrKey } from "@stellar/stellar-sdk";
import type { Wallet } from "./live.js";
import type { Profile } from "./model.js";

export async function connectWallet(profile: Profile): Promise<Wallet> {
  if (!(await freighter.isConnected()).isConnected)
    throw new Error(
      "Install the Freighter browser extension, then connect your wallet.",
    );
  const access = await freighter.requestAccess();
  if (access.error || !StrKey.isValidEd25519PublicKey(access.address))
    throw new Error(access.error?.message ?? "Wallet access was not approved.");
  const owner = access.address;
  const check = async (expected: Profile): Promise<void> => {
    const [account, network] = await Promise.all([
      freighter.getAddress(),
      freighter.getNetworkDetails(),
    ]);
    if (account.error || account.address !== owner)
      throw new Error("Wallet account changed. Reconnect before continuing.");
    if (
      network.error ||
      network.networkPassphrase !== expected.networkPassphrase
    )
      throw new Error(`Switch Freighter to ${expected.id}, then reconnect.`);
  };
  await check(profile);
  return {
    address: owner,
    sign: async (xdr, expected) => {
      await check(expected);
      const result = await freighter.signTransaction(xdr, {
        networkPassphrase: expected.networkPassphrase,
        address: owner,
      });
      if (result.error || result.signerAddress !== owner || !result.signedTxXdr)
        throw new Error(
          result.error?.message ??
            "Wallet did not sign with the expected account.",
        );
      await check(expected);
      return result.signedTxXdr;
    },
  };
}
