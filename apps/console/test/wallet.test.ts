import { beforeEach, expect, it, vi } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import {
  rehearsalAccounts as accounts,
  rehearsalProfile as profile,
} from "../src/rehearsal.js";

const wallet = vi.hoisted(() => ({
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
  getAddress: vi.fn(),
  getNetworkDetails: vi.fn(),
  signTransaction: vi.fn(),
}));
vi.mock("@stellar/freighter-api", () => wallet);
import { connectWallet } from "../src/wallet.js";

beforeEach(() => {
  vi.resetAllMocks();
  wallet.isConnected.mockResolvedValue({ isConnected: true });
  wallet.requestAccess.mockResolvedValue({ address: accounts.client });
  wallet.getAddress.mockResolvedValue({ address: accounts.client });
  wallet.getNetworkDetails.mockResolvedValue({
    networkPassphrase: Networks.TESTNET,
  });
  wallet.signTransaction.mockResolvedValue({
    signedTxXdr: "signed",
    signerAddress: accounts.client,
  });
});

it("checks extension presence and propagates denied access", async () => {
  wallet.isConnected.mockResolvedValue({ isConnected: false });
  await expect(connectWallet(profile)).rejects.toThrow("Install");
  expect(wallet.requestAccess).not.toHaveBeenCalled();
  wallet.isConnected.mockResolvedValue({ isConnected: true });
  wallet.requestAccess.mockResolvedValue({
    address: "",
    error: { message: "Denied" },
  });
  await expect(connectWallet(profile)).rejects.toThrow("Denied");
});

it("blocks a mismatched network at connection and before signing", async () => {
  wallet.getNetworkDetails.mockResolvedValueOnce({
    networkPassphrase: Networks.PUBLIC,
  });
  await expect(connectWallet(profile)).rejects.toThrow("Switch Freighter");
  const connected = await connectWallet(profile);
  wallet.getNetworkDetails.mockResolvedValue({
    networkPassphrase: Networks.PUBLIC,
  });
  await expect(connected.sign("unsigned", profile)).rejects.toThrow(
    "Switch Freighter",
  );
  expect(wallet.signTransaction).not.toHaveBeenCalled();
});

it("blocks account changes and unexpected returned signers", async () => {
  const connected = await connectWallet(profile);
  wallet.getAddress.mockResolvedValueOnce({ address: accounts.provider });
  await expect(connected.sign("unsigned", profile)).rejects.toThrow(
    "account changed",
  );
  expect(wallet.signTransaction).not.toHaveBeenCalled();
  wallet.signTransaction.mockResolvedValue({
    signedTxXdr: "signed",
    signerAddress: accounts.provider,
  });
  await expect(connected.sign("unsigned", profile)).rejects.toThrow(
    "expected account",
  );
});

it("detects an account change while the wallet approval dialog is open", async () => {
  const connected = await connectWallet(profile);
  wallet.signTransaction.mockImplementation(async () => {
    wallet.getAddress.mockResolvedValue({ address: accounts.provider });
    return { signedTxXdr: "signed", signerAddress: accounts.client };
  });
  await expect(connected.sign("unsigned", profile)).rejects.toThrow(
    "account changed",
  );
});
