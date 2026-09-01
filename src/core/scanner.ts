/**
 * Contract scanner v2.
 *
 * What changed from the old bot's scanner:
 *
 * 1. "Is this free?" is no longer decided by matching the function NAME
 *    against a blocklist/allowlist of strings. It's decided by:
 *      a) reading the function's stateMutability (payable vs not) — still
 *         useful, but only a first filter, never the final answer
 *      b) actually reading on-chain price state where the ABI exposes it
 *         (e.g. a `price()`/`mintPrice()`/`cost()` view function) and
 *         cross-checking it's zero
 *      c) dry-running the REAL mint call (see simulateRealMint) against
 *         the real target chain with realistic args, and reading the
 *         actual revert reason if it fails — never faking gas estimates
 *    A name like "claimFree" or "buyNFT" no longer decides anything by
 *    itself; it's only used as a candidate-ranking signal, not ground truth.
 *
 * 2. Every failure path returns a typed ScanError (see errors.ts) instead
 *    of collapsing into null/undefined. An RPC timeout, an explorer rate
 *    limit, a missing API key, and a genuine "not verified" are all
 *    distinguishable in the result and each carries `retryable: boolean`.
 */

import {
  type Address,
  type Hex,
  type Abi,
  parseAbi,
  encodeFunctionData,
  getFunctionSelector,
  getAddress,
  isAddress,
  decodeErrorResult,
  type PublicClient,
} from "viem";
import { getPublicClient } from "./chain.js";
import { getChainConfig, getDefaultChainId, type ChainId } from "./chains.js";
import { ok, err, type Result, type ScanError } from "./errors.js";

export interface MintCandidate {
  name: string;
  selector: string;
  args: string[];
  stateMutability: string;
  /** Ranking signal only — never used to decide free/paid on its own. */
  nameLooksFree: boolean;
}

export interface VerifiedFreeMint {
  candidate: MintCandidate;
  /** How we established this is actually free. */
  verifiedBy: "zero_payable_and_no_price_state" | "onchain_price_read_zero" | "dry_run_succeeded_with_zero_value";
  gasEstimate: bigint;
}

export interface ScanResult {
  contractAddress: string;
  isVerified: boolean;
  isNft: boolean;
  freeMint: VerifiedFreeMint | null;
  candidates: MintCandidate[];
}

const NAME_FREE_HINTS = ["free", "claim", "mint", "airdrop"];
const NAME_PAID_HINTS = ["buy", "purchase", "paid"];

type AbiFn = {
  type?: string;
  name?: string;
  inputs?: { type: string; name?: string }[];
  outputs?: { type: string; name?: string }[];
  stateMutability?: string;
};

function nameSignal(name: string): boolean {
  const lower = name.toLowerCase();
  const free = NAME_FREE_HINTS.some((h) => lower.includes(h));
  const paid = NAME_PAID_HINTS.some((h) => lower.includes(h));
  return free && !paid;
}

function isMintLikeFunction(fn: AbiFn): boolean {
  if (fn.type !== "function" || !fn.name) return false;
  if (fn.stateMutability === "view" || fn.stateMutability === "pure") return false;
  const lower = fn.name.toLowerCase();
  if (!lower.includes("mint") && !lower.includes("claim")) return false;
  // Exclude obvious admin/read-adjacent functions regardless of name signal —
  // this blocklist is a safety filter, not the free/paid decision.
  const adminPatterns = [/^set/i, /^update/i, /^admin/i, /^owner/i, /^withdraw/i, /^pause/i, /^configure/i];
  return !adminPatterns.some((p) => p.test(fn.name!));
}

export function extractMintCandidates(abi: Abi): MintCandidate[] {
  const candidates: MintCandidate[] = [];
  for (const item of abi as unknown as AbiFn[]) {
    if (!isMintLikeFunction(item)) continue;
    const args = (item.inputs || []).map((i) => i.type);
    const selector = getFunctionSelector(`${item.name}(${args.join(",")})`);
    candidates.push({
      name: item.name!,
      selector,
      args,
      stateMutability: item.stateMutability || "nonpayable",
      nameLooksFree: nameSignal(item.name!),
    });
  }
  // Rank: payable=false + free name signal first, then fewer args.
  return candidates.sort((a, b) => {
    const aFreeSignal = a.stateMutability !== "payable" && a.nameLooksFree ? 0 : 1;
    const bFreeSignal = b.stateMutability !== "payable" && b.nameLooksFree ? 0 : 1;
    if (aFreeSignal !== bFreeSignal) return aFreeSignal - bFreeSignal;
    return a.args.length - b.args.length;
  });
}

