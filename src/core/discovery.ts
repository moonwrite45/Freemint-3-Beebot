/**
 * Ties the discovery sources together: on-chain listener proposes
 * candidates -> scanner.ts verifies them for real -> deduped -> handed
 * to a caller-supplied alert callback (the Telegram bot in main.ts).
 *
 * mintgo.fun is deliberately NOT wired in here yet — see mintgoSource.ts
 * for why. Adding it later is just one more candidate source feeding the
 * same verify-then-alert pipeline below.
 */

import { scanContract } from "./scanner.js";
import { startAllListeners, type DiscoveryCandidate } from "./listener.js";
import { SeenContracts } from "./queue.js";
import type { ChainId } from "./chains.js";
import type { ScanResult } from "./scanner.js";

export interface VerifiedAlert {
  scan: ScanResult;
  chain: ChainId;
  source: DiscoveryCandidate["source"];
}

export type AlertCallback = (alert: VerifiedAlert) => Promise<void>;

export function startDiscovery(chains: ChainId[], onAlert: AlertCallback): void {
  const seen = new SeenContracts();

  startAllListeners(
    chains,
    async (candidate) => {
      const result = await scanContract(candidate.contractAddress, candidate.chain);

      if (!result.ok) {
        // Retryable failures (rate limits, RPC timeouts) just get dropped
        // from this pass — the contract wasn't marked "seen" as a false
        // negative, so a later block/poll can pick it back up naturally
        // since listener.ts's own seen-set is separate from verification.
        if (result.error.retryable) {
          console.log(`[discovery] retryable scan failure for ${candidate.contractAddress}: ${result.error.message}`);
        }
        return;
      }

      if (!result.value.freeMint) return; // verified negative, not an error — no alert

      await onAlert({
        scan: result.value,
        chain: candidate.chain,
        source: candidate.source,
      }).catch((cause) => console.error("[discovery] alert callback failed:", cause));
    },
    seen
  );
}
