import { Networks } from "@stellar/stellar-sdk";
import type { Profile } from "./model.js";

export const VERIFIED_TESTNET_PROFILE: Profile = Object.freeze({
  id: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  kernel: "CDQQSBNGKJ6CR2VG65P73OJUIMHOLYNFJWXCLKANOACJ4MXXQDJVFUNW",
  token: "CCIXERXUWARCM244A2JFJ3FIRW5CMX23JP3IWTTMDW3QYERRJAPAEQ2J",
  symbol: "DEMO8183",
  decimals: 7,
  maxFee: "10000000",
  canaryAcknowledged: false,
});
