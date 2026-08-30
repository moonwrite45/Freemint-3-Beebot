/**
 * Typed error taxonomy for scan/detection failures.
 *
 * The old bot's biggest reliability bug: every failure mode (RPC timeout,
 * explorer rate-limit, missing API key, genuinely-not-a-contract, genuinely
 * unverified) got collapsed into the same generic "unverified / no free
 * mint found" result. That made transient failures indistinguishable from
 * real negatives — a rate-limited API call could silently make the bot
 * miss a real free mint, with no way to tell afterward what happened.
 *
 * Fix: every scan step returns a Result<T, ScanError> instead of null/undefined.
 * ScanError always carries a `kind` from the closed set below, plus a
 * human-readable `message` and the raw `cause` for logging. Nothing gets
 * to say "no free mint" unless it actually determined that — not "couldn't
 * check."
 */

export type ScanErrorKind =
  | "rpc_timeout" // RPC node didn't respond in time — retry, don't conclude anything
  | "rpc_error" // RPC responded with an error (bad request, node issue)
  | "rate_limited" // Explorer/API rate limit hit — retry with backoff, don't conclude
  | "explorer_unavailable" // Explorer API down/unreachable — distinct from rate limit
  | "missing_api_key" // We never even sent a valid request — config issue, not a real check
  | "no_bytecode" // Address has no contract code — genuinely not a contract
  | "unverified" // Contract exists but source/ABI genuinely isn't published
  | "not_nft" // Verified, but doesn't implement ERC-721/1155
  | "no_free_mint_function" // Verified NFT, but no function looks like an open free mint
  | "gated" // Verified free mint function exists, but gated (allowlist/signature/paused)
  | "supply_exhausted" // Verified open free mint, but sold/minted out
  | "simulation_reverted" // We dry-ran the actual mint call and it reverted
  | "unknown";

export interface ScanError {
  kind: ScanErrorKind;
  message: string;
  cause?: unknown;
  /** True if this is safe to retry later (transient) vs. a real negative. */
  retryable: boolean;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: ScanError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err(
  kind: ScanErrorKind,
  message: string,
  cause?: unknown
): Result<never> {
  return { ok: false, error: { kind, message, cause, retryable: RETRYABLE_KINDS.has(kind) } };
}

const RETRYABLE_KINDS = new Set<ScanErrorKind>([
  "rpc_timeout",
  "rpc_error",
  "rate_limited",
  "explorer_unavailable",
]);

/**
 * True negatives: the scan genuinely completed and found no free mint.
 * These should NEVER be produced by a caught exception — only by code
 * that actually read the relevant state and confirmed the negative.
 */
export const TERMINAL_NEGATIVE_KINDS = new Set<ScanErrorKind>([
  "no_bytecode",
  "unverified",
  "not_nft",
  "no_free_mint_function",
  "gated",
  "supply_exhausted",
  "simulation_reverted",
]);

/** User-facing message per error kind, so alerts never show a raw stack trace. */
export function describeScanError(e: ScanError): string {
  switch (e.kind) {
    case "rpc_timeout":
      return "Network timed out while checking this contract — will retry.";
    case "rpc_error":
      return "RPC node returned an error — will retry.";
    case "rate_limited":
      return "Rate-limited by the block explorer — will retry shortly.";
    case "explorer_unavailable":
      return "Block explorer API is unreachable right now — will retry.";
    case "missing_api_key":
      return "Explorer API key is missing or invalid — check bot config.";
    case "no_bytecode":
      return "No contract found at this address.";
    case "unverified":
      return "Contract source is not verified on the explorer.";
    case "not_nft":
      return "This contract does not implement ERC-721/1155.";
    case "no_free_mint_function":
      return "No open free-mint function was found on this contract.";
    case "gated":
      return "Free mint exists but requires allowlist/signature/is paused.";
    case "supply_exhausted":
      return "Mint supply is exhausted.";
    case "simulation_reverted":
      return "A real dry-run of the mint call reverted.";
    default:
      return "Unknown error during scan.";
  }
}
