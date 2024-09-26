import type {
  Addresses,
  BuildOrderInput,
  EIP712TypedData,
  Order,
  OrderConfig,
  OrderStrategy,
  MarketHelperInput,
  Book,
  Optional,
  DepthLevel,
  OrderAmounts,
  ProcessedBookAmounts,
  SignedOrder,
  LimitHelperInput,
  Contracts,
  Erc1155Approval,
  Erc20Approval,
  Approval,
  Approvals,
} from "./Types";
import type { BaseWallet } from "ethers";
import type { ChainId } from "./Constants";
import type {
  BlastConditionalTokens,
  BlastCTFExchange,
  BlastNegRiskAdapter,
  BlastNegRiskCtfExchange,
  ERC20,
} from "./typechain";
import { BaseContract, MaxUint256, parseEther, TypedDataEncoder, ZeroAddress } from "ethers";
import {
  FailedOrderSignError,
  FailedTypedDataEncoderError,
  InvalidExpirationError,
  InvalidQuantityError,
  MissingSignerError,
} from "./Errors";
import {
  Side,
  EIP712_DOMAIN,
  ORDER_STRUCTURE,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  SignatureType,
  AddressesByChainId,
  OrderConfigByChainId,
  MAX_SALT,
  FIVE_MINUTES_SECONDS,
  ProviderByChainId,
} from "./Constants";
import {
  BlastConditionalTokensAbi,
  BlastCTFExchangeAbi,
  BlastNegRiskAdapterAbi,
  BlastNegRiskCtfExchangeAbi,
  ERC20Abi,
} from "./abis";

/**
 * @remarks The precision represents the number of decimals supported. By default, it's set to 18 (for wei).
 */
interface OrderBuilderOptions {
  addresses?: Addresses;
  orderConfig?: OrderConfig;
  precision?: number;
  generateSalt?: () => string;
}

/**
 * Default function to generate a random salt for the order.
 *
 * @returns {string} A random numeric string value for the salt.
 */
export const generateOrderSalt = (): string => {
  return String(Math.round(Math.random() * MAX_SALT));
};

/**
 * Helper class to build orders.
 */
export class OrderBuilder {
  private precision: bigint;
  private addresses: Addresses;
  private orderConfig: OrderConfig;
  private contracts: Contracts | undefined;
  private generateOrderSalt: () => string;

  /**
   * Constructor for the OrderBuilder class.
   * @param {ChainId} chainId - The chain ID for the network.
   * @param {BaseWallet} [signer] - Optional signer object for signing orders.
   * @param {OrderBuilderOptions} [options] - Optional order configuration options; default values are specific for Predict.
   */
  constructor(
    private readonly chainId: ChainId,
    private readonly signer?: BaseWallet,
    private readonly options?: OrderBuilderOptions,
  ) {
    this.orderConfig = options?.orderConfig ?? OrderConfigByChainId[chainId];
    this.addresses = options?.addresses ?? AddressesByChainId[chainId];
    this.generateOrderSalt = options?.generateSalt ?? generateOrderSalt;
    this.precision = options?.precision ? 10n ** BigInt(options.precision) : BigInt(1e18);

    if (this.signer) {
      if (!this.signer.provider) {
        const provider = ProviderByChainId[chainId];
        this.signer = this.signer.connect(provider);
      }

      const ctfExchange = new BaseContract(this.addresses.CTF_EXCHANGE, BlastCTFExchangeAbi);
      const negRiskCtfExchange = new BaseContract(this.addresses.NEG_RISK_CTF_EXCHANGE, BlastNegRiskCtfExchangeAbi);
      const negRiskAdapter = new BaseContract(this.addresses.NEG_RISK_ADAPTER, BlastNegRiskAdapterAbi);
      const conditionalTokens = new BaseContract(this.addresses.CONDITIONAL_TOKENS, BlastConditionalTokensAbi);
      const usdb = new BaseContract(this.addresses.USDB, ERC20Abi);

      this.contracts = {
        CTF_EXCHANGE: ctfExchange.connect(this.signer) as BlastCTFExchange,
        NEG_RISK_CTF_EXCHANGE: negRiskCtfExchange.connect(this.signer) as BlastNegRiskCtfExchange,
        NEG_RISK_ADAPTER: negRiskAdapter.connect(this.signer) as BlastNegRiskAdapter,
        CONDITIONAL_TOKENS: conditionalTokens.connect(this.signer) as BlastConditionalTokens,
        USDB: usdb.connect(this.signer) as ERC20,
      };
    }
  }