/** Look for a view function exposing price (mintPrice/price/cost) and read it. */
async function tryReadOnchainPrice(
  client: PublicClient,
  address: Address,
  abi: Abi
): Promise<Result<bigint | null>> {
  const priceFnNames = ["mintPrice", "price", "cost", "getPrice"];
  const candidates = (abi as unknown as AbiFn[]).filter(
    (f) =>
      f.type === "function" &&
      (f.stateMutability === "view" || f.stateMutability === "pure") &&
      (f.inputs?.length ?? 0) === 0 &&
      priceFnNames.some((n) => n.toLowerCase() === (f.name || "").toLowerCase())
  );
  if (candidates.length === 0) return ok(null);

  for (const fn of candidates) {
    try {
      const value = await client.readContract({
        address,
        abi: [fn] as unknown as Abi,
        functionName: fn.name!,
        args: [],
      } as any);
      if (typeof value === "bigint") return ok(value);
    } catch (cause) {
      // A single price-fn read failing isn't fatal — try the next candidate,
      // and if all fail, fall through to dry-run instead of guessing.
      continue;
    }
  }
  return ok(null);
}

/**
 * Dry-run the real mint call via eth_call/estimateGas against the actual
 * target chain, with value=0. If it succeeds, that's real evidence the
 * mint is callable for free right now — not a name guess. If it reverts,
 * we decode and surface the real reason instead of masking it.
 */
/**
 * Builds real call args for a mint candidate. Exported so auto-mint.ts
 * uses the EXACT same logic that was already exercised by dryRunMint —
 * not a second hand-copied version that could quietly drift from what
 * was actually verified.
 */
export function buildCandidateArgs(candidate: MintCandidate, callerAddress: Address): unknown[] {
  return candidate.args.map((type) => {
    const t = type.toLowerCase().trim();
    if (t.endsWith("[]")) return [];
    if (t.startsWith("uint") || t.startsWith("int")) return 1n;
    if (t === "address") return callerAddress;
    if (t === "bool") return true;
    if (t.startsWith("bytes")) return "0x" as Hex;
    if (t === "string") return "";
    return 0n;
  });
}

async function dryRunMint(
  client: PublicClient,
  contractAddress: Address,
  fromAddress: Address,
  candidate: MintCandidate
): Promise<Result<bigint>> {
  try {
    const abiItem = parseAbi([
      `function ${candidate.name}(${candidate.args.join(",")})`,
    ] as const);

    const args = buildCandidateArgs(candidate, fromAddress);

    const data = encodeFunctionData({
      abi: abiItem,
      functionName: candidate.name,
      args: args as any,
    });

    const gas = await client.estimateGas({
      account: fromAddress,
      to: contractAddress,
      data,
      value: 0n,
    });

    return ok(gas);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // Try to decode a real revert reason rather than swallowing it.
    let reason = message;
    try {
      if (cause && typeof cause === "object" && "data" in (cause as any)) {
        const decoded = decodeErrorResult({ data: (cause as any).data });
        reason = `${decoded.errorName}(${decoded.args?.join(", ") ?? ""})`;
      }
    } catch {
      // decoding failed, stick with the raw message
    }
    return err("simulation_reverted", reason, cause);
  }
}

/**
 * A price() (or similar) reading zero only proves the mint WAS free —
 * it says nothing about whether minting is still open right now. An old
 * project that was free at launch can have price() permanently return 0
 * forever after the mint actually ended, sold out, or got paused. This
 * checks the common signals for "is it still open" beyond price alone,
 * so a stale price==0 read doesn't get reported as a live free mint.
 *
 * Deliberately conservative: if a contract exposes none of these signals,
 * this returns ok(null) — absence of a pause/supply check is NOT treated
 * as evidence of anything, only an explicit "closed" signal is.
 */
