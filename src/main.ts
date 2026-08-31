import "dotenv/config";
import { createBot } from "./bot/index.js";
import { startDiscovery, type VerifiedAlert } from "./core/discovery.js";
import { allChainIds } from "./core/chains.js";
import { scanResultKeyboard } from "./bot/keyboards.js";

async function main() {
  const bot = await createBot();

  /**
   * Alert delivery — fixed a real fairness bug here. The naive version
   * of this loop awaited each sendMessage before starting the next one,
   * which for N subscribers means the Nth person's alert lands N × ~200ms
   * after the first person's. For a free mint that can sell out in
   * seconds, that's not a cosmetic issue — it's actively disadvantaging
   * whoever happens to be later in the recipient list, with zero
   * prioritization logic behind that ordering.
   *
   * Fix: fire sends concurrently in bounded batches. Telegram's Bot API
   * caps out around 30 messages/second globally per bot, so unbounded
   * Promise.all risks 429s — batches of 25 with a short pause between
   * batches stays under that ceiling while still delivering to everyone
   * within roughly one batch-window instead of a linear chain.
   */
  const DELIVERY_BATCH_SIZE = 25;
  const DELIVERY_BATCH_PAUSE_MS = 1000;

  async function deliverAlert(alert: VerifiedAlert) {
    const fm = alert.scan.freeMint!;
    const text =
      `✅ Free mint detected!\n\n` +
      `Contract: ${alert.scan.contractAddress}\n` +
      `Chain: ${alert.chain}\n` +
      `Function: ${fm.candidate.name}(${fm.candidate.args.join(", ")})\n` +
      `Verified by: ${fm.verifiedBy}\n` +
      `Source: ${alert.source}`;

    const markup = { reply_markup: scanResultKeyboard(alert.scan.contractAddress, alert.chain, true) };

    for (let i = 0; i < alert.recipients.length; i += DELIVERY_BATCH_SIZE) {
      const batch = alert.recipients.slice(i, i + DELIVERY_BATCH_SIZE);
      await Promise.all(
        batch.map((telegramId) =>
          bot.api
            .sendMessage(Number(telegramId), text, markup)
            .catch((cause) => console.error(`[main] failed to deliver alert to ${telegramId}:`, cause))
        )
      );
      if (i + DELIVERY_BATCH_SIZE < alert.recipients.length) {
        await new Promise((resolve) => setTimeout(resolve, DELIVERY_BATCH_PAUSE_MS));
      }
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
