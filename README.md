A TypeScript SDK to help developers interface with the Predict's protocol.

## Install

This package has [ethers v6](https://docs.ethers.io/v6/) as a peer dependency.

```bash
yarn add @predictdotfun/sdk ethers
```

```bash
npm install @predictdotfun/sdk ethers
```

See the [`OrderBuilder`](./src/OrderBuilder.ts) class for more in-depth details on each function.

## Set Approvals

Before trading, you need to set approvals for ERC-1155 (`ConditionalTokens`) and ERC-20 (`USDB`). This can be achieved by sending a transaction to the respective contracts (see the [Contracts](#contracts) section) and approving both the `CTF_EXCHANGE` and the `NEG_RISK_CTF_EXCHANGE` or via the SDK utils.

**Contracts**: The current deployed contracts can be found either in the [`Constants.ts`](./src/Constants.ts#26) file or in the [Deployed Contracts](https://docs.predict.fun/developers/deployed-contracts) documentation.

The following example demonstrates how to set the necessary approvals using the SDK utils.

```ts
import { Wallet, MaxInt256 } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";

// Create a wallet to sent the approvals transactions (must be the orders' `maker`)
const signer = new Wallet(process.env.WALLET_PRIVATE_KEY);

// Create a new instance of the OrderBuilder class
const builder = new OrderBuilder(ChainId.BlastMainnet, signer);

async function main() {
  // Set all the approval needed within the protocol
  const result = await builder.setApprovals();

  // Check if the approvals were set successfully
  if (!result.success) {
    throw new Error("Failed to set approvals.");
  }
}
```

## Limit Orders

Here's an example of how to use the OrderBuilder to create and sign a `LIMIT` strategy buy order:

1. **Create Wallet**: The wallet is needed to sign orders.
2. **Initialize `OrderBuilder`**: Instantiate the `OrderBuilder` class.
3. **Set Approvals**: Ensure the necessary approvals are set (refer to [Set Approvals](#set-approvals)).
4. **Determine Order Amounts**: Use `getLimitOrderAmounts` to calculate order amounts.
5. **Build Order**: Use `buildOrder` to generate a `LIMIT` strategy order.
6. **Generate Typed Data**: Call `buildTypedData` to generate typed data for the order.
7. **Sign Order**: Obtain a `SignedOrder` object by calling `signTypedDataOrder`.
8. **Compute Order Hash**: Compute the order hash using `buildTypedDataHash`.

```ts
import { Wallet } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";

// Create a wallet for signing orders
const signer = new Wallet(process.env.WALLET_PRIVATE_KEY);

// Create a new instance of the OrderBuilder class
const builder = new OrderBuilder(ChainId.BlastMainnet, signer);

async function main() {
  /**
   * NOTE: You can also call `setApprovals` once per wallet.
   */

  // Set all the approval needed within the protocol (if needed)
  const result = await builder.setApprovals();

  // Check if the approvals were set successfully
  if (!result.success) {
    throw new Error("Failed to set approvals.");
  }

  // Simple helper function to calculate the amounts for a `LIMIT` order
  const { pricePerShare, makerAmount, takerAmount } = builder.getLimitOrderAmounts({
    side: Side.BUY,
    pricePerShareWei: 400000000000000000n, // 0.4 USDB (in wei)
    quantityWei: 10000000000000000000n, // 10 shares (in wei)
  });

  // Build a limit order
  const order = builder.buildOrder("LIMIT", {
    maker: signer.address,
    signer: signer.address,
    side: Side.BUY, // Equivalent to 0
    tokenId: "OUTCOME_ON_CHAIN_ID", // This can be fetched via the API or on-chain
    makerAmount, // 0.4 USDB * 10 shares (in wei)
    takerAmount, // 10 shares (in wei)
    nonce: 0n,
  });

  // Build typed data for the order
  const typedData = builder.buildTypedData(order, true);

  // Sign the order by providing the typedData of the order
  const signedOrder = await builder.signTypedDataOrder(typedData);

  // Compute the order's hash
  const hash = builder.buildTypedDataHash(typedData);

  // Example structure required to create an order via Predict's API
  const createOrderBody = {
    data: {
      order: { ...signedOrder, hash },
      pricePerShare,
      strategy: "LIMIT",
    },
  };
}
```

## Market Orders

Similarly to the above, here's the flow to create a `MARKET` sell order:

1. **Create Wallet**: The wallet is needed to sign orders.
2. **Initialize `OrderBuilder`**: Instantiate the `OrderBuilder` class.
3. **Set Approvals**: Ensure the necessary approvals are set (refer to [Set Approvals](#set-approvals)).
4. **Fetch Orderbook**: Query the Predict API for the latest orderbook for the market.
5. **Determine Order Amounts**: Use `getMarketOrderAmounts` to calculate order amounts.
6. **Build Order**: Call `buildOrder` to generate a `MARKET` strategy order.
7. **Generate Typed Data**: Use `buildTypedData` to create typed data for the order.
8. **Sign Order**: Obtain a `SignedOrder` object by calling `signTypedDataOrder`.
9. **Compute Order Hash**: Compute the order hash using `buildTypedDataHash`.

```ts
import { Wallet } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";

// Create a wallet for signing orders
const signer = new Wallet(process.env.WALLET_PRIVATE_KEY);

// Create a new instance of the OrderBuilder class
const builder = new OrderBuilder(ChainId.BlastMainnet, signer);

async function main() {
  // Fetch the orderbook for the specific market via `GET orderbook/{marketId}`
  const book = {};

  /**
   * NOTE: You can also call `setApprovals` once per wallet.
   */

  // Set all the approval needed within the protocol (if needed)
  const result = await builder.setApprovals();

  // Check if the approvals were set successfully
  if (!result.success) {
    throw new Error("Failed to set approvals.");
  }

  // Helper function to calculate the amounts for a `MARKET` order
  const { pricePerShare, makerAmount, takerAmount } = builder.getMarketOrderAmounts(
    {
      side: Side.SELL,
      quantityWei: 10000000000000000000n, // 10 shares (in wei) e.g. parseEther("10")
    },
    book, // It's recommended to re-fetch the orderbook regularly to avoid issues
  );

  // Build a limit order
  const order = builder.buildOrder("MARKET", {
    maker: signer.address,
    signer: signer.address,
    side: Side.SELL, // Equivalent to 1
    tokenId: "OUTCOME_ON_CHAIN_ID", // This can be fetched via the API or on-chain
    makerAmount, // 10 shares (in wei)
    takerAmount, // 0.4 USDB * 10 shares (in wei)
    nonce: 0n,
  });

  // Build typed data for the order
  const typedData = builder.buildTypedData(order, true);

  // Sign the order by providing the typedData of the order
  const signedOrder = await builder.signTypedDataOrder(typedData);

  // Compute the order's hash
  const hash = builder.buildTypedDataHash(typedData);

  // Example structure required to create an order via Predict's API
  const createOrderBody = {
    data: {
      order: { ...signedOrder, hash },
      pricePerShare,
      strategy: "MARKET",
      slippageBps: "2000", // Only used for `MARKET` orders, in this example it's 0.2%
    },
  };
}
```

## Contracts

To facilitate interactions with Predict's contracts we provide the necessary ABIs and some common functions to get you started.

```ts
import {
  // Supported Chains
  ChainId,

  // Addresses
  AddressesByChainId,

  // Contract Interfaces
  BlastCTFExchange,
  BlastConditionalTokens,
  BlastNegRiskAdapter,
  BlastNegRiskCtfExchange,
  ERC20,

  // ABIs
  BlastCTFExchangeAbi,
  BlastNegRiskCtfExchangeAbi,
  BlastNegRiskAdapterAbi,
  BlastConditionalTokensAbi,
  ERC20Abi,

  // Approval utils
  OrderBuilder,
} from "@predictdotfun/sdk";
import { BaseContract, MaxUint256 } from "ethers";

// Create a new JsonRpcProvider instance
const provider = new JsonRpcProvider(process.env.RPC_PROVIDER_URL);

// Create a wallet to send the transactions on-chain
const signer = new Wallet(process.env.WALLET_PRIVATE_KEY).connect(provider);

/**
 * Example contract interaction
 */

// Get the addresses for the given chain
const addresses = AddressesByChainId[ChainId.BlastMainnet];

// Create a new instance of a BaseContract and connect it to the signer
const usdbContract = new BaseContract(this.addresses.USDB, ERC20Abi).connect(this.signer) as ERC20;

// Make contract calls
const tx = await usdbContract.approve(addresses.CTF_EXCHANGE, MaxUint256);

// Await for the transaction result
const receipt = await tx.wait();

// Check for tx success
const success = receipt.status === 1;

/**
 * Example approval via OrderBuilder
 */

// Create a new instance of the OrderBuilder class
const builder = new OrderBuilder(ChainId.BlastMainnet, signer);

// Call one of the util functions, for e.g. `ctfExchangeAllowance`
const { allowance, approve } = await builder.ctfExchangeAllowance();

// Send the approval transaction for the maximum amount, or any other amount
const tx = await approve(MaxUint256);

// Await for the transaction result
const receipt = await tx.wait();

// Check for tx success
const success = receipt.status === 1;
```

## Cancel Orders

Here's an example on how to cancel orders via the SDK

1. **Fetch Orders**: Retrieve your open orders using `GET /orders`.
2. **Group by `isMultiOutcome`**: Separate orders based on the `isMultiOutcome` property.
3. **Cancel Orders**: Call the specific cancel function based on the order(s) type (`isMultiOutcome`).
4. **Check Transaction Success**: Check to confirm the transaction was successful.

```ts
import { Wallet } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";

// Create a new JsonRpcProvider instance
const provider = new JsonRpcProvider(process.env.RPC_PROVIDER_URL);

// Create a wallet to send the cancel transactions on-chain
const signer = new Wallet(process.env.WALLET_PRIVATE_KEY).connect(provider);

// Create a new instance of the OrderBuilder class
const builder = new OrderBuilder(ChainId.BlastMainnet, signer);

async function main() {
  // Fetch your open orders from the `GET /orders` endpoint
  const apiResponse = [
    // There are more fields, but for cancellations we only care about `order` and `isMultiOutcome`
    { order: {}, isMultiOutcome: true },
    { order: {}, isMultiOutcome: false },
    { order: {}, isMultiOutcome: false },
  ];

  // Determine which orders you want to cancel
  const ordersToCancel = [
    { order: {}, isMultiOutcome: true },
    { order: {}, isMultiOutcome: false },
  ];

  const regularOrders: Order[] = [];
  const negRiskOrders: Order[] = [];

  // Group the orders by `isMultiOutcome`
  for (const { order, isMultiOutcome } of ordersToCancel) {
    if (isMultiOutcome) {
      negRiskOrders.push(order);
    } else {
      regularOrders.push(order);
    }
  }

  // Call the respective cancel functions
  const regResult = await builder.cancelOrders(regularOrders);
  const negRiskResult = await builder.cancelNegRiskOrders(regularOrders);

  // Check for the transactions success
  const success = regResult.success && negRiskResult.success;
}
```

## License

By contributing to this project, you agree that your contributions will be licensed under the project's [MIT License](./LICENSE).
