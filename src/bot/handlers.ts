import type { Context } from "grammy";
import { scanContract } from "../core/scanner.js";
import { describeScanError, TERMINAL_NEGATIVE_KINDS } from "../core/errors.js";
import { allChainIds, getChainConfig, type ChainId } from "../core/chains.js";
import {
  mainMenuKeyboard,
  backToMainKeyboard,
  scanResultKeyboard,
  chainSelectKeyboard,
  walletMenuKeyboard,
  walletDetailKeyboard,
  exportConfirmKeyboard,
  deleteConfirmKeyboard,
  mintWalletPickKeyboard,
  watchlistKeyboard,
} from "./keyboards.js";
import { shortenAddress } from "./format.js";
import {
  generateNewWallet,
  importWallet,
  getWallets,
  getWalletByIdForUser,
  toggleWallet,
  deleteWallet,
  getWalletPrivateKey,
} from "../core/wallet.js";
import { executeMint } from "../core/autoMint.js";
import { getAutoMintConfig, enableAutoMint } from "../core/autoMintConfig.js";
import { getSubscribedChains, subscribeToChain, unsubscribeFromChain } from "../core/subscriptions.js";
import { addToWatchlist, removeFromWatchlist, getWatchlist } from "../core/watchlist.js";

/**
 * Every branch below shows the person a DIFFERENT message depending on
 * ScanError.kind. The old bot's failure mode was collapsing rate-limits,
 * RPC timeouts, and genuine negatives into one generic "no free mint"
 * message — so a transient explorer hiccup looked identical to "this
 * contract really has nothing." That distinction is preserved end to end,
 * from scanner.ts's typed Result all the way into what the user reads.
 */
export async function runScan(ctx: Context, address: string, chain: ChainId) {
  const result = await scanContract(address, chain);

  if (!result.ok) {
    const { kind } = result.error;
    const prefix = TERMINAL_NEGATIVE_KINDS.has(kind) ? "🔎" : "⏳";
    await ctx.reply(
      `${prefix} ${shortenAddress(address)} on ${chainLabel(chain)}\n\n${describeScanError(result.error)}`,
      { reply_markup: backToMainKeyboard() }
    );
    return;
  }

  const scan = result.value;
  if (!scan.freeMint) {
    await ctx.reply(
      `🔎 ${shortenAddress(scan.contractAddress)} on ${chainLabel(chain)}\n\n` +
        `Verified NFT contract, but no free mint currently confirmed.\n` +
        `Checked ${scan.candidates.length} mint-like function(s).`,
      { reply_markup: scanResultKeyboard(scan.contractAddress, chain, false) }
    );
    return;
  }

  const fm = scan.freeMint;
  await ctx.reply(
    `✅ Free mint found!\n\n` +
      `Contract: ${shortenAddress(scan.contractAddress)}\n` +
      `Chain: ${chainLabel(chain)}\n` +
      `Function: ${fm.candidate.name}(${fm.candidate.args.join(", ")})\n` +
      `Verified by: ${verifiedByLabel(fm.verifiedBy)}\n` +
      `Est. gas: ${fm.gasEstimate.toString()}`,
    { reply_markup: scanResultKeyboard(scan.contractAddress, chain, true) }
  );
}

function verifiedByLabel(v: string): string {
  switch (v) {
    case "onchain_price_read_zero":
      return "on-chain price read (strongest)";
    case "dry_run_succeeded_with_zero_value":
      return "real dry-run call succeeded";
    case "zero_payable_and_no_price_state":
      return "non-payable + naming signal (weakest — verify before relying on it)";
    default:
      return v;
  }
}

function chainLabel(c: ChainId): string {
  return getChainConfig(c).id;
}

