/**
 * OpenSea allowlist-eligibility checker, ported from the
 * robinhood-allowlist repo pattern we reviewed and verified safe (real
 * @opensea/sdk, private key used only for local SIWE signing, never
 * transmitted — see chat history/memory for the audit).
 *
 * This is a DISCOVERY/VERIFICATION source, not a bypass. It answers
 * "is this wallet actually eligible for this drop's current stage?" —
 * an honest yes/no from OpenSea's own API — rather than guessing or
 * attempting to circumvent access control. If the wallet isn't
 * eligible, this correctly reports that; it does not try to forge
 * eligibility.
 */

import { ethers } from "ethers";
import { ok, err, type Result } from "./errors.js";

const OPENSEA_BASE_URL = "https://api.opensea.io/api/v2";

// Ported directly: an eligibility endpoint that returns a status STRING
// (e.g. "not_eligible") is truthy in JS, so a naive `!!value` check would
// silently treat every gated stage as eligible. This allowlist of exact
// accepted values is the fix, kept verbatim from the source repo.
const ELIGIBLE_STRINGS = new Set(["eligible", "qualified", "true", "yes", "1"]);

function readEligible(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ELIGIBLE_STRINGS.has(value.trim().toLowerCase());
  if (typeof value === "number") return value === 1;
  return false; // undefined/null/object/anything unrecognized -> not eligible, never assume yes
}

export interface EligibilityStage {
  stage_uuid: string;
  stage_type?: string;
  eligible: boolean;
  mint_limit?: number;
  raw: unknown;
}

interface OpenSeaAuthLike {
  authenticate(signer: ethers.Wallet, opts: { scopes: string[] }): Promise<void>;
  getValidToken(): Promise<{ accessToken: string }>;
}

/**
 * Lazily import @opensea/sdk so this module doesn't hard-fail to load if
 * the package isn't installed yet in an environment that doesn't need it.
 */
async function getOpenSeaAuth(): Promise<new () => OpenSeaAuthLike> {
  const mod = await import("@opensea/sdk");
  return (mod as unknown as { OpenSeaAuth: new () => OpenSeaAuthLike }).OpenSeaAuth;
}

async function openseaFetch(apiKey: string, path: string, opts: { bearerToken?: string } = {}): Promise<unknown> {
  const url = `${OPENSEA_BASE_URL}${path}`;
  const headers: Record<string, string> = { "x-api-key": apiKey };
  if (opts.bearerToken) headers["Authorization"] = `Bearer ${opts.bearerToken}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} on ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function parseEligibility(raw: unknown): EligibilityStage[] {
  const stagesRaw = Array.isArray(raw)
    ? raw
    : (raw as { stages?: unknown[] })?.stages ?? [];

  return (stagesRaw as Record<string, unknown>[]).map((s) => ({
    stage_uuid: String(s.stage_uuid ?? s.id ?? ""),
    stage_type: typeof s.stage_type === "string" ? s.stage_type : undefined,
    eligible: readEligible(s.eligible ?? s.status),
    mint_limit: typeof s.mint_limit === "number" ? s.mint_limit : undefined,
    raw: s,
  }));
}

/**
 * Checks a wallet's real eligibility for a drop via OpenSea's own API.
 * The private key never leaves this process and is never sent anywhere —
 * it's used only to produce a local SIWE signature, exactly as in the
 * reviewed source repo.
 */
export async function checkOpenSeaEligibility(
  collectionSlug: string,
  walletAddress: string,
  privateKey: string,
  apiKey: string
): Promise<Result<EligibilityStage[]>> {
  let signer: ethers.Wallet;
  try {
    signer = new ethers.Wallet(privateKey);
  } catch (cause) {
    return err("unknown" as any, "Invalid private key format", cause);
  }

  if (signer.address.toLowerCase() !== walletAddress.toLowerCase()) {
    return err(
      "unknown" as any,
      `Provided private key belongs to ${signer.address}, not ${walletAddress}. ` +
        `Eligibility is wallet-specific — signer and checked address must match.`
    );
  }

  try {
    const OpenSeaAuth = await getOpenSeaAuth();
    const auth = new OpenSeaAuth();
    await auth.authenticate(signer, { scopes: ["read:eligibility"] });
    const token = await auth.getValidToken();

    const raw = await openseaFetch(apiKey, `/drops/${collectionSlug}/eligibility`, {
      bearerToken: token.accessToken,
    });

    return ok(parseEligibility(raw));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/429/.test(message)) return err("rate_limited", "OpenSea API rate-limited this request", cause);
    return err("explorer_unavailable", `OpenSea eligibility check failed: ${message}`, cause);
  }
}
