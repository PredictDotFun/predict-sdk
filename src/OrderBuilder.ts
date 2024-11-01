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
  Address,
} from "./Types";
import type { AbstractProvider, BaseWallet, BigNumberish } from "ethers";
import type { ChainId } from "./Constants";
import type {
  BlastConditionalTokens,
  BlastCTFExchange,
  BlastNegRiskAdapter,
  BlastNegRiskCtfExchange,
  ECDSAValidator,
  ERC20,
  Kernel,
} from "./typechain";
import type { OrderStruct } from "./typechain/BlastCTFExchange";
import type { ContractFunction, Optional } from "./internal/Types";
import {
  concat,
  hashMessage,
  MaxInt256,
  MaxUint256,
  parseEther,
  toBeHex,
  TypedDataEncoder,
  ZeroAddress,
  ZeroHash,
} from "ethers";
import { MulticallWrapper } from "ethers-multicall-provider";
import { makeContract, eip712WrapHash } from "./internal/Utils";
import {
  FailedOrderSignError,
  FailedTypedDataEncoderError,
  InvalidExpirationError,
  InvalidNegRiskConfig,
  InvalidQuantityError,
  InvalidSignerError,
  MakerSignerMismatchError,
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
  KernelDomainByChainId,
  MAX_SALT,
  FIVE_MINUTES_SECONDS,
  ProviderByChainId,
} from "./Constants";
import {
  BlastConditionalTokensAbi,
  BlastCTFExchangeAbi,
  BlastNegRiskAdapterAbi,
  BlastNegRiskCtfExchangeAbi,
  ECDSAValidatorAbi,
  ERC20Abi,
  KernelAbi,
} from "./abis";

/**
 * @remarks The precision represents the number of decimals supported. By default, it's set to 18 (for wei).
 * @remarks When defining a `predictAccount` address the `OrderBuilder` signer must be the Privy exported wallet, from the account's settings.
 */
interface OrderBuilderOptions {
  addresses?: Addresses;
  precision?: number;
  /**
   * When defining a `predictAccount` address the `OrderBuilder` signer must be the Privy exported wallet, from the account's settings.
   */
  predictAccount?: Address;
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
 *
 * To create a new instance of the `OrderBuilder` class, call the async `make` method.
 */
export class OrderBuilder {
  private readonly executionMode = ZeroHash;

  /**
   * Initializes a new instance of the OrderBuilder class.
   *
   * @async
   * @param {ChainId} chainId - The chain ID for the network.
   * @param {BaseWallet} [signer] - Optional signer object for signing orders.
   * @param {OrderBuilderOptions} [options] - Optional order configuration options; default values are specific for Predict.
   */
  static async make(chainId: ChainId, signer?: BaseWallet, options?: OrderBuilderOptions): Promise<OrderBuilder> {
    let contracts: MulticallContracts | undefined = undefined;
    const addresses = options?.addresses ?? AddressesByChainId[chainId];
    const generateSalt = options?.generateSalt ?? generateOrderSalt;
    const precision = options?.precision ? 10n ** BigInt(options.precision) : BigInt(1e18);
    const predictAccount = options?.predictAccount;

    if (signer) {
      const provider = signer.provider ?? ProviderByChainId[chainId];
      const multicallProvider = MulticallWrapper.wrap(provider as AbstractProvider);

      if (!signer.provider) {
        signer = signer.connect(provider);
      }

      const ctfExchange = makeContract<BlastCTFExchange>(addresses.CTF_EXCHANGE, BlastCTFExchangeAbi);
      const negRiskAdapter = makeContract<BlastNegRiskAdapter>(addresses.NEG_RISK_ADAPTER, BlastNegRiskAdapterAbi);
      const usdb = makeContract<ERC20>(addresses.USDB, ERC20Abi);
      const kernel = makeContract<Kernel>(predictAccount ?? addresses.KERNEL, KernelAbi);
      const validator = makeContract<ECDSAValidator>(addresses.ECDSA_VALIDATOR, ECDSAValidatorAbi);
      const conditionalTokens = makeContract<BlastConditionalTokens>(
        addresses.CONDITIONAL_TOKENS,
        BlastConditionalTokensAbi,
      );
      const negRiskCtfExchange = makeContract<BlastNegRiskCtfExchange>(
        addresses.NEG_RISK_CTF_EXCHANGE,
        BlastNegRiskCtfExchangeAbi,
      );

      contracts = {
        CTF_EXCHANGE: ctfExchange(signer),
        NEG_RISK_CTF_EXCHANGE: negRiskCtfExchange(signer),
        NEG_RISK_ADAPTER: negRiskAdapter(signer),
        CONDITIONAL_TOKENS: conditionalTokens(signer),
        USDB: usdb(signer),
        KERNEL: kernel(signer),
        ECDSA_VALIDATOR: validator(signer),
        multicall: {
          CTF_EXCHANGE: ctfExchange(multicallProvider),
          NEG_RISK_CTF_EXCHANGE: negRiskCtfExchange(multicallProvider),
          NEG_RISK_ADAPTER: negRiskAdapter(multicallProvider),
          CONDITIONAL_TOKENS: conditionalTokens(multicallProvider),
          USDB: usdb(multicallProvider),
          KERNEL: kernel(multicallProvider),
          ECDSA_VALIDATOR: validator(multicallProvider),
        },
      };

      if (predictAccount) {
        const contract = contracts.ECDSA_VALIDATOR.contract;
        const owner = await contract.ecdsaValidatorStorage(predictAccount);

        if (owner !== signer.address) {
          throw new InvalidSignerError();
        }
      }
    }

    return new OrderBuilder(chainId, precision, addresses, generateSalt, signer, contracts, predictAccount);
  }

