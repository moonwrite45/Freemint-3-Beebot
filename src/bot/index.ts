import { Bot } from "grammy";
import { handleCallback, handleText, runScan } from "./handlers.js";
import { backToMainKeyboard, mainMenuKeyboard } from "./keyboards.js";
import { getDefaultChainId, type ChainId, allChainIds } from "../core/chains.js";
import { ensureUser, subscribeToChain, unsubscribeFromChain, getSubscribedChains } from "../core/subscriptions.js";
import { disableAutoMint, getAutoMintConfig, enableAutoMint } from "../core/autoMintConfig.js";

export function createBot(): Bot {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN is not set in environment variables");

  const bot = new Bot(token);

  bot.command("start", async (ctx) => {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    await ensureUser(telegramId).catch((cause) => console.error("ensureUser error:", cause));

    await ctx.reply(
      "👋 Welcome to Freemint-Bot v2!\n\n" +
        "I scan NFT contracts across multiple EVM chains for genuinely open " +
        "free mints — verified against real on-chain state, not guessed from " +
        "function names.\n\n" +
        "Send a contract address, or use /scan <address> [chain]\n" +
        "Use /subscribe <chain> to get live alerts for that chain.\n\n" +
        "Use the menu below to get started.",
      { reply_markup: mainMenuKeyboard() }
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "🤖 Freemint-Bot help\n\n" +
        "/scan <address> [chain] — scan a contract for a free mint\n" +
        "/subscribe <chain> — get live alerts when a free mint is found on that chain\n" +
        "/unsubscribe <chain> — stop alerts for that chain\n" +
        "/mysubs — show your current subscriptions\n" +
        "Chains: base, robinhood, ink (default: base)\n\n" +
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

  bot.command("subscribe", async (ctx) => {
    const chainArg = (ctx.match || "").toString().trim() as ChainId;
    if (!allChainIds().includes(chainArg)) {
      await ctx.reply(`Usage: /subscribe <chain>\nValid: ${allChainIds().join(", ")}`);
      return;
    }
    const telegramId = BigInt(ctx.from?.id ?? 0);
    await subscribeToChain(telegramId, chainArg);
    await ctx.reply(`✅ Subscribed to live free-mint alerts on ${chainArg}.`);
  });

  bot.command("unsubscribe", async (ctx) => {
    const chainArg = (ctx.match || "").toString().trim() as ChainId;
    if (!allChainIds().includes(chainArg)) {
      await ctx.reply(`Usage: /unsubscribe <chain>\nValid: ${allChainIds().join(", ")}`);
      return;
    }
    const telegramId = BigInt(ctx.from?.id ?? 0);
    await unsubscribeFromChain(telegramId, chainArg);
    await ctx.reply(`Unsubscribed from ${chainArg}.`);
  });

  bot.command("mysubs", async (ctx) => {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    const chains = await getSubscribedChains(telegramId);
    await ctx.reply(chains.length ? `Subscribed to: ${chains.join(", ")}` : "No active subscriptions. Use /subscribe <chain>.");
  });

  bot.command("automintoff", async (ctx) => {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    await disableAutoMint(telegramId);
    await ctx.reply("⏸ Auto-mint disabled.");
  });

  bot.command("automintstatus", async (ctx) => {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    const config = await getAutoMintConfig(telegramId);
    if (!config || !config.enabled) {
      await ctx.reply("Auto-mint is off. Enable it from a wallet's menu (💼 My Wallets → pick a wallet → ⚡ Use for Auto-Mint).");
      return;
    }
    await ctx.reply(
      `⚡ Auto-mint is ON.\nGas cap: ${config.maxGasGwei != null ? `${config.maxGasGwei} gwei` : "none set"}.`
    );
  });

  bot.command("setgaslimit", async (ctx) => {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    const arg = (ctx.match || "").toString().trim();
    const gwei = Number(arg);
    if (!arg || Number.isNaN(gwei) || gwei <= 0) {
      await ctx.reply("Usage: /setgaslimit <gwei>\nExample: /setgaslimit 5");
      return;
    }
    const config = await getAutoMintConfig(telegramId);
    if (!config) {
      await ctx.reply("Enable auto-mint first from a wallet's menu, then set your gas limit.");
      return;
    }
    await enableAutoMint(telegramId, config.walletId, gwei);
    await ctx.reply(`✅ Gas cap set to ${gwei} gwei. Mints will be skipped if gas exceeds this.`);
  });

  bot.on("callback_query:data", handleCallback);
  bot.on("message:text", handleText);

  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  return bot;
}
