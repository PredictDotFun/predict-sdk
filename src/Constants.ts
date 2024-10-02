import type { Addresses } from "./Types";
import { JsonRpcProvider } from "ethers";

export const MAX_SALT = 2_147_483_648;
export const FIVE_MINUTES_SECONDS = 60 * 5;

export enum ChainId {
  BlastMainnet = 81_457,
  BlastSepolia = 168_587_773,
}

/**
 * @remarks EOA also supports EIP-1271.
 */
export enum SignatureType {
  EOA = 0,
  POLY_PROXY = 1,
  POLY_GNOSIS_SAFE = 2,
}

export enum Side {
  BUY = 0,
  SELL = 1,
}

export const AddressesByChainId = {
  [ChainId.BlastMainnet]: {
    CTF_EXCHANGE: "0x739f0331594029064C252559436eDce0E468E37a",
    NEG_RISK_CTF_EXCHANGE: "0x6a3796C21e733a3016Bc0bA41edF763016247e72",
    NEG_RISK_ADAPTER: "0xc55687812285D05b74815EE2716D046fAF61B003",
    CONDITIONAL_TOKENS: "0x8F9C9f888A4268Ab0E2DDa03A291769479bAc285",
    USDB: "0x4300000000000000000000000000000000000003",
  },
  [ChainId.BlastSepolia]: {
    CTF_EXCHANGE: "0xba9605D6d0108ed3787fD9423F6d28BF8c7dE2DD",
    NEG_RISK_CTF_EXCHANGE: "0xd95787e7146204037704eCCCB3fA3A67801fea10",
    NEG_RISK_ADAPTER: "0xd21Ce3f6A0e9351bF47b9045200410f55F74f9CC",
    CONDITIONAL_TOKENS: "0xD6EBc6E01a282A3803920DE31227D8a6687e2F8F",
    USDB: "0x4200000000000000000000000000000000000022",
  },
} satisfies Record<ChainId, Addresses>;

export const ProviderByChainId = {
  [ChainId.BlastMainnet]: new JsonRpcProvider("https://rpc.blast.io/"),
  [ChainId.BlastSepolia]: new JsonRpcProvider("https://sepolia.blast.io/"),
} satisfies Record<ChainId, JsonRpcProvider>;

export const PROTOCOL_NAME = "predict.fun CTF Exchange";
export const PROTOCOL_VERSION = "1";

export const EIP712_DOMAIN = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

export const ORDER_STRUCTURE = [
  { name: "salt", type: "uint256" },
  { name: "maker", type: "address" },
  { name: "signer", type: "address" },
  { name: "taker", type: "address" },
  { name: "tokenId", type: "uint256" },
  { name: "makerAmount", type: "uint256" },
  { name: "takerAmount", type: "uint256" },
  { name: "expiration", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "feeRateBps", type: "uint256" },
  { name: "side", type: "uint8" },
  { name: "signatureType", type: "uint8" },
];