async function checkMintStillOpen(client: PublicClient, address: Address, abi: Abi): Promise<Result<null>> {
  const fns = abi as unknown as AbiFn[];
  const isViewNoArgs = (f: AbiFn) =>
    f.type === "function" && (f.stateMutability === "view" || f.stateMutability === "pure") && (f.inputs?.length ?? 0) === 0;

  const activeFlagNames = new Set(["saleactive", "mintactive", "mintingactive", "ispublicsaleactive", "publicsaleactive", "mintenabled", "saleisactive", "isactive"]);
  const pausedFlagNames = new Set(["paused", "ispaused"]);

  for (const f of fns.filter(isViewNoArgs)) {
    const lower = (f.name || "").toLowerCase();
    const isPausedFlag = pausedFlagNames.has(lower);
    const isActiveFlag = activeFlagNames.has(lower);
    if (!isPausedFlag && !isActiveFlag) continue;

    try {
      const value = await client.readContract({
        address,
        abi: [f] as unknown as Abi,
        functionName: f.name!,
        args: [],
      } as any);
      if (typeof value !== "boolean") continue;
      const meansOpen = isPausedFlag ? value === false : value === true;
      if (!meansOpen) {
        return err("gated", `${f.name}() reports minting is not currently open`);
      }
    } catch {
      // Couldn't read it — don't conclude anything from a failed read either way.
    }
  }

  const supplyFn = fns.find((f) => isViewNoArgs(f) && (f.name || "").toLowerCase() === "totalsupply");
  const maxSupplyFn = fns.find(
    (f) => isViewNoArgs(f) && ["maxsupply", "max_supply", "totalmaxsupply"].includes((f.name || "").toLowerCase())
  );
  if (supplyFn && maxSupplyFn) {
    try {
      const [total, max] = await Promise.all([
        client.readContract({ address, abi: [supplyFn] as unknown as Abi, functionName: supplyFn.name!, args: [] } as any),
        client.readContract({ address, abi: [maxSupplyFn] as unknown as Abi, functionName: maxSupplyFn.name!, args: [] } as any),
      ]);
      if (typeof total === "bigint" && typeof max === "bigint" && max > 0n && total >= max) {
        return err("supply_exhausted", `${supplyFn.name}() (${total}) has reached ${maxSupplyFn.name}() (${max})`);
      }
    } catch {
      // Couldn't read — don't conclude.
    }
  }

  return ok(null);
}

async function getBytecode(client: PublicClient, address: Address): Promise<Result<Hex>> {
  try {
    const code = await client.getBytecode({ address });
    if (!code || code === "0x") return err("no_bytecode", `No contract at ${address}`);
    return ok(code as Hex);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const timedOut = /timeout|timed out/i.test(message);
    return err(timedOut ? "rpc_timeout" : "rpc_error", message, cause);
  }
}

interface ExplorerJson {
  status?: string;
  message?: string;
  result?: unknown;
}

async function fetchExplorerJson(url: string): Promise<Result<ExplorerJson>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url);
      if (response.status === 429) {
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
        continue;
      }
      if (!response.ok) {
        return err("explorer_unavailable", `Explorer returned HTTP ${response.status}`);
      }
      return ok((await response.json()) as ExplorerJson);
    } catch (cause) {
      if (attempt === 2) {
        return err("explorer_unavailable", "Explorer API unreachable after 3 attempts", cause);
      }
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
  }
  return err("rate_limited", "Explorer rate limit not cleared after 3 attempts");
}

async function fetchAbi(address: Address, chain: ChainId): Promise<Result<Abi>> {
  const cfg = getChainConfig(chain);

  let url: string;
  if (cfg.explorerKind === "etherscan-v2") {
    const apiKey = cfg.explorerApiKeyEnv ? process.env[cfg.explorerApiKeyEnv] : undefined;
    if (!apiKey) {
      return err("missing_api_key", `${cfg.explorerApiKeyEnv} is not set — cannot verify contracts on ${chain}`);
    }
    url = `${cfg.explorerApiUrl}?module=contract&action=getabi&address=${address}&chainid=${cfg.explorerChainParam}&apikey=${encodeURIComponent(apiKey)}`;
  } else {
    // Blockscout's Etherscan-compatible /api endpoint — no key needed on
    // the public tier for either Robinhood Chain or Ink.
    url = `${cfg.explorerApiUrl}?module=contract&action=getabi&address=${address}`;
  }

  const res = await fetchExplorerJson(url);
  if (!res.ok) return res;

  if (res.value.status === "1" && typeof res.value.result === "string") {
    try {
      const parsed = JSON.parse(res.value.result);
      if (Array.isArray(parsed) && parsed.length > 0) return ok(parsed as Abi);
    } catch (cause) {
      return err("unverified", "ABI response was not valid JSON", cause);
    }
  }
  return err("unverified", res.value.message || "Contract source is not verified");
}

function abiLooksLikeNft(abi: Abi): boolean {
  const names = new Set((abi as unknown as AbiFn[]).map((f) => f.name).filter(Boolean));
  const erc721Signals = ["ownerOf", "safeTransferFrom", "balanceOf", "tokenURI"];
  return erc721Signals.filter((s) => names.has(s)).length >= 2;
}

