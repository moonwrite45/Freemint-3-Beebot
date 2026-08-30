import type { Context } from "grammy";
import { scanContract } from "../core/scanner.js";
import { describeScanError, TERMINAL_NEGATIVE_KINDS } from "../core/errors.js";
import { allChainIds, getChainConfig, type ChainId } from "../core/chains.js";
import {
  mainMenuKeyboard,
  backToMainKeyboard,
  scanResultKeyboard,
  chainSelectKeyboard,
} from "./keyboards.js";
import { shortenAddress } from "./format.js";

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
    await ctx.reply("⚙️ Active chains — tap to toggle:", {
      reply_markup: chainSelectKeyboard(allChainIds()),
    });
    return;
  }

  if (data === "menu_help") {
    await ctx.reply(
      "🤖 Freemint-Bot help\n\n" +
        "Send a contract address, or use /scan <address> [chain]\n" +
        "Chains: ethereum, base, arbitrum, optimism (default: base)\n\n" +
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

  const scanMatch = data.match(/^scan_(0x[a-fA-F0-9]{40})_(\w+)$/);
  if (scanMatch) {
    await runScan(ctx, scanMatch[1], scanMatch[2] as ChainId);
    return;
  }
}