export async function handleText(ctx: Context) {
  const text = ctx.message?.text?.trim();
  if (!text) return;

  // Bare 0x address in a message: treat as an implicit scan request.
  if (/^0x[a-fA-F0-9]{40}$/.test(text)) {
    await runScan(ctx, text, "base");
    return;
  }

  // Looks like a private key (64 hex chars, with or without 0x): treat as
  // an import attempt. Checked AFTER the 40-char address check above so
  // the two never collide.
  if (/^(0x)?[a-fA-F0-9]{64}$/.test(text)) {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    try {
      const wallet = await importWallet(telegramId, text);
      await ctx.reply(
        `✅ Wallet imported: ${wallet.label}\n${wallet.address}`,
        { reply_markup: walletDetailKeyboard(wallet.id, wallet.isActive) }
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Import failed.";
      await ctx.reply(`❌ ${message}`);
    }
    return;
  }
}

export async function handleCallback(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  if (!data) return;
  await ctx.answerCallbackQuery().catch(() => undefined);

  if (data === "main_menu") {
    await ctx.reply("🏠 Main Menu", { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (data === "menu_chains") {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    // Bug fix: this used to pass allChainIds() as the "active" set, so
    // every chain showed a checkmark regardless of what the user actually
    // subscribed to. Now reflects real subscription state.
    const subscribed = await getSubscribedChains(telegramId);
    await ctx.reply("⚙️ Alert subscriptions — tap to toggle:", {
      reply_markup: chainSelectKeyboard(subscribed),
    });
    return;
  }

  const toggleChainMatch = data.match(/^togglechain_(\w+)$/);
  if (toggleChainMatch) {
    const chain = toggleChainMatch[1] as ChainId;
    if (!allChainIds().includes(chain)) return;
    const telegramId = BigInt(ctx.from?.id ?? 0);
    const subscribed = await getSubscribedChains(telegramId);
    if (subscribed.includes(chain)) {
      await unsubscribeFromChain(telegramId, chain);
    } else {
      await subscribeToChain(telegramId, chain);
    }
    const updated = await getSubscribedChains(telegramId);
    await ctx.reply("⚙️ Alert subscriptions — tap to toggle:", {
      reply_markup: chainSelectKeyboard(updated),
    });
    return;
  }

  if (data === "menu_help") {
    await ctx.reply(
      "🤖 Freemint-Bot help\n\n" +
        "Send a contract address, or use /scan <address> [chain]\n" +
        "Chains: base, robinhood, ink (default: base)\n\n" +
        "The bot verifies free mints by reading real on-chain state — " +
        "it never guesses from a function's name alone.",
      { reply_markup: backToMainKeyboard() }
    );
    return;
  }

  if (data === "scan_contract") {
    await ctx.reply("Send the contract address you want to scan (0x...).");
    return;
  }

  if (data === "watchlist") {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    const items = await getWatchlist(telegramId);
    await ctx.reply(
      items.length ? "👁 Your watchlist:" : "👁 Nothing on your watchlist yet. Scan a contract, then \"Add to Watchlist\".",
      { reply_markup: watchlistKeyboard(items.map((i) => ({ address: i.contractAddress, chain: i.chain }))) }
    );
    return;
  }

  const addWatchMatch = data.match(/^addwatch_(0x[a-fA-F0-9]{40})_(\w+)$/);
  if (addWatchMatch) {
    const [, contractAddress, chain] = addWatchMatch;
    const telegramId = BigInt(ctx.from?.id ?? 0);
    await addToWatchlist(telegramId, contractAddress, chain as ChainId);
    await ctx.reply(`👁 Added ${shortenAddress(contractAddress)} to your watchlist.`, {
      reply_markup: scanResultKeyboard(contractAddress, chain as ChainId, false),
    });
    return;
  }

  const rmWatchMatch = data.match(/^rmwatch_(0x[a-fA-F0-9]{40})_(\w+)$/);
  if (rmWatchMatch) {
    const [, contractAddress, chain] = rmWatchMatch;
    const telegramId = BigInt(ctx.from?.id ?? 0);
    await removeFromWatchlist(telegramId, contractAddress, chain as ChainId);
    const items = await getWatchlist(telegramId);
    await ctx.reply(
      items.length ? "👁 Your watchlist:" : "👁 Watchlist is now empty.",
      { reply_markup: watchlistKeyboard(items.map((i) => ({ address: i.contractAddress, chain: i.chain }))) }
    );
    return;
  }

  if (data === "wallet_menu") {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    const wallets = await getWallets(telegramId);
    await ctx.reply(
      wallets.length
        ? "💼 Your wallets:"
        : "💼 No wallets yet. Create one, or import an existing key.",
      { reply_markup: walletMenuKeyboard(wallets) }
    );
    return;
  }

  if (data === "wallet_new") {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    const wallet = await generateNewWallet(telegramId);
    await ctx.reply(
      `✅ New wallet created: ${wallet.label}\n${wallet.address}\n\n` +
        `This wallet is empty — send funds to it before minting anything. ` +
        `Use "⚠️ Export Private Key" from its menu if you ever need to move funds out.`,
      { reply_markup: walletDetailKeyboard(wallet.id, wallet.isActive) }
    );
    return;
  }

  if (data === "wallet_import") {
    await ctx.reply(
      "Send the private key to import (0x... or plain 64-char hex).\n\n" +
        "⚠️ Only import a key you generated for bot use, ideally a burner wallet " +
        "— never your main wallet's key."
    );
    return;
  }

  const walletViewMatch = data.match(/^walletview_(.+)$/);
  if (walletViewMatch) {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    const wallet = await getWalletByIdForUser(telegramId, walletViewMatch[1]);
    if (!wallet) {
      await ctx.reply("Wallet not found.", { reply_markup: backToMainKeyboard() });
      return;
    }
    await ctx.reply(
      `${wallet.isActive ? "🟢" : "⚪"} ${wallet.label}\n${wallet.address}`,
      { reply_markup: walletDetailKeyboard(wallet.id, wallet.isActive) }
    );
    return;
  }

  const walletToggleMatch = data.match(/^wallettoggle_(.+)$/);
  if (walletToggleMatch) {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    const wallet = await toggleWallet(telegramId, walletToggleMatch[1]);
    if (!wallet) {
      await ctx.reply("Wallet not found.", { reply_markup: backToMainKeyboard() });
      return;
    }
    await ctx.reply(
      `${wallet.isActive ? "🟢 Activated" : "⚪ Deactivated"}: ${wallet.label}`,
      { reply_markup: walletDetailKeyboard(wallet.id, wallet.isActive) }
    );
    return;
  }

  const walletExportMatch = data.match(/^walletexport_(.+)$/);
  if (walletExportMatch) {
    await ctx.reply(
      "⚠️ Your private key gives full control of this wallet's funds.\n\n" +
        "It will be sent as a Telegram message, which means it stays in this " +
        "chat's history unless you delete it yourself afterward. Only continue " +
        "if you understand that risk.",
      { reply_markup: exportConfirmKeyboard(walletExportMatch[1]) }
    );
    return;
  }

  const walletExportConfirmMatch = data.match(/^walletexportconfirm_(.+)$/);
  if (walletExportConfirmMatch) {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    try {
      const key = await getWalletPrivateKey(telegramId, walletExportConfirmMatch[1]);
      await ctx.reply(
        `🔑 Private key:\n\`${key}\`\n\n` +
          `Delete this message once you've saved it somewhere safe.`,
        { parse_mode: "MarkdownV2", reply_markup: backToMainKeyboard() }
      );
    } catch {
      await ctx.reply("Wallet not found.", { reply_markup: backToMainKeyboard() });
    }
    return;
  }

  const walletDeleteMatch = data.match(/^walletdelete_(.+)$/);
  if (walletDeleteMatch) {
    await ctx.reply(
      "🗑 Delete this wallet from the bot?\n\n" +
        "This only removes it from the bot's records — it does NOT affect the " +
        "wallet on-chain. Make sure you've exported the key first if you still " +
        "need access to any funds in it.",
      { reply_markup: deleteConfirmKeyboard(walletDeleteMatch[1]) }
    );
    return;
  }

  const walletDeleteConfirmMatch = data.match(/^walletdeleteconfirm_(.+)$/);
  if (walletDeleteConfirmMatch) {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    const deleted = await deleteWallet(telegramId, walletDeleteConfirmMatch[1]);
    await ctx.reply(deleted ? "🗑 Wallet deleted." : "Wallet not found.", {
      reply_markup: backToMainKeyboard(),
    });
    return;
  }

  const autoMintSetMatch = data.match(/^automintset_(.+)$/);
  if (autoMintSetMatch) {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    const wallet = await getWalletByIdForUser(telegramId, autoMintSetMatch[1]);
    if (!wallet) {
      await ctx.reply("Wallet not found.", { reply_markup: backToMainKeyboard() });
      return;
    }
    const existing = await getAutoMintConfig(telegramId);
    await enableAutoMint(telegramId, wallet.id, existing?.maxGasGwei ?? null);
    await ctx.reply(
      `⚡ Auto-mint enabled using ${wallet.label} (${shortenAddress(wallet.address)}).\n\n` +
        `⚠️ This wallet will now automatically attempt every free mint you're subscribed to, ` +
        `with no per-mint confirmation. Fund it only with what you're willing to spend on gas.\n\n` +
        `${existing?.maxGasGwei ? `Gas cap: ${existing.maxGasGwei} gwei.` : "No gas cap set — use /setgaslimit <gwei> to add a safety cap."}\n` +
        `Use /automintoff to disable at any time.`,
      { reply_markup: backToMainKeyboard() }
    );
    return;
  }

  const mintMatch = data.match(/^mint_(0x[a-fA-F0-9]{40})_(\w+)$/);
  if (mintMatch) {
    const [, contractAddress, chain] = mintMatch;
    const telegramId = BigInt(ctx.from?.id ?? 0);
    const wallets = await getWallets(telegramId);
    const activeWallets = wallets.filter((w) => w.isActive);

    if (activeWallets.length === 0) {
      await ctx.reply(
        "You don't have an active wallet yet. Create or import one first.",
        { reply_markup: walletMenuKeyboard(wallets) }
      );
      return;
    }

    await ctx.reply(
      "Which wallet should mint this?",
      { reply_markup: mintWalletPickKeyboard(contractAddress, chain as ChainId, activeWallets) }
    );
    return;
  }

  const mintExecMatch = data.match(/^mintexec_(0x[a-fA-F0-9]{40})_(\w+)_(.+)$/);
  if (mintExecMatch) {
    const [, contractAddress, chain, walletId] = mintExecMatch;
    const telegramId = BigInt(ctx.from?.id ?? 0);

    const wallet = await getWalletByIdForUser(telegramId, walletId);
    if (!wallet) {
      await ctx.reply("Wallet not found or not owned by you.", { reply_markup: backToMainKeyboard() });
      return;
    }

    await ctx.reply("⏳ Re-verifying and sending — this only takes a moment...");

    // Re-scan immediately before spending gas rather than trusting a scan
    // result the user might be looking at from minutes ago — the mint
    // could have sold out or the price could have changed since then.
    // Bug fix: this used to pass walletId itself as the probe address —
    // a Prisma cuid, not a real address, which isAddress() always rejects.
    // That silently skipped the dry-run tier on every manual mint and fell
    // back to the weakest verification signal. Now probes from the wallet's
    // actual on-chain address, which is what a dry-run needs anyway.
    const fresh = await scanContract(contractAddress, chain as ChainId, wallet.address);
    if (!fresh.ok || !fresh.value.freeMint) {
      await ctx.reply(
        `❌ Mint no longer verifiable: ${fresh.ok ? "no free mint found on re-check" : describeScanError(fresh.error)}`,
        { reply_markup: backToMainKeyboard() }
      );
      return;
    }

    const config = await getAutoMintConfig(telegramId);
    const result = await executeMint(telegramId, walletId, fresh.value, chain as ChainId, "manual", config?.maxGasGwei ?? null);

    if (!result.ok) {
      await ctx.reply(`❌ Mint failed: ${result.error.message}`, { reply_markup: backToMainKeyboard() });
      return;
    }

    await ctx.reply(
      `✅ Mint transaction sent!\nTx: ${result.value.txHash}`,
      { reply_markup: backToMainKeyboard() }
    );
    return;
  }

  const scanMatch = data.match(/^scan_(0x[a-fA-F0-9]{40})_(\w+)$/);
  if (scanMatch) {
    await runScan(ctx, scanMatch[1], scanMatch[2] as ChainId);
    return;
  }
}
