export class MissingSignerError extends Error {
  public readonly name = "MissingSignerError";
  constructor() {
    super("A signer is required to sign the order");
  }
}

export class InvalidQuantityError extends Error {
  public readonly name = "InvalidQuantityError";
  constructor() {
    super("Invalid quantityWei. Must be greater than 1e16.");
  }
}

export class InvalidExpirationError extends Error {
  public readonly name = "InvalidExpirationError";
  constructor() {
    super("Invalid expiration. Must be greater than 0.");
  }
}

export class FailedOrderSignError extends Error {
  public readonly name = "FailedOrderSignError";
  constructor(cause?: Error) {
    super("Failed to EIP-712 sign the order via signTypedData", { cause });
  }
}

export class FailedTypedDataEncoderError extends Error {
  public readonly name = "FailedTypedDataEncoderError";
  constructor(cause?: Error) {
    super("Failed to hash the order's typed data", { cause });
  }
}

export class InvalidMultiOutcomeConfig extends Error {
  public readonly name = "InvalidMultiOutcomeConfig";
  constructor() {
    super(
      "The token ID of one or more orders is not registered in the selected contract. Use `cancelOrder` when `isMultiOutcome` is true. Otherwise, use `cancelNegRiskOrder`.",
    );
  }
}