  private getApprovalOps(key: keyof Addresses, type: "ERC1155"): Erc1155Approval;
  private getApprovalOps(key: keyof Addresses, type: "ERC20"): Erc20Approval;

  private getApprovalOps(key: keyof Addresses, type: "ERC1155" | "ERC20"): Approval {
    const address = this.addresses[key];

    if (this.contracts === undefined) {
      throw new MissingSignerError();
    }

    switch (type) {
      case "ERC1155": {
        const contract = this.contracts.CONDITIONAL_TOKENS;

        return {
          isApprovedForAll: () => contract.isApprovedForAll(this.signer!.address, address),
          setApprovalForAll: (approved: boolean = true) => contract.setApprovalForAll(address, approved),
        };
      }
      case "ERC20": {
        const contract = this.contracts.USDB;

        return {
          allowance: () => contract.allowance(this.signer!.address, address),
          approve: (amount: bigint = MaxUint256) => contract.approve(address, amount),
        };
      }
    }
  }

  /**
   * Processes the order book to help derive the average price and last price to be used for a MARKET strategy order.
   *
   * @private
   * @param {DepthLevel[]} depths - Array of price levels and their quantities, sorted by price in ascending order.
   * @param {bigint} quantityWei - The total quantity of shares being bought or sold in wei.
   * @returns {ProcessedBookAmounts} An object containing the total quantity, total cost, and last price.
   */
  private processBook(depths: DepthLevel[], quantityWei: bigint): ProcessedBookAmounts {
    const reduceInit = { quantityWei: 0n, priceWei: 0n, lastPriceWei: 0n };

    return depths.reduce((acc, [price, qty]) => {
      const remainingQtyWei = quantityWei - acc.quantityWei;
      const priceWei = parseEther(price.toString());
      const qtyWei = parseEther(qty.toString());

      if (remainingQtyWei <= 0n) {
        return acc;
      }

      return remainingQtyWei < qtyWei
        ? {
            quantityWei: acc.quantityWei + remainingQtyWei,
            priceWei: acc.priceWei + (priceWei * remainingQtyWei) / this.precision,
            lastPriceWei: priceWei,
          }
        : {
            quantityWei: acc.quantityWei + qtyWei,
            priceWei: acc.priceWei + (priceWei * qtyWei) / this.precision,
            lastPriceWei: priceWei,
          };
    }, reduceInit);
  }

  /**
   * Helper function to calculate the amounts for a LIMIT strategy order.
   *
   * @param {LimitHelperInput} data - The data required to calculate the amounts.
   * @returns {OrderAmounts} An object containing the price per share (as per input), maker amount, and taker amount.
   *
   * @throws {InvalidQuantityError} quantityWei must be greater than 1e18.
   */
  getLimitOrderAmounts(data: LimitHelperInput): OrderAmounts {
    if (data.quantityWei < BigInt(1e16)) {
      throw new InvalidQuantityError();
    }

    switch (data.side) {
      case Side.BUY: {
        return {
          pricePerShare: data.pricePerShareWei,
          makerAmount: (data.pricePerShareWei * data.quantityWei) / this.precision,
          takerAmount: data.quantityWei,
        };
      }
      case Side.SELL: {
        return {
          pricePerShare: data.pricePerShareWei,
          makerAmount: data.quantityWei,
          takerAmount: (data.pricePerShareWei * data.quantityWei) / this.precision,
        };
      }
    }
  }