  constructor(
    private readonly chainId: ChainId,
    private readonly precision: bigint,
    private readonly addresses: Addresses,
    private readonly generateOrderSalt: () => string,
    private readonly signer?: BaseWallet,
    private readonly contracts?: MulticallContracts,
    private readonly predictAccount?: Address,
  ) {}

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

  /**
   * Helper function to encode the calldata for the `execute` function.
   *
   * @private
   * @param {string} to - The address of the contract to execute the calldata on.
   * @param {string} calldata - The calldata to execute.
   * @param {bigint} [value] - The value to send with the calldata. Defaults to 0.
   * @returns {string} The encoded calldata.
   */
  private encodeExecutionCalldata(to: string, calldata: string, value: bigint = 0n): string {
    return concat([to, toBeHex(value, 32), calldata]);
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

    if (this.predictAccount) {
      const kernel = this.contracts.KERNEL.contract;

      switch (type) {
        case "ERC1155": {
          const { contract, codec } = this.contracts.CONDITIONAL_TOKENS;

          return {
            isApprovedForAll: () => contract.isApprovedForAll(this.predictAccount!, address),
            setApprovalForAll: (approved: boolean = true) => {
              const encoded = codec.encodeFunctionData("setApprovalForAll", [address, approved]);
              const calldata = this.encodeExecutionCalldata(this.addresses.CONDITIONAL_TOKENS, encoded);

              return this.handleTransaction(kernel.execute, this.executionMode, calldata);
            },
          };
        }
        case "ERC20": {
          const { contract, codec } = this.contracts.USDB;

          return {
            allowance: () => contract.allowance(this.predictAccount!, address),
            approve: (amount: bigint = MaxUint256) => {
              const encoded = codec.encodeFunctionData("approve", [address, amount]);
              const calldata = this.encodeExecutionCalldata(this.addresses.USDB, encoded);

              return this.handleTransaction(kernel.execute, this.executionMode, calldata);
            },
          };
        }
      }
    } else {
      switch (type) {
        case "ERC1155": {
          const contract = this.contracts.CONDITIONAL_TOKENS.contract;

          return {
            isApprovedForAll: () => contract.isApprovedForAll(this.signer!.address, address),
            setApprovalForAll: (approved: boolean = true) =>
              this.handleTransaction(contract.setApprovalForAll, address, approved),
          };
        }
        case "ERC20": {
          const contract = this.contracts.USDB.contract;

          return {
            allowance: () => contract.allowance(this.signer!.address, address),
            approve: (amount: bigint = MaxUint256) => this.handleTransaction(contract.approve, address, amount),
          };
        }
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
   * Rounds down a BigInt number to the nearest multiple.
   *
   * @param num - The BigInt number to round.
   * @param multiple - The BigInt nearest multiple.
   * @returns The rounded BigInt number.
   */
  private roundDownToNearest(num: bigint, multiple: bigint = 10n ** 13n): bigint {
    return num - (num % multiple);
  }

  /**
   * Helper function to sign a message for a Predict account.
   *
   * @private
   * @async
   * @param {string} message - The message to sign.
   * @returns {Promise<string>} The signed message.
   *
   * @throws {MissingSignerError} If a `signer` or `predictAccount` was not provided when instantiating the `OrderBuilder`.
   */
  async signPredictAccountMessage(message: string | { raw: string }): Promise<string> {
    if (!this.signer || !this.predictAccount) {
      throw new MissingSignerError();
    }

    const validatorAddress = this.addresses.ECDSA_VALIDATOR;
    const kernelDomain = KernelDomainByChainId[this.chainId];

    const messageHash = typeof message === "string" ? hashMessage(message) : message.raw;
    const digest = eip712WrapHash(messageHash, { ...kernelDomain, verifyingContract: this.predictAccount });

    const messageBuffer = Buffer.from(digest.slice(2), "hex");
    const signedMessage = await this.signer!.signMessage(messageBuffer);

    return concat([concat(["0x01", validatorAddress]), signedMessage]);
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
          makerAmount: this.roundDownToNearest((data.pricePerShareWei * data.quantityWei) / this.precision),
          takerAmount: data.quantityWei,
        };
      }
      case Side.SELL: {
        return {
          pricePerShare: data.pricePerShareWei,
          makerAmount: data.quantityWei,
          takerAmount: this.roundDownToNearest((data.pricePerShareWei * data.quantityWei) / this.precision),
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

    if (this.predictAccount && (data?.maker || data?.signer)) {
      console.warn("[WARN]: When using a Predict account the maker and signer are ignored.");
    }

    if (strategy === "MARKET" && data.expiresAt) {
      console.warn("[WARN]: expiresAt for market orders is ignored.");
    }

    if (strategy !== "MARKET" && expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new InvalidExpirationError();
    }

    const signer = data?.signer ?? this.signer!.address;
    if (data?.maker && signer !== data.maker) {
      throw new MakerSignerMismatchError();
    }

    return {
      salt: String(data.salt ?? this.generateOrderSalt()),
      maker: this.predictAccount ?? data?.maker ?? signer,
      signer: this.predictAccount ?? signer,
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
   * @param {Order} order - The order to sign.
   * @param {boolean} isNegRisk - Whether the order is for a multi-outcome market.
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
      if (this.predictAccount) {
        const hash = this.buildTypedDataHash(typedData);
        const signature = await this.signPredictAccountMessage({ raw: hash });

        return { ...order, signature };
      } else {
        const signature = await this.signer.signTypedData(typedData.domain, typedDataTypes, typedData.message);

        return { ...order, signature };
      }
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
        ? multicall.NEG_RISK_CTF_EXCHANGE.contract.validateTokenId(tokenId)
        : multicall.CTF_EXCHANGE.contract.validateTokenId(tokenId),
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
    const orderStructs = orders as OrderStruct[];
    if (orderStructs.length === 0) {
      return { success: true };
    }

    if (!this.contracts) {
      throw new MissingSignerError();
    }

    if (options?.withValidation ?? true) {
      const tokenIds = orderStructs.map((order) => order.tokenId);
      const isValid = await this.validateTokenIds(tokenIds, false);

      if (!isValid) {
        throw new InvalidNegRiskConfig();
      }
    }

    const { contract, codec } = this.contracts.CTF_EXCHANGE;
    if (this.predictAccount) {
      const kernel = this.contracts.KERNEL.contract;
      const encoded = codec.encodeFunctionData("cancelOrders", [orderStructs]);
      const calldata = this.encodeExecutionCalldata(this.addresses.CTF_EXCHANGE, encoded);

      return this.handleTransaction(kernel.execute, this.executionMode, calldata);
    } else {
      return this.handleTransaction(contract.cancelOrders, orderStructs);
    }
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
    const orderStructs = orders as OrderStruct[];
    if (orderStructs.length === 0) {
      return { success: true };
    }

    if (!this.contracts) {
      throw new MissingSignerError();
    }

    if (options?.withValidation ?? true) {
      const tokenIds = orderStructs.map((order) => order.tokenId);
      const isValid = await this.validateTokenIds(tokenIds, true);

      if (!isValid) {
        throw new InvalidNegRiskConfig();
      }
    }

    const { contract, codec } = this.contracts.NEG_RISK_CTF_EXCHANGE;
    if (this.predictAccount) {
      const kernel = this.contracts.KERNEL.contract;
      const encoded = codec.encodeFunctionData("cancelOrders", [orderStructs]);
      const calldata = this.encodeExecutionCalldata(this.addresses.NEG_RISK_CTF_EXCHANGE, encoded);

      return this.handleTransaction(kernel.execute, this.executionMode, calldata);
    } else {
      return this.handleTransaction(contract.cancelOrders, orderStructs);
    }
  }
}
