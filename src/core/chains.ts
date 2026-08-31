import { base } from "viem/chains";
import { defineChain, type Chain } from "viem";

export type ChainId = "base" | "robinhood" | "ink";

export type ExplorerKind = "etherscan-v2" | "blockscout";

export interface ChainConfig {
  id: ChainId;
  viemChain: Chain;
  rpcEnvVar: string;
  defaultRpcUrl: string;
  explorerKind: ExplorerKind;
  explorerApiUrl: string;
  /** Only used for etherscan-v2 chains — Blockscout instances here don't require a key. */
  explorerApiKeyEnv?: string;
  /** Only used for etherscan-v2's unified API. */
  explorerChainParam?: number;
}

// Robinhood Chain and Ink aren't in every viem release yet (Robinhood
// Chain mainnet only launched July 2026), so both are defined explicitly
// here from officially documented values rather than relying on
// viem/chains possibly having them. Values verified via web search
// against Robinhood's own docs and Ink's official RPC/explorer — not
// guessed. Re-verify against docs.robinhood.com/chain and
// docs.inkonchain.com if these ever need to change; there are known
// impersonation/fake-explorer risks for newer chains like this.
const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});

const inkChain = defineChain({
  id: 57073,
  name: "Ink",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc-gel.inkonchain.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://explorer.inkonchain.com" },
  },
});

export const CHAIN_CONFIGS: Record<ChainId, ChainConfig> = {
  base: {
    id: "base",
    viemChain: base,
    rpcEnvVar: "BASE_RPC_URL",
    defaultRpcUrl: "https://mainnet.base.org",
    explorerKind: "etherscan-v2",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerApiKeyEnv: "ETHERSCAN_API_KEY",
    explorerChainParam: 8453,
  },
  robinhood: {
    id: "robinhood",
    viemChain: robinhoodChain,
    rpcEnvVar: "ROBINHOOD_RPC_URL",
    defaultRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorerKind: "blockscout",
    // Blockscout ships an Etherscan-compatible /api endpoint (module/action
    // params) on every instance — no API key needed for the public tier.
    explorerApiUrl: "https://robinhoodchain.blockscout.com/api",
  },
  ink: {
    id: "ink",
    viemChain: inkChain,
    rpcEnvVar: "INK_RPC_URL",
    defaultRpcUrl: "https://rpc-gel.inkonchain.com",
    explorerKind: "blockscout",
    explorerApiUrl: "https://explorer.inkonchain.com/api",
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
