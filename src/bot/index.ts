import { Bot } from "grammy";
import { handleCallback, handleText, runScan } from "./handlers.js";
import { backToMainKeyboard, mainMenuKeyboard } from "./keyboards.js";
import { getDefaultChainId, type ChainId, allChainIds } from "../core/chains.js";

export function createBot(): Bot {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN is not set in environment variables");

  const bot = new Bot(token);

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "👋 Welcome to Freemint-Bot v2!\n\n" +
        "I scan NFT contracts across multiple EVM chains for genuinely open " +
        "free mints — verified against real on-chain state, not guessed from " +
        "function names.\n\n" +
        "Send a contract address, or use /scan <address> [chain]\n\n" +
        "Use the menu below to get started.",
      { reply_markup: mainMenuKeyboard() }
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "🤖 Freemint-Bot help\n\n" +
        "/scan <address> [chain] — scan a contract for a free mint\n" +
        "Chains: ethereum, base, arbitrum, optimism (default: base)\n\n" +
        "Note: this bot only acts on genuinely open public mints. It does " +
        "not attempt to bypass allowlist/signature-gated mints.",
      { reply_markup: backToMainKeyboard() }
    );
  });

  bot.command("scan", async (ctx) => {
    const parts = (ctx.match || "").toString().trim().split(/\s+/).filter(Boolean);
    const address = parts[0];
    const chainArg = (parts[1] || getDefaultChainId()) as ChainId;

    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      await ctx.reply("Usage: /scan <contract address> [chain]\nExample: /scan 0xabc... base");
      return;
    }
    if (!allChainIds().includes(chainArg)) {
      await ctx.reply(`Unknown chain "${chainArg}". Valid: ${allChainIds().join(", ")}`);
      return;
    }

    await runScan(ctx, address, chainArg);
  });

  bot.on("callback_query:data", handleCallback);
  bot.on("message:text", handleText);

  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  return bot;
}
