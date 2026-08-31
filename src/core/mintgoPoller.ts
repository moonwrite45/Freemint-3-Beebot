/**
 * Polls mintgo.fun on an interval and feeds whatever it finds through
 * the same DiscoveryEngine (real on-chain verification + dedupe + alert)
 * used by the block listener — mintgo.fun is a discovery HINT, not a
 * trusted source, so nothing from it ever reaches a user without
 * scanner.ts independently confirming it's a real free mint.
 *
 * Only polls chains MintGo actually covers (robinhood, ink) — see
 * mintgoSource.ts for why "base" has no equivalent and is skipped.
 */

import { pollMintGo } from "./mintgoSource.js";
import type { DiscoveryEngine } from "./discovery.js";
import type { ChainId } from "./chains.js";

const POLL_INTERVAL_MS = 45_000;
const MINTGO_CHAINS: ChainId[] = ["robinhood", "ink"];

export function startMintGoPolling(engine: DiscoveryEngine): ReturnType<typeof setInterval> {
  async function pollAll(): Promise<void> {
    for (const chain of MINTGO_CHAINS) {
      const result = await pollMintGo(chain);
      if (!result.ok) {
        // Only log genuine problems — a rate-limit or transient outage
        // here isn't worth alarming about, mintgo.fun is a bonus source,
        // not the only one.
        if (!result.error.retryable) {
          console.error(`[mintgo] ${chain}: ${result.error.message}`);
        }
        continue;
      }

      for (const candidate of result.value) {
        await engine
          .checkExternalCandidate(candidate.contractAddress, candidate.chain, "mintgo_fun")
          .catch((cause) => console.error(`[mintgo] checkExternalCandidate failed for ${candidate.contractAddress}:`, cause));
      }
    }
  }

  pollAll(); // run immediately, don't wait for the first interval tick
  return setInterval(pollAll, POLL_INTERVAL_MS);
}
