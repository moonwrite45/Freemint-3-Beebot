/**
 * Free-mint discovery watcher — verifies candidates (new contracts, or
 * calls to known mint-like selectors) via scanner.ts's real state checks,
 * dedupes, and routes to real per-chain subscribers.
 *
 * This is now a ChainWatcher (see listener.ts) rather than owning its
 * own polling loop — it shares one block feed per chain with whatever
 * other watchers are running (currently just copyMint.ts's whale
 * tracker), instead of each watcher polling the RPC independently.
 */

import { scanContract } from "./scanner.js";
import { MINT_SELECTORS, type ChainWatcher, type TxInfo } from "./listener.js";
import { SeenContracts, seenKey } from "./queue.js";
import { getSubscribersForChain } from "./subscriptions.js";
import type { ChainId } from "./chains.js";
import type { ScanResult } from "./scanner.js";

export interface VerifiedAlert {
  scan: ScanResult;
  chain: ChainId;
  source: "onchain_new_contract" | "onchain_mint_call";
  /** Telegram ids of users actually subscribed to this chain — never empty when delivered. */
  recipients: bigint[];
}

export type AlertCallback = (alert: VerifiedAlert) => Promise<void>;

export function createDiscoveryWatcher(onAlert: AlertCallback): ChainWatcher {
  const seen = new SeenContracts();

  async function handleCandidate(contractAddress: string, chain: ChainId, source: VerifiedAlert["source"]): Promise<void> {
    const key = seenKey(chain, contractAddress);
    if (seen.has(key)) return;
    seen.add(key);

    const result = await scanContract(contractAddress, chain);

    if (!result.ok) {
      if (result.error.retryable) {
        console.log(`[discovery] retryable scan failure for ${contractAddress}: ${result.error.message}`);
      }
      return;
    }

    if (!result.value.freeMint) return; // verified negative, not an error — no alert

    const recipients = await getSubscribersForChain(chain).catch((cause) => {
      console.error("[discovery] failed to load subscribers:", cause);
      return [] as bigint[];
    });

    if (recipients.length === 0) return; // nobody subscribed on this chain — nothing to deliver

    await onAlert({ scan: result.value, chain, source, recipients }).catch((cause) =>
      console.error("[discovery] alert callback failed:", cause)
    );
  }

  return {
    async onNewContract(address, chain) {
      await handleCandidate(address, chain, "onchain_new_contract");
    },
    async onTransaction(tx: TxInfo, chain) {
      const selector = (tx.input || "0x").slice(0, 10);
      if (tx.to && MINT_SELECTORS.has(selector)) {
        await handleCandidate(tx.to, chain, "onchain_mint_call");
      }
    },
  };
}
