import { base, mainnet, arbitrum, optimism } from "viem/chains";
import type { Chain } from "viem";

export type ChainId = "ethereum" | "base" | "arbitrum" | "optimism";

export interface ChainConfig {
  id: ChainId;
  viemChain: Chain;
  rpcEnvVar: string;
  defaultRpcUrl: string;
  explorerApiUrl: string;
  explorerApiKeyEnv: string;
  /** etherscan v2 unified API chain id param */
  explorerChainParam: number;
}

export const CHAIN_CONFIGS: Record<ChainId, ChainConfig> = {
  ethereum: {
    id: "ethereum",
    viemChain: mainnet,
    rpcEnvVar: "ETH_RPC_URL",
    defaultRpcUrl: "https://eth.llamarpc.com",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerApiKeyEnv: "ETHERSCAN_API_KEY",
    explorerChainParam: 1,
  },
  base: {
    id: "base",
    viemChain: base,
    rpcEnvVar: "BASE_RPC_URL",
    defaultRpcUrl: "https://mainnet.base.org",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerApiKeyEnv: "ETHERSCAN_API_KEY",
    explorerChainParam: 8453,
  },
  arbitrum: {
    id: "arbitrum",
    viemChain: arbitrum,
    rpcEnvVar: "ARBITRUM_RPC_URL",
    defaultRpcUrl: "https://arb1.arbitrum.io/rpc",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerApiKeyEnv: "ETHERSCAN_API_KEY",
    explorerChainParam: 42161,
  },
  optimism: {
    id: "optimism",
    viemChain: optimism,
    rpcEnvVar: "OPTIMISM_RPC_URL",
    defaultRpcUrl: "https://mainnet.optimism.io",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerApiKeyEnv: "ETHERSCAN_API_KEY",
    explorerChainParam: 10,
  },
};

export function getChainConfig(id: ChainId): ChainConfig {
  const cfg = CHAIN_CONFIGS[id];
  if (!cfg) throw new Error(`Unknown chain id: ${id}`);
  return cfg;
}

export function getDefaultChainId(): ChainId {
  return "base";
}

export function allChainIds(): ChainId[] {
  return Object.keys(CHAIN_CONFIGS) as ChainId[];
}