  /**
   * Helper function to calculate the amounts for a MARKET strategy order.
   * @remarks The order book should be retrieved from the `GET /orderbook/{marketId}` endpoint.
   *
   * @param {MarketHelperInput} data - The data required to calculate the amounts.
   * @param {Book} book - The order book to use for the calculation. The depth levels sorted by price in ascending order.
   * @returns {OrderAmounts} An object containing the average price per share, maker amount, and taker amount.
   *
   * @throws {InvalidQuantityError} quantityWei must be greater than 1e18.
   */
  getMarketOrderAmounts(data: MarketHelperInput, book: Optional<Book, "marketId">): OrderAmounts {
    const { updateTimestampMs, asks, bids } = book;

    if (Date.now() - updateTimestampMs > FIVE_MINUTES_SECONDS * 1000) {
      console.warn("[WARN]: Order book is potentially stale. Consider using a more recent one.");
    }

    if (data.quantityWei < BigInt(1e16)) {
      throw new InvalidQuantityError();
    }

    switch (data.side) {
      case Side.BUY: {
        const { priceWei, quantityWei, lastPriceWei } = this.processBook(asks, data.quantityWei);
        return {
          pricePerShare: (priceWei * this.precision) / quantityWei,
          makerAmount: (lastPriceWei * quantityWei) / this.precision,
          takerAmount: quantityWei,
        };
      }
      case Side.SELL: {
        const { priceWei, quantityWei, lastPriceWei } = this.processBook(bids, data.quantityWei);
        return {
          pricePerShare: (priceWei * this.precision) / quantityWei,
          makerAmount: quantityWei,
          takerAmount: (lastPriceWei * quantityWei) / this.precision,
        };
      }
    }
  }

  /**
   * Builds an order based on the provided strategy and order data.
   * @remarks The expiration for market orders is ignored.
   *
   * @param {OrderStrategy} strategy - The order strategy (e.g., 'MARKET' or 'LIMIT').
   * @param {BuildOrderInput} data - The data required to build the order; some fields are optional.
   * @returns {Order} The constructed order object.
   *
   * @throws {InvalidExpirationError} If the expiration is not in the future.
   */
  buildOrder(strategy: OrderStrategy, data: BuildOrderInput): Order {
    // The fallback date is an arbitrary date to represents an order without an expiration, any date can be used.
    const expiresAt = data.expiresAt ?? new Date("2100-01-01T00:00:00Z");

    const limitExpiration = Math.floor(expiresAt.getTime() / 1000);
    const marketExpiration = Math.floor(Date.now() / 1000 + FIVE_MINUTES_SECONDS);

    if (strategy === "MARKET" && data.expiresAt) {
      console.warn("[WARN]: expiresAt for market orders is ignored.");
    }

    if (strategy !== "MARKET" && expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new InvalidExpirationError();
    }

    return {
      salt: String(data.salt ?? this.generateOrderSalt()),
      maker: data?.maker ?? data.signer,
      signer: data.signer,
      taker: data.taker ?? ZeroAddress,
      tokenId: String(data.tokenId),
      makerAmount: String(data.makerAmount),
      takerAmount: String(data.takerAmount),
      expiration: String(strategy === "MARKET" ? marketExpiration : limitExpiration),
      nonce: String(data.nonce ?? 0n),
      feeRateBps: String(data.feeRateBps ?? this.orderConfig.feeRateBps),
      side: data.side,
      signatureType: data.signatureType ?? SignatureType.EOA,
    };
  }

  /**
   * Builds the typed data for an order.
   *
   * @remarks The param `isMultiOutcome` can be found via the `GET /markets` endpoint.
   *
   * @param {Order} order - The order to build the typed data for.
   * @param {boolean} isMultiOutcome - Whether the order is for a multi-outcome market.
   * @returns {EIP712TypedData} The typed data for the order.
   */
  buildTypedData(order: Order, isMultiOutcome: boolean): EIP712TypedData {
    return {
      primaryType: "Order",
      types: {
        EIP712Domain: EIP712_DOMAIN,
        Order: ORDER_STRUCTURE,
      },
      domain: {
        name: PROTOCOL_NAME,
        version: PROTOCOL_VERSION,
        chainId: this.chainId,
        verifyingContract: isMultiOutcome ? this.addresses.NEG_RISK_CTF_EXCHANGE : this.addresses.CTF_EXCHANGE,
      },
      message: {
        ...order,
      } satisfies Order,
    };
  }

