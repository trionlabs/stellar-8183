# Stellar 8183 Mainnet Canary Evidence

Status: verified on Stellar Mainnet on 2026-10-27. This is an author-run compatibility canary using the non-redeemable, valueless `DEMO8183` asset. It is not an audit, production launch, or independent customer pilot.

## Reproducible Deployment

- Deployment source: [`d83bfbf6ec528924f84db5c3f5e7169c171d2a44`](https://github.com/trionlabs/stellar-8183/commit/d83bfbf6ec528924f84db5c3f5e7169c171d2a44)
- Kernel Wasm SHA-256: `c07d5528b42827ecdcfad7e798bc0d08cd7e1183343746a415b4cf8b7e7cfcad`
- SLA-hook Wasm SHA-256: `14ef819cc362420d9ae543202774f094d794d4004889c86078e9a47cb7f94120`
- Kernel: [CDI2…TTQN](https://stellar.expert/explorer/public/contract/CDI2HGXO2QHYEMSZS4722LYV2WMZPN7CKSUQM3MPMPYMZEZS7HUXTTQN)
- SLA hook: [CD7H…DB5L](https://stellar.expert/explorer/public/contract/CD7HFVND3KZWM7OTRQYLBN7FD7D5OBBHI22EM7CHRRLQW2MTXIM7DB5L)
- DEMO8183 token: [CCXW…4PIZ](https://stellar.expert/explorer/public/contract/CCXWE2KE3Z7JZ6W5HVCUT42R4UPRLTYKBPUZEIJSRQQCSBN3ZI7U4PIZ)

Deployment transactions:

- [DEMO8183 token deployment](https://stellar.expert/explorer/public/tx/8722723abef2f6d1298e6da004ca1f680c3e163fae1020100e7bb9aed4dabdc7)
- [Kernel deployment](https://stellar.expert/explorer/public/tx/40ab0fde605aa5c77215ed05b657adb7bca7950ae3b27668a9b89a4531eafd0c)
- [SLA-hook deployment](https://stellar.expert/explorer/public/tx/0ace5ed3ff76a1ca8d7950077438818e43b5ed5ea333b1ba25112bbd33ee901e)
- [Hook admission](https://stellar.expert/explorer/public/tx/1498c622fd216a5d427e49385eae8c550bc1a295a2cee33e27eb1d0aafb2ed8f)

## Verified Terminal Paths

| Job | Path                          | Escrow funding                                                                                                            | Terminal transaction                                                                                                      | Result                                                                                         |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 2   | Completion                    | [95b717…917e](https://stellar.expert/explorer/public/tx/95b71723c4f9e89c83b961afffc83aaac7667ea730a01b63aa6a58365875917e) | [61f069…d926](https://stellar.expert/explorer/public/tx/61f06958c6fe50ed1c08f837beed0a3517a2a45b7eaead8f7e8eccba80fed926) | Provider received 1 DEMO8183; escrow returned to zero.                                         |
| 3   | Funded evaluator rejection    | [e03d0a…0239](https://stellar.expert/explorer/public/tx/e03d0ae82b7dd9296b1ec0849d4d4a111a153ee8aa3e7a7f343fe8978bc50239) | [ecd0cc…9f71](https://stellar.expert/explorer/public/tx/ecd0cc42dfe34af01de866473cab199a29484a2bebbba5f7b1434d1772cf9f71) | Client balance was restored; escrow returned to zero.                                          |
| 4   | Permissionless expired refund | [fec792…45df](https://stellar.expert/explorer/public/tx/fec7920aa76e563685573425234006e72c0219c83f64c9c17698278e57f645df) | [107178…04b2](https://stellar.expert/explorer/public/tx/10717881aa34f88b5bd58c60f34cb705f3109ffb6d211d590fa59534336304b2) | Provider invoked refund after expiry; client balance was restored and escrow returned to zero. |

Job 1 was an earlier successful completion during Mainnet fee calibration. The final evidence manifest deliberately uses the clean, consecutive Jobs 2–4.

## Public Evidence and Verification

- [Evidence manifest](../artifacts/mainnet-canary/canary-evidence.json)
- [Manifest checksum](../artifacts/mainnet-canary/canary-evidence.json.sha256)
- [Decoded transaction archive](../artifacts/mainnet-canary/transaction-archive.json)
- Portable receipts: [Job 2](../artifacts/mainnet-canary/canary/job-2.json), [Job 3](../artifacts/mainnet-canary/canary/job-3.json), and [Job 4](../artifacts/mainnet-canary/canary/job-4.json)

Run the read-only verifier from the repository root:

```bash
pnpm --filter @trionlabs/8183-console verify:canary \
  artifacts/mainnet-canary/canary-evidence.json \
  GBWXRXWT4OZC2T4OB6WEQ76ZU3TAEQTKLIACQ3GCL7V77LRBOCUAQWAX
```

The verifier checks deployed code, token identity, constructor state, hook admission, terminal job state, transaction bindings, receipt digests, and balance accounting against public Mainnet RPC data.
