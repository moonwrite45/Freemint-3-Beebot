/**
 * Ties the discovery sources together: on-chain listener proposes
 * candidates -> scanner.ts verifies them for real -> deduped -> routed to
 * every Telegram user actually subscribed to that chain.
 *
 * Fixed gap: this used to call a single global onAlert callback, which
 * would have broadcast every alert to every user with no isolation the
 * moment more than one person used the bot. Now each verified free mint
 * is looked up against real subscribers (subscriptions.ts, DB-backed) and
 * delivered only to users who actually opted into that chain.
 *
 * mintgo.fun is deliberately NOT wired in here yet — see mintgoSource.ts
 * for why. Adding it later is just one more candidate source feeding the
 * same verify-then-route pipeline below.
 */

import { scanContract } from "./scanner.js";
import { startAllListeners, type DiscoveryCandidate } from "./listener.js";
import { SeenContracts } from "./queue.js";
import { getSubscribersForChain } from "./subscriptions.js";
import type { ChainId } from "./chains.js";
import type { ScanResult } from "./scanner.js";

export interface VerifiedAlert {
  scan: ScanResult;
  chain: ChainId;
  source: DiscoveryCandidate["source"];
  /** Telegram ids of users actually subscribed to this chain — never empty when delivered. */
  recipients: bigint[];
}

export type AlertCallback = (alert: VerifiedAlert) => Promise<void>;

export function startDiscovery(chains: ChainId[], onAlert: AlertCallback): void {
  const seen = new SeenContracts();

  startAllListeners(
    chains,
    async (candidate) => {
      const result = await scanContract(candidate.contractAddress, candidate.chain);

      if (!result.ok) {
        if (result.error.retryable) {
          console.log(`[discovery] retryable scan failure for ${candidate.contractAddress}: ${result.error.message}`);
        }
        return;
      }

      if (!result.value.freeMint) return; // verified negative, not an error — no alert

      const recipients = await getSubscribersForChain(candidate.chain).catch((cause) => {
        console.error("[discovery] failed to load subscribers:", cause);
        return [] as bigint[];
      });

      if (recipients.length === 0) return; // nobody subscribed on this chain — nothing to deliver

      await onAlert({
        scan: result.value,
        chain: candidate.chain,
        source: candidate.source,
        recipients,
      }).catch((cause) => console.error("[discovery] alert callback failed:", cause));
    },
    seen
  );
}
