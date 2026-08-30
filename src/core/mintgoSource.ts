/**
 * mintgo.fun discovery source — INCOMPLETE BY DESIGN, read this before using.
 *
 * mintgo.fun is a client-rendered dashboard (confirmed by fetching it: the
 * page ships almost no static content, just a shell that a JS bundle fills
 * in with "Trending" / "New Mints" / "Runners" panels). That means its real
 * data comes from an API call made *after* the page loads in a browser,
 * and I have no tool that executes JavaScript or inspects live network
 * traffic — so I cannot see what that endpoint actually is, what params
 * it takes, or what shape it returns. Anything I wrote here without that
 * would be a guess dressed up as a working integration, which is exactly
 * the failure mode we're trying to move away from.
 *
 * To finish this module for real, one of the following gets us there:
 *   1. On your phone, open mintgo.fun in a browser that has a network
 *      inspector (Chrome/Kiwi's "Developer options" > remote debugging,
 *      or an app like "HTTP Toolkit") and capture the request the page
 *      makes for "New Mints" — share the URL + response shape.
 *   2. Check if mintgo.fun publishes API docs anywhere (their site footer,
 *      a /docs or /api path, their X/Twitter, or a Discord).
 *   3. If neither works, we drop this as a source and rely on the on-chain
 *      listener + OpenSea eligibility, which are both real and already wired.
 *
 * Until then, this exports a typed interface so the merge/discovery layer
 * can compile against it, and a stub implementation that clearly reports
 * "not configured" rather than silently returning nothing (which would be
 * exactly the kind of ambiguous failure the old bot had elsewhere).
 */

import { err, type Result } from "./errors.js";

export interface MintGoCandidate {
  contractAddress: string;
  chain: string;
  name: string;
  detectedAt: number;
}

export async function pollMintGo(): Promise<Result<MintGoCandidate[]>> {
  const endpoint = process.env.MINTGO_API_URL;
  if (!endpoint) {
    return err(
      "missing_api_key",
      "MINTGO_API_URL is not set — mintgo.fun's real data endpoint hasn't " +
        "been identified yet (it's a client-rendered dashboard with no " +
        "documented public API). See the comment at the top of this file " +
        "for how to find it."
    );
  }

  try {
    const res = await fetch(endpoint);
    if (!res.ok) {
      return err("explorer_unavailable", `mintgo.fun endpoint returned HTTP ${res.status}`);
    }
    const data = (await res.json()) as unknown;
    // Shape unknown until we've confirmed the real endpoint — this cast is
    // a placeholder, not a verified contract with mintgo.fun's API.
    return { ok: true, value: (Array.isArray(data) ? data : []) as MintGoCandidate[] };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err("explorer_unavailable", `mintgo.fun request failed: ${message}`, cause);
  }
}
