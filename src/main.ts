import "dotenv/config";
import { createBot } from "./bot/index.js";
import { startDiscovery, type VerifiedAlert } from "./core/discovery.js";
import { allChainIds } from "./core/chains.js";
import { scanResultKeyboard } from "./bot/keyboards.js";

async function main() {
  const bot = await createBot();

  async function deliverAlert(alert: VerifiedAlert) {
    const fm = alert.scan.freeMint!;
    const text =
      `✅ Free mint detected!\n\n` +
      `Contract: ${alert.scan.contractAddress}\n` +
      `Chain: ${alert.chain}\n` +
      `Function: ${fm.candidate.name}(${fm.candidate.args.join(", ")})\n` +
      `Verified by: ${fm.verifiedBy}\n` +
      `Source: ${alert.source}`;

    for (const telegramId of alert.recipients) {
      await bot.api
        .sendMessage(Number(telegramId), text, {
          reply_markup: scanResultKeyboard(alert.scan.contractAddress, alert.chain, true),
        })
        .catch((cause) => console.error(`[main] failed to deliver alert to ${telegramId}:`, cause));
    }
  }

  // Discovery only watches chains someone has actually configured via
  // env — defaults to every chain we support if unset. Per-user filtering
  // happens downstream in discovery.ts via real subscriptions, this list
  // is just "which chains does the listener bother watching at all."
  const watchedChains = (process.env.WATCHED_CHAINS?.split(",").map((c) => c.trim()) as ReturnType<typeof allChainIds>) ?? allChainIds();

  startDiscovery(watchedChains.length ? watchedChains : allChainIds(), deliverAlert);

  await bot.start();
}

main().catch((cause) => {
  console.error("Fatal startup error:", cause);
  process.exit(1);
});