  /**
   * Signs an order using the EIP-712 typed data standard.
   * @remarks The param `isMultiOutcome` can be found via the `GET /markets` endpoint.
   *
   * @async
   * @param {Order} order - The order to sign.
   * @param {boolean} isMultiOutcome - Whether the order is for a multi-outcome market.
   * @returns {Promise<SignedOrder>} The signed order.
   *
   * @throws {MissingSignerError} If a `signer` was not provided when instantiating the `OrderBuilder`.
   * @throws {FailedOrderSignError} If ethers's `signTypedData` failed. See `cause` for more details.
   */
  async signTypedDataOrder(typedData: EIP712TypedData): Promise<SignedOrder> {
    if (!this.signer) {
      throw new MissingSignerError();
    }

    const order = typedData.message as unknown as Order;
    const { EIP712Domain: _, ...typedDataTypes } = typedData.types;

    try {
      const signature = await this.signer.signTypedData(typedData.domain, typedDataTypes, typedData.message);

      return { ...order, signature };
    } catch (error) {
      throw new FailedOrderSignError(error as Error);
    }
  }

  /**
   * Builds the typed data hash.
   *
   * @param {EIP712TypedData} typedData - The typed data to hash.
   * @returns {string} The hash of the typed data.
   *
   * @throws {FailedTypedDataEncoderError} If ethers's `hashTypedData` failed. See `cause` for more details.
   */
  buildTypedDataHash(typedData: EIP712TypedData): string {
    const { EIP712Domain: _, ...typedDataTypes } = typedData.types;

    try {
      return TypedDataEncoder.hash(typedData.domain, typedDataTypes, typedData.message);
    } catch (error) {
      throw new FailedTypedDataEncoderError(error as Error);
    }
  }

  /**
   * Check and manage the approval for the CTF Exchange to transfer the Conditional Tokens.
   *
   * @returns {Erc1155Approval} The functions `isApprovedForAll` and `setApprovalForAll` for the CTF Exchange.
   */
  ctfExchangeApproval(): Erc1155Approval {
    return this.getApprovalOps("CTF_EXCHANGE", "ERC1155");
  }

  /**
   * Check and manage the approval for the Neg Risk CTF Exchange to transfer the Conditional Tokens.
   *
   * @returns {Erc1155Approval} The functions `isApprovedForAll` and `setApprovalForAll` for the Neg Risk CTF Exchange.
   */
  negRiskCtfExchangeApproval(): Erc1155Approval {
    return this.getApprovalOps("NEG_RISK_CTF_EXCHANGE", "ERC1155");
  }

  /**
   * Check and manage the approval for the Neg Risk Adapter to transfer the Conditional Tokens.
   *
   * @returns {Erc1155Approval} The functions `isApprovedForAll` and `setApprovalForAll` for the Neg Risk Adapter.
   */
  negRiskAdapterApproval(): Erc1155Approval {
    return this.getApprovalOps("NEG_RISK_ADAPTER", "ERC1155");
  }

  /**
   * Check and manage the approval for the CTF Exchange to transfer the USDB collateral.
   *
   * @returns {Erc20Approval} The functions `allowance` and `approve` for the CTF Exchange.
   */
  ctfExchangeAllowance(): Erc20Approval {
    return this.getApprovalOps("CTF_EXCHANGE", "ERC20");
  }

  /**
   * Check and manage the approval for the Neg Risk CTF Exchange to transfer the USDB collateral.
   *
   * @returns {Erc20Approval} The functions `allowance` and `approve` for the Neg Risk CTF Exchange.
   */
  negRiskCtfExchangeAllowance(): Erc20Approval {
    return this.getApprovalOps("NEG_RISK_CTF_EXCHANGE", "ERC20");
  }

  /**
   * Check and manage all the approvals required to interact with the Predict's protocol.
   *
   * @returns {Approvals} The functions to check and manage the approvals for ERC1155 (Conditional Tokens) and ERC20 (USDB).
   */
  getApprovals(): Approvals {
    return {
      erc1155Approvals: [this.ctfExchangeApproval(), this.negRiskCtfExchangeApproval(), this.negRiskAdapterApproval()],
      erc20Approvals: [this.ctfExchangeAllowance(), this.negRiskCtfExchangeAllowance()],
    };
  }
}
