import type { Addresses, OrderConfig } from "./Types";

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
    NEG_CTF_EXCHANGE: "0x6a3796C21e733a3016Bc0bA41edF763016247e72",
  },
  [ChainId.BlastSepolia]: {
    CTF_EXCHANGE: "0xba9605D6d0108ed3787fD9423F6d28BF8c7dE2DD",
    NEG_CTF_EXCHANGE: "0xd95787e7146204037704eCCCB3fA3A67801fea10",
  },
} satisfies Record<ChainId, Addresses>;

/**
 * @remarks The fee rate is only applied on the taker's side.
 */
export const OrderConfigByChainId = {
  [ChainId.BlastMainnet]: {
    feeRateBps: "50",
  },
  [ChainId.BlastSepolia]: {
    feeRateBps: "50",
  },
} satisfies Record<ChainId, OrderConfig>;

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
