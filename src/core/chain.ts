import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChainConfig, type ChainId } from "./chains.js";

const clients = new Map<ChainId, PublicClient>();

export function getPublicClient(chainId: ChainId): PublicClient {
  const cached = clients.get(chainId);
  if (cached) return cached;

  const cfg = getChainConfig(chainId);
  const rpcUrl = process.env[cfg.rpcEnvVar] || cfg.defaultRpcUrl;

  const client = createPublicClient({
    chain: cfg.viemChain,
    transport: http(rpcUrl, { timeout: 8_000 }),
  });

  clients.set(chainId, client);
  return client;
}

/** Not cached — a wallet client is tied to a specific private key, never reuse across users/wallets. */
export function getWalletClient(privateKey: Hex, chainId: ChainId): WalletClient {
  const cfg = getChainConfig(chainId);
  const rpcUrl = process.env[cfg.rpcEnvVar] || cfg.defaultRpcUrl;
  const account = privateKeyToAccount(privateKey);

  return createWalletClient({
    account,
    chain: cfg.viemChain,
    transport: http(rpcUrl, { timeout: 20_000 }),
  });
}

export function getAddressFromPrivateKey(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}

export function isValidPrivateKey(key: string): boolean {
  const stripped = key.startsWith("0x") ? key.slice(2) : key;
  return /^[a-fA-F0-9]{64}$/.test(stripped);
}

export function normalizePrivateKey(key: string): Hex {
  const stripped = key.startsWith("0x") ? key.slice(2) : key;
  return `0x${stripped.toLowerCase()}` as Hex;
}

export function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}
