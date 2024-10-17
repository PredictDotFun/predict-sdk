import type { BaseContract, BaseWallet, InterfaceAbi, Provider, TypedDataDomain } from "ethers";
import { AbiCoder, concat, Contract, hexlify, Interface, keccak256, TypedDataEncoder } from "ethers";

export function makeContract<T extends BaseContract>(address: string, abi: InterfaceAbi) {
  return (signerOrProvider: BaseWallet | Provider): { contract: T; codec: Interface } => {
    const codec = new Interface(abi);
    const contract = new Contract(address, codec).connect(signerOrProvider) as T;

    return { contract, codec };
  };
}

export function hashKernelMessage(messageHash: string) {
  const codec = new AbiCoder();
  const encoder = new TextEncoder();

  const value = encoder.encode("Kernel(bytes32 hash)");
  return keccak256(codec.encode(["bytes32", "bytes32"], [keccak256(hexlify(value)), messageHash]));
}

export function eip712WrapHash(messageHash: string, domain: TypedDataDomain) {
  const domainSeparator = TypedDataEncoder.hashDomain(domain);
  const finalMessageHash = hashKernelMessage(messageHash);

  return keccak256(concat(["0x1901", domainSeparator, finalMessageHash]));
}
