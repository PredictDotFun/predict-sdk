A TypeScript SDK to help developers interface with the Predict's protocol.

## Install

This package has [ethers v6](https://docs.ethers.io/v6/) as a peer dependency.

```bash
yarn add @predictdotfun/sdk ethers@6.x
```

```bash
npm install @predictdotfun/sdk ethers@6.x
```

## Limit Orders

Here's an example of how to use the OrderBuilder to create and sign a `LIMIT` strategy buy order:

1. Create a wallet to sign the orders.
2. Create a new instance of the `OrderBuilder` class.
3. If needed, use the `getLimitOrderAmounts` helper function to determine the order amounts.
4. Call the `buildOrder` method to generate an order struct (in this example we use a `LIMIT` strategy).
   - If it was a sell order the `makerAmount` and `takerAmount` would be inverted (see `getLimitOrderAmounts`).
5. Using the method `buildTypedData` generate the typed data for the order.
6. By calling the method `signTypedDataOrder` get the `SignedOrder` object containing the signature.
7. Lastly, use the same typed data struct from point 5 to compute the order's hash via `buildTypedDataHash`.

```ts
import { Wallet } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";

// Create a wallet for signing orders
const signer = new Wallet(process.env.YOUR_PRIVATE_KEY);

// Create a new instance of the OrderBuilder class
const builder = new OrderBuilder(ChainId.BlastMainnet, signer);

async function main() {
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

1. Create a wallet to sign the orders.
2. Create a new instance of the `OrderBuilder` class.
3. Query the Predict API to get the latest orderbook for the specific market.
4. Use the `getMarketOrderAmounts` helper function to determine the order amounts.
5. Call the `buildOrder` method to generate an order struct (in this example we use a `MARKET` strategy).
6. Using the method `buildTypedData` generate the typed data for the order.
7. By calling the method `signTypedDataOrder` get the `SignedOrder` object containing the signature.
8. Lastly, use the same typed data struct from point 6 to compute the order's hash via `buildTypedDataHash`.

```ts
import { Wallet } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";

// Create a wallet for signing orders
const signer = new Wallet(process.env.YOUR_PRIVATE_KEY);

// Create a new instance of the OrderBuilder class
const builder = new OrderBuilder(ChainId.BlastMainnet, signer);

async function main() {
  // Fetch the orderbook for the specific market via `GET orderbook/{marketId}`
  const book = {};

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

## License

By contributing to this project, you agree that your contributions will be licensed under the project's [MIT License](./LICENSE).
