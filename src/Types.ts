import type { Side, SignatureType } from "./Constants";
import type {
  BlastConditionalTokens,
  BlastCTFExchange,
  BlastNegRiskAdapter,
  BlastNegRiskCtfExchange,
  ERC20,
} from "./typechain";
import type { ContractTransactionResponse } from "ethers";

export type BigIntString = string;

export type Currency = "USDB";
export type OrderStrategy = "MARKET" | "LIMIT";
/** true represents an Ask, while false a Bid */
export type QuoteType = boolean;

/**
 * Order Amounts Helper
 */

export interface MarketHelperInput {
  side: Side;
  quantityWei: bigint;
}

export interface ProcessedBookAmounts {
  quantityWei: bigint;
  priceWei: bigint;
  lastPriceWei: bigint;
}

export interface LimitHelperInput {
  side: Side;
  pricePerShareWei: bigint;
  quantityWei: bigint;
}

export interface OrderAmounts {
  pricePerShare: bigint;
  makerAmount: bigint;
  takerAmount: bigint;
}

/**
 * Configuration
 */

export interface OrderConfig {
  feeRateBps: BigIntString;
}

export interface Addresses {
  CTF_EXCHANGE: string;
  NEG_RISK_CTF_EXCHANGE: string;
  NEG_RISK_ADAPTER: string;
  CONDITIONAL_TOKENS: string;
  USDB: string;
}

/**
 * Order
 */

export interface Order {
  /**
   * A unique salt to ensure entropy
   */
  salt: BigIntString;

  /**
   * The maker of the order, e.g. the order's signer
   */
  maker: string;

  /**
   * The signer of the order
   */
  signer: string;

  /**
   * The address of the order taker. The zero address is used to indicate a public order
   */
  taker: string;

  /**
   * The token ID of the CTF ERC-1155 asset to be bought or sold.
   */
  tokenId: BigIntString;

  /**
   * The maker amount
   *
   * For a BUY order, this represents the total `(price per asset * assets quantity)` collateral (e.g. USDB) being offered.
   * For a SELL order, this represents the total amount of CTF assets being offered.
   */
  makerAmount: BigIntString;

  /**
   * The taker amount
   *
   * For a BUY order, this represents the total amount of CTF assets to be received.
   * For a SELL order, this represents the total `(price per asset * assets quantity)` amount of collateral (e.g. USDB) to be received.
   */
  takerAmount: BigIntString;

  /**
   * The timestamp in seconds after which the order is expired
   */
  expiration: BigIntString;

  /**
   * The nonce used for on-chain cancellations
   */
  nonce: BigIntString;

  /**
   * The fee rate, in basis points
   */
  feeRateBps: BigIntString;

  /**
   * The side of the order, BUY (Bid) or SELL (Ask)
   */
  side: Side;

  /**
   * Signature type used by the Order (EOA also supports EIP-1271)
   */
  signatureType: SignatureType;
}

export interface SignedOrder extends Order {
  /**
   * The order signature
   */
  signature: string;
}

export interface BuildOrderInput {
  side: Order["side"];
  signer: Order["signer"];
  tokenId: Order["tokenId"] | bigint;
  makerAmount: Order["makerAmount"] | bigint;
  takerAmount: Order["takerAmount"] | bigint;
  nonce?: Order["nonce"] | bigint;
  salt?: Order["salt"] | bigint;
  maker?: Order["maker"];
  taker?: Order["taker"];
  signatureType?: Order["signatureType"];
  feeRateBps?: Order["feeRateBps"] | bigint | number;
  expiresAt?: Date;
}

/**
 * Typed Data
 */

export declare type EIP712ObjectValue = string | number | EIP712Object;

export interface EIP712Object {
  [key: string]: EIP712ObjectValue;
}

export interface EIP712Types {
  [key: string]: EIP712Parameter[];
}

export interface EIP712Parameter {
  name: string;
  type: string;
}

export interface EIP712TypedData {
  types: EIP712Types;
  domain: EIP712Object;
  message: EIP712Object;
  primaryType: string;
}

/**
 * Orderbook
 */

export type DepthLevel = [number, number];

export interface Book {
  marketId: number;
  updateTimestampMs: number;
  asks: DepthLevel[];
  bids: DepthLevel[];
}

/**
 * Contracts
 */

export interface Contracts {
  CTF_EXCHANGE: BlastCTFExchange;
  NEG_RISK_CTF_EXCHANGE: BlastNegRiskCtfExchange;
  NEG_RISK_ADAPTER: BlastNegRiskAdapter;
  CONDITIONAL_TOKENS: BlastConditionalTokens;
  USDB: ERC20;
}

export interface Erc1155Approval {
  /**
   * Check if the contract is approved to transfer the Conditional Tokens.
   *
   * @returns {Promise<boolean>} Whether the contract is approved for all
   *
   * @throws {MissingSignerError} If a `signer` was not provided when instantiating the `OrderBuilder`.
   */
  isApprovedForAll: () => Promise<boolean>;

  /**
   * Approve the contract to transfer the Conditional Tokens.
   *
   * @param {Promise<boolean>} approved - Whether to approve the contract to transfer the Conditional Tokens, defaults to `true`.
   * @returns {Promise<ContractTransactionResponse>} The ethers' transaction response
   *
   * @throws {MissingSignerError} If a `signer` was not provided when instantiating the `OrderBuilder`.
   */
  setApprovalForAll: (approved?: boolean) => Promise<ContractTransactionResponse>;
}

export interface Erc20Approval {
  /**
   * Check the allowance of the contract for the USDB tokens.
   *
   * @returns {Promise<bigint>} The allowance of the contract for the USDB tokens.
   *
   * @throws {MissingSignerError} If a `signer` was not provided when instantiating the `OrderBuilder`.
   */
  allowance: () => Promise<bigint>;

  /**
   * Approve the contract to transfer the USDB tokens.
   *
   * @param {bigint} amount - The amount of USDB tokens to approve for, defaults to `MaxUint256`.
   * @returns {Promise<ContractTransactionResponse>} The ethers' transaction response.
   *
   * @throws {MissingSignerError} If a `signer` was not provided when instantiating the `OrderBuilder`.
   */
  approve: (amount?: bigint) => Promise<ContractTransactionResponse>;
}

export type Approval = Erc1155Approval | Erc20Approval;

export interface Approvals {
  erc1155Approvals: NonEmptyArray<Erc1155Approval>;
  erc20Approvals: NonEmptyArray<Erc20Approval>;
}

/**
 * Type utils
 */

export type Pretty<T> = {
  [K in keyof T]: T[K];
} extends infer U
  ? U
  : never;

export type Optional<T, K extends keyof T> = Pretty<Pick<Partial<T>, K> & Omit<T, K>>;

export type NonEmptyArray<T> = [T, ...T[]];
