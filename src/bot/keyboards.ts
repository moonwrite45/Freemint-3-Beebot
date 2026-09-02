import { InlineKeyboard } from "grammy";
import { shortenAddress } from "./format.js";
import type { ChainId } from "../core/chains.js";
import type { WalletInfo } from "../core/wallet.js";

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
    .text("💼 My Wallets", "wallet_menu").text("⚙️ Chains", "menu_chains").row()
    .text("🖼 My Portfolio", "portfolio_menu").text("🎯 Tracking", "tracking_menu").row()
    .text("🛡 Settings / Gas", "settings_menu").row()
    .text("📖 Help", "menu_help");
}

export function trackingKeyboard(tracked: { trackedAddress: string; label: string; autoCopy: boolean }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const t of tracked) {
    kb.text(`${t.autoCopy ? "⚡" : "👁"} ${t.label}`, `trackview_${t.trackedAddress}`).row();
  }
  kb.text("➕ Track New Wallet", "track_new").row();
  kb.text("🏠 Main Menu", "main_menu");
  return kb;
}

export function trackedWalletKeyboard(address: string, autoCopy: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (autoCopy) {
    kb.text("⏸ Turn Off Auto-Copy", `copyoff_${address}`).row();
  } else {
    kb.text("⚡ Turn On Auto-Copy", `copyonprompt_${address}`).row();
  }
  kb.text("🗑 Untrack", `untrack_${address}`).row();
  kb.text("🎯 Back to Tracking", "tracking_menu").text("🏠 Main Menu", "main_menu");
  return kb;
}

export function settingsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🏠 Main Menu", "main_menu");
}

export function portfolioKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔄 Refresh", "portfolio_menu").row()
    .text("🏠 Main Menu", "main_menu");
}

export function walletMenuKeyboard(wallets: WalletInfo[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const w of wallets) {
    kb.text(`${w.isActive ? "🟢" : "⚪"} ${w.label} — ${shortenAddress(w.address)}`, `walletview_${w.id}`).row();
  }
  kb.text("➕ New Wallet", "wallet_new").text("📥 Import", "wallet_import").row()
    .text("🏠 Main Menu", "main_menu");
  return kb;
}

export function walletDetailKeyboard(walletId: string, isActive: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text(isActive ? "⏸ Deactivate" : "▶️ Activate", `wallettoggle_${walletId}`).row()
    .text("⚡ Use for Auto-Mint", `automintset_${walletId}`).row()
    .text("⚠️ Export Private Key", `walletexport_${walletId}`).row()
    .text("🗑 Delete Wallet", `walletdelete_${walletId}`).row()
    .text("💼 Back to Wallets", "wallet_menu");
}

/** Shown before ever revealing a key — requires an explicit second tap, never a single accidental button press. */
export function exportConfirmKeyboard(walletId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("❌ Cancel", `walletview_${walletId}`).row()
    .text("⚠️ Yes, show my private key", `walletexportconfirm_${walletId}`);
}

export function deleteConfirmKeyboard(walletId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("❌ Cancel", `walletview_${walletId}`)
    .text("🗑 Confirm Delete", `walletdeleteconfirm_${walletId}`);
}

export function mintWalletPickKeyboard(contractAddress: string, chain: ChainId, wallets: WalletInfo[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  const active = wallets.filter((w) => w.isActive);
  for (const w of active) {
    kb.text(`💼 ${w.label} — ${shortenAddress(w.address)}`, `mintexec_${contractAddress}_${chain}_${w.id}`).row();
  }
  kb.text("❌ Cancel", `scan_${contractAddress}_${chain}`);
  return kb;
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
  const all: ChainId[] = ["base", "robinhood", "ink"];
  for (const c of all) {
    const on = activeChains.includes(c);
    kb.text(`${on ? "✅" : "⬜"} ${chainLabel(c)}`, `togglechain_${c}`).row();
  }
  kb.text("🏠 Main Menu", "main_menu");
  return kb;
}

function chainLabel(c: ChainId): string {
  switch (c) {
    case "base": return "Base";
    case "robinhood": return "Robinhood Chain";
    case "ink": return "Ink";
  }
}

function explorerUrl(address: string, chain: ChainId): string {
  const bases: Record<ChainId, string> = {
    base: "https://basescan.org",
    robinhood: "https://robinhoodchain.blockscout.com",
    ink: "https://explorer.inkonchain.com",
  };
  return `${bases[chain]}/address/${address}`;
}
