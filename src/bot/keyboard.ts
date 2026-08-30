import { InlineKeyboard } from "grammy";
import { shortenAddress } from "./format.js";
import type { ChainId } from "../core/chains.js";

/**
 * Ported from the old bot's keyboards.ts to keep the same visual layout
 * and emoji style. Scope is trimmed to what Phase 1-3 actually implement
 * (detection, alerting, watchlist) — wallet/mint/copy-mint keyboards come
 * back in Phase 4 once those features exist behind them.
 *
 * One deliberate wording change: the old bot's "🚀 Attempt Bypass" button
 * implied circumventing mint gates. Our scanner only ever confirms and
 * acts on genuinely open public mints (see scanner.ts) — it refuses
 * anything gated, same as the old bot's own bypassEngine did under the
 * hood. Renamed to "🚀 Direct Mint" so the UI doesn't promise more than
 * the bot does.
 */

export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔍 Scan Contract", "scan_contract").text("👁 Watchlist", "watchlist").row()
    .text("⚙️ Chains", "menu_chains").text("📖 Help", "menu_help");
}

export function backToMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🏠 Main Menu", "main_menu");
}

export function scanResultKeyboard(contractAddress: string, chain: ChainId, isFreeMintFound: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (isFreeMintFound) {
    kb.text("🚀 Direct Mint", `mint_${contractAddress}_${chain}`).row();
  }
  kb.text("🔄 Re-scan", `scan_${contractAddress}_${chain}`).row()
    .text("👁 Add to Watchlist", `addwatch_${contractAddress}_${chain}`).row()
    .url("🔗 Explorer", explorerUrl(contractAddress, chain))
    .text("🏠 Main Menu", "main_menu");
  return kb;
}

export function watchlistKeyboard(contracts: { address: string; chain: ChainId }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const { address, chain } of contracts) {
    kb.text(`🔍 ${shortenAddress(address)}`, `scan_${address}_${chain}`)
      .text(`❌`, `rmwatch_${address}_${chain}`)
      .row();
  }
  kb.text("🏠 Main Menu", "main_menu");
  return kb;
}

export function chainSelectKeyboard(activeChains: ChainId[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  const all: ChainId[] = ["ethereum", "base", "arbitrum", "optimism"];
  for (const c of all) {
    const on = activeChains.includes(c);
    kb.text(`${on ? "✅" : "⬜"} ${chainLabel(c)}`, `togglechain_${c}`).row();
  }
  kb.text("🏠 Main Menu", "main_menu");
  return kb;
}

function chainLabel(c: ChainId): string {
  switch (c) {
    case "ethereum": return "Ethereum";
    case "base": return "Base";
    case "arbitrum": return "Arbitrum";
    case "optimism": return "Optimism";
  }
}

function explorerUrl(address: string, chain: ChainId): string {
  const bases: Record<ChainId, string> = {
    ethereum: "https://etherscan.io",
    base: "https://basescan.org",
    arbitrum: "https://arbiscan.io",
    optimism: "https://optimistic.etherscan.io",
  };
  return `${bases[chain]}/address/${address}`;
}
