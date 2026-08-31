import { Bot } from "grammy";
import { handleCallback, handleText, runScan } from "./handlers.js";
import { backToMainKeyboard, mainMenuKeyboard } from "./keyboards.js";
import { getDefaultChainId, type ChainId, allChainIds } from "../core/chains.js";
import { ensureUser, subscribeToChain, unsubscribeFromChain, getSubscribedChains } from "../core/subscriptions.js";
import { disableAutoMint, getAutoMintConfig, enableAutoMint } from "../core/autoMintConfig.js";
import { trackWallet, untrackWallet, listTrackedWallets, setAutoCopy } from "../core/copyMint.js";
import { getWalletByIdForUser, getWalletPrivateKey } from "../core/wallet.js";
import { checkOpenSeaEligibility } from "../core/openseaEligibility.js";
import { shortenAddress } from "./format.js";

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
        "/mysubs — show your current subscriptions\n\n" +
        "💼 Wallets — 'My Wallets' menu to create/import/export\n" +
        "/automintstatus, /automintoff, /setgaslimit <gwei>\n\n" +
        "🎯 Copy-mint — /track <address> [label], /untrack <address>, /mytracked\n" +
        "/copyon <address> <maxSpendEth>, /copyoff <address>\n\n" +
        "🎫 /eligibility <collection-slug> <walletId> — check a wallet's real OpenSea allowlist eligibility\n\n" +
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

  bot.command("track", async (ctx) => {
    const parts = (ctx.match || "").toString().trim().split(/\s+/).filter(Boolean);
    const address = parts[0];
    const label = parts.slice(1).join(" ");
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      await ctx.reply("Usage: /track <wallet address> [label]");
      return;
    }
    const telegramId = BigInt(ctx.from?.id ?? 0);
    const tracked = await trackWallet(telegramId, address, label || undefined);
    await ctx.reply(
      `👀 Now tracking ${tracked.label} (${tracked.trackedAddress}).\n` +
        `You'll be notified whenever it mints. Use /copyon ${address} <maxSpendEth> to also auto-copy its mints.`
    );
  });

  bot.command("untrack", async (ctx) => {
    const address = (ctx.match || "").toString().trim();
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      await ctx.reply("Usage: /untrack <wallet address>");
      return;
    }
    const telegramId = BigInt(ctx.from?.id ?? 0);
    const removed = await untrackWallet(telegramId, address);
    await ctx.reply(removed ? "Stopped tracking that wallet." : "You weren't tracking that wallet.");
  });

  bot.command("mytracked", async (ctx) => {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    const tracked = await listTrackedWallets(telegramId);
    if (tracked.length === 0) {
      await ctx.reply("Not tracking any wallets yet. Use /track <address> [label].");
      return;
    }
    const lines = tracked.map(
      (t) => `${t.autoCopy ? "⚡" : "👀"} ${t.label} — ${t.trackedAddress}${t.autoCopy ? ` (max ${(Number(t.maxSpendWei) / 1e18).toFixed(4)} ETH)` : ""}`
    );
    await ctx.reply(lines.join("\n"));
  });

  bot.command("copyon", async (ctx) => {
    const parts = (ctx.match || "").toString().trim().split(/\s+/).filter(Boolean);
    const address = parts[0];
    const maxSpendEth = Number(parts[1]);
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address) || !parts[1] || Number.isNaN(maxSpendEth) || maxSpendEth <= 0) {
      await ctx.reply("Usage: /copyon <tracked address> <maxSpendEth>\nExample: /copyon 0xabc... 0.05");
      return;
    }
    const telegramId = BigInt(ctx.from?.id ?? 0);
    try {
      await setAutoCopy(telegramId, address, true, maxSpendEth);
      await ctx.reply(
        `⚡ Auto-copy enabled for ${address}, up to ${maxSpendEth} ETH per mint.\n\n` +
          `This uses your auto-mint wallet and gas cap (/automintstatus to check). ` +
          `Make sure auto-mint is enabled or copies won't execute.`
      );
    } catch (cause) {
      await ctx.reply(`❌ ${cause instanceof Error ? cause.message : "Failed to enable auto-copy."}`);
    }
  });

  bot.command("copyoff", async (ctx) => {
    const address = (ctx.match || "").toString().trim();
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      await ctx.reply("Usage: /copyoff <tracked address>");
      return;
    }
    const telegramId = BigInt(ctx.from?.id ?? 0);
    try {
      await setAutoCopy(telegramId, address, false, null);
      await ctx.reply(`Auto-copy disabled for ${address}. Still tracking (notify-only) — use /untrack to stop entirely.`);
    } catch (cause) {
      await ctx.reply(`❌ ${cause instanceof Error ? cause.message : "Failed to disable auto-copy."}`);
    }
  });

  /**
   * OpenSea allowlist-eligibility check — wires up openseaEligibility.ts,
   * which was fully built and typechecked in Phase 3 but never called
   * from anywhere. Deliberately a manual command, not a discovery source:
   * unlike mintgo.fun, eligibility is inherently wallet+collection specific
   * (it needs one wallet's key to sign in as that wallet), so there's no
   * way to fold it into automated discovery that fans out to everyone.
   */
  bot.command("eligibility", async (ctx) => {
    const parts = (ctx.match || "").toString().trim().split(/\s+/).filter(Boolean);
    const [collectionSlug, walletId] = parts;
    if (!collectionSlug || !walletId) {
      await ctx.reply(
        "Usage: /eligibility <opensea-collection-slug> <walletId>\n" +
          "Find your walletId by opening a wallet from 💼 My Wallets — it's in that wallet's callback data, " +
          "or just try each wallet's short id shown there."
      );
      return;
    }

    const telegramId = BigInt(ctx.from?.id ?? 0);
    const wallet = await getWalletByIdForUser(telegramId, walletId);
    if (!wallet) {
      await ctx.reply("Wallet not found or not owned by you.");
      return;
    }

    const apiKey = process.env.OPENSEA_API_KEY;
    if (!apiKey) {
      await ctx.reply("OPENSEA_API_KEY is not configured on this bot — ask the operator to set it.");
      return;
    }

    let privateKey: string;
    try {
      privateKey = await getWalletPrivateKey(telegramId, walletId);
    } catch (cause) {
      await ctx.reply(cause instanceof Error ? cause.message : "Could not access that wallet's key.");
      return;
    }

    await ctx.reply("⏳ Checking real eligibility via OpenSea...");
    const result = await checkOpenSeaEligibility(collectionSlug, wallet.address, privateKey, apiKey);

    if (!result.ok) {
      await ctx.reply(`❌ ${result.error.message}`);
      return;
    }
    if (result.value.length === 0) {
      await ctx.reply("No eligibility stages found — this collection may not use gated stages, or the slug is wrong.");
      return;
    }

    const lines = result.value.map(
      (s) => `${s.eligible ? "✅" : "❌"} ${s.stage_type ?? s.stage_uuid}${s.mint_limit ? ` (limit ${s.mint_limit})` : ""}`
    );
    await ctx.reply(`Eligibility for ${shortenAddress(wallet.address)} on "${collectionSlug}":\n\n${lines.join("\n")}`);
  });

  bot.on("callback_query:data", handleCallback);
  bot.on("message:text", handleText);

  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  return bot;
}
