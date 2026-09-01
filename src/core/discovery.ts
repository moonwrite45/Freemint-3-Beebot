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

import { scanContract, DEFAULT_PROBE_ADDRESS } from "./scanner.js";
import { MINT_SELECTORS, type ChainWatcher, type TxInfo } from "./listener.js";
import { SeenContracts, seenKey } from "./queue.js";
import { getSubscribersForChain } from "./subscriptions.js";
import type { ChainId } from "./chains.js";
import type { ScanResult } from "./scanner.js";

export interface VerifiedAlert {
  scan: ScanResult;
  chain: ChainId;
  source: "onchain_new_contract" | "onchain_mint_call" | "mintgo_fun";
  /** Telegram ids of users actually subscribed to this chain — never empty when delivered. */
  recipients: bigint[];
}

export type AlertCallback = (alert: VerifiedAlert) => Promise<void>;

/**
 * A ChainWatcher plus one extra entry point for candidates that don't
 * come from the block listener — e.g. mintgo.fun's poller. Both paths
 * share the same seen-set and the same real scanner.ts verification, so
 * a contract found by one source is never re-alerted by the other, and
 * neither source can shortcut the "verify before alert" rule.
 */
export interface DiscoveryEngine extends ChainWatcher {
  checkExternalCandidate(contractAddress: string, chain: ChainId, source: VerifiedAlert["source"]): Promise<void>;
}

export function createDiscoveryWatcher(onAlert: AlertCallback): DiscoveryEngine {
  const seen = new SeenContracts();

  async function handleCandidate(contractAddress: string, chain: ChainId, source: VerifiedAlert["source"]): Promise<void> {
    const key = seenKey(chain, contractAddress);
    if (seen.has(key)) return;
    seen.add(key);

    // Fix: this used to call scanContract with no probe address at all,
    // meaning every automated background scan could only ever reach the
    // two weaker verification tiers (price-read, name-signal) — never the
    // strongest one (a real dry-run). Passing a fixed, funds-free probe
    // address costs nothing (dry-run is read-only) and lets background
    // discovery reach the same strength of verification as a manual scan.
    const result = await scanContract(contractAddress, chain, DEFAULT_PROBE_ADDRESS);

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
    async checkExternalCandidate(contractAddress, chain, source) {
      await handleCandidate(contractAddress, chain, source);
    },
  };
}