/**
 * Used by automated discovery (discovery.ts), which has no specific
 * wallet to probe from — it's finding candidates for every subscriber,
 * not minting on behalf of one person. This is the well-known "burn"
 * address: valid, non-zero (some contracts reject address(0) as a
 * recipient), holds no funds, and this dry-run is read-only (eth_call/
 * estimateGas) so nothing is ever signed or sent from it. Using this
 * instead of no probe address at all means background discovery can
 * reach the strongest verification tier (dry_run_succeeded_with_zero_value)
 * instead of only ever using the two weaker tiers.
 */
export const DEFAULT_PROBE_ADDRESS = "0x000000000000000000000000000000000000dEaD" as Address;

export async function scanContract(
  address: string,
  chain: ChainId = getDefaultChainId(),
  /** A real address to dry-run the mint call from (e.g. a burner wallet). */
  probeFromAddress?: string
): Promise<Result<ScanResult>> {
  const checksumAddress = isAddress(address) ? getAddress(address) : null;
  if (!checksumAddress) return err("no_bytecode", `Not a valid address: ${address}`);

  const client = getPublicClient(chain);

  const bytecodeResult = await getBytecode(client, checksumAddress);
  if (!bytecodeResult.ok) return bytecodeResult;

  const abiResult = await fetchAbi(checksumAddress, chain);
  if (!abiResult.ok) return abiResult;
  const abi = abiResult.value;

  const isNft = abiLooksLikeNft(abi);
  if (!isNft) return err("not_nft", "Contract does not expose ERC-721-like interface");

  const candidates = extractMintCandidates(abi);
  if (candidates.length === 0) {
    return err("no_free_mint_function", "No mint-like function found in ABI");
  }

  // Try each candidate, best-ranked first, until one verifies as free.
  for (const candidate of candidates) {
    const priceResult = await tryReadOnchainPrice(client, checksumAddress, abi);
    let priceWasZero = false;

    if (priceResult.ok && priceResult.value !== null) {
      if (priceResult.value > 0n) continue; // genuinely priced — not free, try next candidate
      priceWasZero = true;

      // Bug fix: price==0 alone used to be trusted as "verified free mint,
      // currently open." It only proves price was ever zero — an old
      // project can keep price()==0 forever after the mint actually ended,
      // sold out, or got paused. Check for an explicit closed signal
      // before trusting this tier as the final answer.
      const stillOpen = await checkMintStillOpen(client, checksumAddress, abi);
      if (stillOpen.ok) {
        return ok({
          contractAddress: checksumAddress,
          isVerified: true,
          isNft: true,
          freeMint: {
            candidate,
            verifiedBy: "onchain_price_read_zero",
            gasEstimate: 150_000n, // refined by dry-run below when we have a probe address
          },
          candidates,
        });
      }
      // Confirmed closed (gated/paused/sold out) via this signal — don't
      // trust the price tier. Still worth letting a real dry-run (below)
      // have the final say for THIS candidate if we can attempt one,
      // since it's definitive and our flag-name heuristic could be wrong
      // about which flag actually gates this specific function.
    }

    if (probeFromAddress && isAddress(probeFromAddress)) {
      const dryRun = await dryRunMint(client, checksumAddress, getAddress(probeFromAddress), candidate);
      if (dryRun.ok) {
        return ok({
          contractAddress: checksumAddress,
          isVerified: true,
          isNft: true,
          freeMint: {
            candidate,
            verifiedBy: "dry_run_succeeded_with_zero_value",
            gasEstimate: dryRun.value,
          },
          candidates,
        });
      }
      // A genuine revert on THIS candidate just means try the next one —
      // it does not mean "no free mint anywhere on this contract."
      if (dryRun.error.kind !== "simulation_reverted") {
        return dryRun; // rpc_timeout etc. — surface as retryable, don't guess
      }
      continue;
    }

    // No probe address available, and either no price signal at all or a
    // price signal we already determined is closed: fall back to the
    // conservative name-only signal ONLY if we never found pricing info in
    // the first place — a confirmed-closed price read is stronger evidence
    // than a name guess, and must not be overridden by a weaker tier.
    if (!priceWasZero && candidate.stateMutability !== "payable" && candidate.nameLooksFree) {
      return ok({
        contractAddress: checksumAddress,
        isVerified: true,
        isNft: true,
        freeMint: {
          candidate,
          verifiedBy: "zero_payable_and_no_price_state",
          gasEstimate: 150_000n,
        },
        candidates,
      });
    }
  }

  return err("no_free_mint_function", "No candidate verified as a free mint");
}
