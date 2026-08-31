/**
 * mintgo.fun discovery source.
 *
 * Endpoint confirmed real via a browser-side network capture (bookmarklet
 * hooking fetch/XHR/WebSocket) run by the user directly against
 * mintgo.fun — not guessed:
 *
 *   GET https://mintgo.fun/api/seadrop-radar?chain={chain}
 *
 * IMPORTANT CHAIN MISMATCH: MintGo's own UI only offers ALL / ETH / RH / INK
 * as filters — there is no Base option. So this source only ever has data
 * for two of our three chains (robinhood, ink); it can never surface
 * anything for base. Calls for chain="base" are skipped entirely rather
 * than silently sent to an endpoint that doesn't support it.
 *
 * What's still unconfirmed: the exact JSON response SHAPE. We have the
 * real endpoint, not a real captured response body. Parsing below is
 * deliberately defensive (accepts a few plausible shapes, returns a typed
 * error if none match) rather than assuming a specific structure I never
 * actually saw. To finish this for real: extend the same bookmarklet to
 * log response bodies (not just URLs) for this specific endpoint and
 * share what comes back — see chat history for the body-logging variant.
 */

import { err, ok, type Result } from "./errors.js";
import type { ChainId } from "./chains.js";

const MINTGO_BASE_URL = "https://mintgo.fun";

// MintGo's own chain params, confirmed from captured requests. Not the
// same strings as our internal ChainId in every case (matches for
// "robinhood"/"ink", has no equivalent for "base").
const MINTGO_CHAIN_PARAM: Partial<Record<ChainId, string>> = {
  robinhood: "robinhood",
  ink: "ink",
};

export interface MintGoCandidate {
  contractAddress: string;
  chain: ChainId;
  name: string;
  detectedAt: number;
}

interface RawSeadropRadarItem {
  address?: string;
  contract?: string;
  contractAddress?: string;
  name?: string;
  title?: string;
  timestamp?: number;
  detected_at?: number;
}

function normalizeCandidate(raw: RawSeadropRadarItem, chain: ChainId): MintGoCandidate | null {
  const address = raw.address ?? raw.contract ?? raw.contractAddress;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  return {
    contractAddress: address,
    chain,
    name: raw.name ?? raw.title ?? "Unknown",
    detectedAt: raw.timestamp ?? raw.detected_at ?? Date.now(),
  };
}

export async function pollMintGo(chain: ChainId): Promise<Result<MintGoCandidate[]>> {
  const chainParam = MINTGO_CHAIN_PARAM[chain];
  if (!chainParam) {
    // Not an error — this is the expected, documented case for "base".
    return ok([]);
  }

  const url = `${MINTGO_BASE_URL}/api/seadrop-radar?chain=${chainParam}`;

  try {
    const res = await fetch(url);
    if (res.status === 429) {
      return err("rate_limited", "mintgo.fun rate-limited this request");
    }
    if (!res.ok) {
      return err("explorer_unavailable", `mintgo.fun endpoint returned HTTP ${res.status}`);
    }

    const data = (await res.json()) as unknown;

    // Defensive parsing — shape unconfirmed. Accept either a bare array
    // or a {results:[...]} / {data:[...]} wrapper, the most common shapes
    // for an endpoint like this. Anything else surfaces as a typed error
    // instead of silently returning an empty list that looks like "no
    // free mints" when really it's "we don't understand the response."
    const items = Array.isArray(data)
      ? data
      : Array.isArray((data as { results?: unknown[] })?.results)
        ? (data as { results: unknown[] }).results
        : Array.isArray((data as { data?: unknown[] })?.data)
          ? (data as { data: unknown[] }).data
          : null;

    if (items === null) {
      return err(
        "unknown",
        "mintgo.fun response shape didn't match any expected format (bare array, {results:[]}, or {data:[]}) — " +
          "capture a real response body to fix the parser."
      );
    }

    const candidates = (items as RawSeadropRadarItem[])
      .map((item) => normalizeCandidate(item, chain))
      .filter((c): c is MintGoCandidate => c !== null);

    return ok(candidates);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err("explorer_unavailable", `mintgo.fun request failed: ${message}`, cause);
  }
}
