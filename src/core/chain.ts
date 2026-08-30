import { createPublicClient, http, type PublicClient } from "viem";
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
