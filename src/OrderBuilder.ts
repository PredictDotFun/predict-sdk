import type {
  Addresses,
  BuildOrderInput,
  EIP712TypedData,
  Order,
  OrderStrategy,
  MarketHelperInput,
  Book,
  DepthLevel,
  OrderAmounts,
  ProcessedBookAmounts,
  SignedOrder,
  LimitHelperInput,
  Erc1155Approval,
  Erc20Approval,
  Approval,
  MulticallContracts,
  TransactionResult,
  CancelOrdersOptions,
  SetApprovalsResult,
} from "./Types";
import type { AbstractProvider, BaseWallet, BigNumberish } from "ethers";
import type { ChainId } from "./Constants";
import type {
  BlastConditionalTokens,
  BlastCTFExchange,
  BlastNegRiskAdapter,
  BlastNegRiskCtfExchange,
  ERC20,
} from "./typechain";
import type { OrderStruct } from "./typechain/BlastCTFExchange";
import type { ContractFunction, Optional } from "./internal/Types";
import { BaseContract, MaxInt256, MaxUint256, parseEther, TypedDataEncoder, ZeroAddress } from "ethers";
import { MulticallWrapper } from "ethers-multicall-provider";
import {
  FailedOrderSignError,
  FailedTypedDataEncoderError,
  InvalidExpirationError,
  InvalidNegRiskConfig,
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
  private contracts: MulticallContracts | undefined;
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
    this.addresses = options?.addresses ?? AddressesByChainId[chainId];
    this.generateOrderSalt = options?.generateSalt ?? generateOrderSalt;
    this.precision = options?.precision ? 10n ** BigInt(options.precision) : BigInt(1e18);

    if (this.signer) {
      const provider = this.signer.provider ?? ProviderByChainId[chainId];
      const multicallProvider = MulticallWrapper.wrap(provider as AbstractProvider);

      if (!this.signer.provider) {
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
        multicall: {
          CTF_EXCHANGE: ctfExchange.connect(multicallProvider) as BlastCTFExchange,
          NEG_RISK_CTF_EXCHANGE: negRiskCtfExchange.connect(multicallProvider) as BlastNegRiskCtfExchange,
          NEG_RISK_ADAPTER: negRiskAdapter.connect(multicallProvider) as BlastNegRiskAdapter,
          CONDITIONAL_TOKENS: conditionalTokens.connect(multicallProvider) as BlastConditionalTokens,
          USDB: usdb.connect(multicallProvider) as ERC20,
        },
      };
    }
  }

  /**
   * Helper function to handle transactions safely.
   *
   * @private
   * @async
   * @param {ContractFunction<T>} fn - The contract function to execute.
   * @param {...T} args - The arguments to pass to the contract function.
   * @returns {Promise<TransactionResult>} The result of the transaction.
   *
   * @throws {MissingSignerError} If a `signer` was not provided when instantiating the `OrderBuilder`.
   */
  private async handleTransaction<T extends unknown[]>(
    fn: ContractFunction<T>,
    ...args: T
  ): Promise<TransactionResult> {
    if (this.contracts === undefined) {
      throw new MissingSignerError();
    }

    try {
      const estimatedGas = await fn.estimateGas(...args);
      const transactionArgs = [...args, { gasLimit: (estimatedGas * 125n) / 100n }] as T;

      const tx = await fn(...transactionArgs);
      const receipt = await tx.wait(1);

      return receipt?.status === 1 ? { success: true, receipt } : { success: false, receipt };
    } catch (error) {
      return { success: false, cause: error as Error };
    }
  }

  private getApprovalOps(key: keyof Addresses, type: "ERC1155"): Erc1155Approval;
  private getApprovalOps(key: keyof Addresses, type: "ERC20"): Erc20Approval;

  /**
   * Helper function to get the approval operations for the given contract and type.
   *
   * @private
   * @param {keyof Addresses} key - The key of the contract in the `Addresses` object.
   * @param {"ERC1155" | "ERC20"} type - The type of approval to get.
   * @returns {Approval} The approval operations for the given contract and type.
   *
   * @throws {MissingSignerError} If a `signer` was not provided when instantiating the `OrderBuilder`.
   */
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
          setApprovalForAll: (approved: boolean = true) =>
            this.handleTransaction(contract.setApprovalForAll, address, approved),
        };
      }
      case "ERC20": {
        const contract = this.contracts.USDB;

        return {
          allowance: () => contract.allowance(this.signer!.address, address),
          approve: (amount: bigint = MaxUint256) => this.handleTransaction(contract.approve, address, amount),
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
   *
   * @remarks The current `feeRateBps` should be fetched via the `GET /markets` endpoint.
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
      feeRateBps: String(data.feeRateBps),
      side: data.side,
      signatureType: data.signatureType ?? SignatureType.EOA,
    };
  }

  /**
   * Builds the typed data for an order.
   *
   * @remarks The param `isNegRisk` can be found via the `GET /markets` or `GET /categories` endpoints.
   *
   * @param {Order} order - The order to build the typed data for.
   * @param {boolean} options.isNegRisk - Whether the order is for a neg risk market (winner takes all).
   * @returns {EIP712TypedData} The typed data for the order.
   */
  buildTypedData(order: Order, options: { isNegRisk: boolean }): EIP712TypedData {
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
        verifyingContract: options.isNegRisk ? this.addresses.NEG_RISK_CTF_EXCHANGE : this.addresses.CTF_EXCHANGE,
      },
      message: {
        ...order,
      } satisfies Order,
    };
  }

  /**
   * Signs an order using the EIP-712 typed data standard.
   * @remarks The param `isNegRisk` can be found via the `GET /markets` endpoint.
   *
   * @async
   * @param {EIP712TypedData} typedData - The typed data for the order to sign.
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
   * @param {boolean} [approved=true] - Whether to approve the CTF Exchange to transfer the Conditional Tokens.
   * @returns {Promise<TransactionResult>} The result of the approval transaction.
   *
   * @throws {MissingSignerError} If a `signer` was not provided when instantiating the `OrderBuilder`.
   */
  async setCtfExchangeApproval(approved: boolean = true): Promise<TransactionResult> {
    const { isApprovedForAll, setApprovalForAll } = this.getApprovalOps("CTF_EXCHANGE", "ERC1155");

    const isApproved = await isApprovedForAll();

    if (isApproved !== approved) {
      return setApprovalForAll(approved);
    }

    return { success: true };
  }

  /**
   * Check and manage the approval for the Neg Risk CTF Exchange to transfer the Conditional Tokens.
   *
   * @param {boolean} [approved=true] - Whether to approve the Neg Risk CTF Exchange to transfer the Conditional Tokens.
   * @returns {Promise<TransactionResult>} The result of the approval transaction.
   *
   * @throws {MissingSignerError} If a `signer` was not provided when instantiating the `OrderBuilder`.
   */
  async setNegRiskCtfExchangeApproval(approved: boolean = true): Promise<TransactionResult> {
    const { isApprovedForAll, setApprovalForAll } = this.getApprovalOps("NEG_RISK_CTF_EXCHANGE", "ERC1155");

    const isApproved = await isApprovedForAll();

    if (isApproved !== approved) {
      return setApprovalForAll(approved);
    }

    return { success: true };
  }

  /**
   * Check and manage the approval for the Neg Risk Adapter to transfer the Conditional Tokens.
   *
   * @param {boolean} [approved=true] - Whether to approve the Neg Risk Adapter to transfer the Conditional Tokens.
   * @returns {Promise<TransactionResult>} The result of the approval transaction.
   *
   * @throws {MissingSignerError} If a `signer` was not provided when instantiating the `OrderBuilder`.
   */
  async setNegRiskAdapterApproval(approved: boolean = true): Promise<TransactionResult> {
    const { isApprovedForAll, setApprovalForAll } = this.getApprovalOps("NEG_RISK_ADAPTER", "ERC1155");

    const isApproved = await isApprovedForAll();

    if (isApproved !== approved) {
      return setApprovalForAll(approved);
    }

    return { success: true };
  }

  /**
   * Check and manage the approval for the CTF Exchange to transfer the USDB collateral.
   *
   * @param {bigint} [minAmount=MaxInt256] - The minimum amount of USDB tokens to approve for.
   * @param {bigint} [maxAmount=MaxUint256] - The maximum amount of USDB tokens to approve for.
   * @returns {Promise<TransactionResult>} The result of the approval transaction.
   *
   * @throws {MissingSignerError} If a `signer` was not provided when instantiating the `OrderBuilder`.
   */
  async setCtfExchangeAllowance(
    minAmount: bigint = MaxInt256,
    maxAmount: bigint = MaxUint256,
  ): Promise<TransactionResult> {
    const { allowance, approve } = this.getApprovalOps("CTF_EXCHANGE", "ERC20");

    const currentAllowance = await allowance();

    if (currentAllowance < minAmount) {
      return approve(maxAmount);
    }

    return { success: true };
  }

  /**
   * Check and manage the approval for the Neg Risk CTF Exchange to transfer the USDB collateral.
   *
   * @param {bigint} [minAmount=MaxInt256] - The minimum amount of USDB tokens to approve for.
   * @param {bigint} [maxAmount=MaxUint256] - The maximum amount of USDB tokens to approve for.
   * @returns {Promise<TransactionResult>} The result of the approval transaction.
   *
   * @throws {MissingSignerError} If a `signer` was not provided when instantiating the `OrderBuilder`.
   */
  async setNegRiskCtfExchangeAllowance(
    minAmount: bigint = MaxInt256,
    maxAmount: bigint = MaxUint256,
  ): Promise<TransactionResult> {
    const { allowance, approve } = this.getApprovalOps("NEG_RISK_CTF_EXCHANGE", "ERC20");

    const currentAllowance = await allowance();

    if (currentAllowance < minAmount) {
      return approve(maxAmount);
    }

    return { success: true };
  }

  /**
   * Sets all necessary approvals for trading on the Predict protocol.
   *
   * @returns {Promise<SetApprovalsResult>} An object containing:
   *   - success: A boolean indicating if all approvals were successful.
   *   - transactions: An array of TransactionResult objects for each approval operation.
   *
   * @throws {MissingSignerError} If a signer was not provided when instantiating the OrderBuilder.
   */

  async setApprovals(): Promise<SetApprovalsResult> {
    const results: TransactionResult[] = [];
    const approvals = [
      this.setCtfExchangeApproval.bind(this),
      this.setNegRiskCtfExchangeApproval.bind(this),
      this.setNegRiskAdapterApproval.bind(this),
      this.setCtfExchangeAllowance.bind(this),
      this.setNegRiskCtfExchangeAllowance.bind(this),
    ];

    for (const approval of approvals) {
      const result = await approval();
      results.push(result);
    }

    const success = results.every((r) => r.success);

    return { success, transactions: results };
  }

  /**
   * Cancels orders for the CTF Exchange or Neg Risk CTF Exchange.
   *
   * @private
   * @async
   * @param {BlastCTFExchange["cancelOrders"]} cancelOrders - The function to cancel the orders.
   * @param {Order[]} orders - The orders to cancel.
   * @returns {Promise<TransactionResult>} The result of the cancellation.
   *
   * @throws {MissingSignerError} If a `signer` was not provided when instantiating the `OrderBuilder`.
   */
  private async _cancelOrders(
    cancelOrders: BlastCTFExchange["cancelOrders"],
    orders: Order[],
  ): Promise<TransactionResult> {
    const orderStructs = orders as OrderStruct[];
    if (orderStructs.length === 0) {
      return { success: true };
    }

    return this.handleTransaction(cancelOrders, orderStructs);
  }

  /**
   * Validates the token IDs against the CTF Exchange or Neg Risk CTF Exchange based on the `isNegRisk` flag.
   *
   * @async
   * @param {BigNumberish[]} tokenIds - The token IDs to validate.
   * @param {boolean} isNegRisk - Whether the order is for a multi-outcome market.
   * @returns {Promise<boolean>} Whether the token IDs are valid.
   *
   * @throws {MissingSignerError} If a `signer` was not provided when instantiating the `OrderBuilder`.
   */
  async validateTokenIds(tokenIds: BigNumberish[], isNegRisk: boolean): Promise<boolean> {
    if (!this.contracts) {
      throw new MissingSignerError();
    }

    const multicall = this.contracts.multicall;
    const validations = tokenIds.map((tokenId) =>
      isNegRisk
        ? multicall.NEG_RISK_CTF_EXCHANGE.validateTokenId(tokenId)
        : multicall.CTF_EXCHANGE.validateTokenId(tokenId),
    );

    const results = await Promise.allSettled(validations);
    return results.every((result) => result.status === "fulfilled");
  }

  /**
   * Cancels orders for the CTF Exchange. (isNegRisk: false)
   *
   * @async
   * @param {Order[]} orders - The orders to cancel.
   * @param {CancelOrdersOptions} [options] - The options for the cancellation.
   * @returns {Promise<TransactionResult>} The result of the cancellation.
   *
   * @throws {MissingSignerError} If a `signer` was not provided when instantiating the `OrderBuilder`.
   * @throws {InvalidNegRiskConfig} If the token IDs are invalid for the CTF Exchange.
   */
  async cancelOrders(orders: Order[], options?: CancelOrdersOptions): Promise<TransactionResult> {
    if (!this.contracts) {
      throw new MissingSignerError();
    }

    if (options?.withValidation ?? true) {
      const tokenIds = orders.map((order) => order.tokenId);
      const isValid = await this.validateTokenIds(tokenIds, false);

      if (!isValid) {
        throw new InvalidNegRiskConfig();
      }
    }

    const cancelOrders = this.contracts.CTF_EXCHANGE.cancelOrders;
    return this._cancelOrders(cancelOrders, orders);
  }

  /**
   * Cancels orders for the Neg Risk CTF Exchange. (isNegRisk: true)
   *
   * @async
   * @param {Order[]} orders - The orders to cancel.
   * @param {CancelOrdersOptions} [options] - The options for the cancellation.
   * @returns {Promise<TransactionResult>} The result of the cancellation.
   *
   * @throws {MissingSignerError} If a `signer` was not provided when instantiating the `OrderBuilder`.
   * @throws {InvalidNegRiskConfig} If the token IDs are invalid for the Neg Risk CTF Exchange.
   */
  async cancelNegRiskOrders(orders: Order[], options?: CancelOrdersOptions): Promise<TransactionResult> {
    if (!this.contracts) {
      throw new MissingSignerError();
    }

    if (options?.withValidation ?? true) {
      const tokenIds = orders.map((order) => order.tokenId);
      const isValid = await this.validateTokenIds(tokenIds, true);

      if (!isValid) {
        throw new InvalidNegRiskConfig();
      }
    }

    const cancelOrders = this.contracts.NEG_RISK_CTF_EXCHANGE.cancelOrders;
    return this._cancelOrders(cancelOrders, orders);
  }
}
