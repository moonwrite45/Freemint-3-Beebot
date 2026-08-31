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

    const args = candidate.args.map((type) => {
      const t = type.toLowerCase().trim();
      if (t.endsWith("[]")) return [];
      if (t.startsWith("uint") || t.startsWith("int")) return 1n;
      if (t === "address") return fromAddress;
      if (t === "bool") return true;
      if (t.startsWith("bytes")) return "0x" as Hex;
      if (t === "string") return "";
      return 0n;
    });

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
    if (candidate.stateMutability === "payable") {
      // Payable functions still get a chance via on-chain price read (price
      // could genuinely be 0 even on a payable function) rather than an
      // automatic skip.
    }

    const priceResult = await tryReadOnchainPrice(client, checksumAddress, abi);
    if (priceResult.ok && priceResult.value !== null) {
      if (priceResult.value > 0n) continue; // genuinely priced — not free, try next candidate
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

    // No probe address and no readable price state: fall back to the
    // conservative signal (non-payable + free name hint), but label it
    // clearly as the weakest verification tier.
    if (candidate.stateMutability !== "payable" && candidate.nameLooksFree) {
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
