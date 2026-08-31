import { prisma } from "../db/client.js";
import type { ChainWatcher, TxInfo } from "./listener.js";
import { MINT_SELECTORS } from "./listener.js";
import { normalizeAddress } from "./chain.js";
import type { ChainId } from "./chains.js";

export interface TrackedWalletInfo {
  id: string;
  trackedAddress: string;
  label: string;
  autoCopy: boolean;
  maxSpendWei: string | null;
}

export interface CopyMintEvent {
  chain: ChainId;
  whaleAddress: string;
  contractAddress: string;
  txHash: string;
  calldata: string;
  value: bigint;
  telegramId: bigint;
  tracked: TrackedWalletInfo;
}

export type CopyMintCallback = (event: CopyMintEvent) => Promise<void>;

async function resolveUserId(telegramId: bigint): Promise<string> {
  const user = await prisma.user.upsert({
    where: { telegramId },
    update: {},
    create: { telegramId },
  });
  return user.id;
}

function toInfo(t: { id: string; trackedAddress: string; label: string; autoCopy: boolean; maxSpendWei: string | null }): TrackedWalletInfo {
  return { id: t.id, trackedAddress: t.trackedAddress, label: t.label, autoCopy: t.autoCopy, maxSpendWei: t.maxSpendWei };
}

export async function trackWallet(telegramId: bigint, address: string, label?: string): Promise<TrackedWalletInfo> {
  const userId = await resolveUserId(telegramId);
  const normalized = normalizeAddress(address);
  const existing = await prisma.trackedWallet.findFirst({ where: { userId, trackedAddress: normalized } });
  if (existing) return toInfo(existing);

  const created = await prisma.trackedWallet.create({
    data: { userId, trackedAddress: normalized, label: label || normalized.slice(0, 10) },
  });
  return toInfo(created);
}

export async function untrackWallet(telegramId: bigint, address: string): Promise<boolean> {
  const userId = await resolveUserId(telegramId);
  const result = await prisma.trackedWallet.deleteMany({ where: { userId, trackedAddress: normalizeAddress(address) } });
  return result.count > 0;
}

export async function listTrackedWallets(telegramId: bigint): Promise<TrackedWalletInfo[]> {
  const userId = await resolveUserId(telegramId);
  const rows = await prisma.trackedWallet.findMany({ where: { userId } });
  return rows.map(toInfo);
}

/** maxSpendEth of null/0 disables autoCopy rather than allowing an unbounded cap — see schema comment for why this differs from the gas-cap default. */
export async function setAutoCopy(telegramId: bigint, address: string, enabled: boolean, maxSpendEth: number | null): Promise<TrackedWalletInfo> {
  const userId = await resolveUserId(telegramId);
  const normalized = normalizeAddress(address);
  const existing = await prisma.trackedWallet.findFirst({ where: { userId, trackedAddress: normalized } });
  if (!existing) throw new Error("You're not tracking this wallet yet. Use /track first.");

  if (enabled && (maxSpendEth === null || maxSpendEth <= 0)) {
    throw new Error("Auto-copy requires a positive max spend in ETH. Usage: /copyon <address> <maxSpendEth>");
  }

  const maxSpendWei = enabled && maxSpendEth !== null ? BigInt(Math.round(maxSpendEth * 1e18)).toString() : existing.maxSpendWei;

  const updated = await prisma.trackedWallet.update({
    where: { id: existing.id },
    data: { autoCopy: enabled, maxSpendWei: enabled ? maxSpendWei : existing.maxSpendWei },
  });
  return toInfo(updated);
}

/**
 * In-memory index of ALL users' tracked addresses, refreshed periodically
 * rather than queried per-transaction — a DB round trip on every single
 * chain transaction would be far too slow and far too much DB load for
 * what's a simple membership check.
 */
let trackedIndex = new Map<string, Array<{ telegramId: bigint; tracked: TrackedWalletInfo }>>();
let refreshTimer: ReturnType<typeof setInterval> | null = null;
const REFRESH_INTERVAL_MS = 20_000;

async function refreshIndex(): Promise<void> {
  try {
    const rows = await prisma.trackedWallet.findMany({ include: { user: true } });
    const next = new Map<string, Array<{ telegramId: bigint; tracked: TrackedWalletInfo }>>();
    for (const row of rows as Array<{ id: string; trackedAddress: string; label: string; autoCopy: boolean; maxSpendWei: string | null; user: { telegramId: bigint } }>) {
      const key = row.trackedAddress; // already normalized at write time
      const list = next.get(key) ?? [];
      list.push({ telegramId: row.user.telegramId, tracked: toInfo(row) });
      next.set(key, list);
    }
    trackedIndex = next;
  } catch (cause) {
    console.error("[copyMint] failed to refresh tracked-address index:", cause);
  }
}

function ensureIndexRefreshing(): void {
  if (refreshTimer) return;
  refreshIndex(); // populate immediately, don't wait for the first interval tick
  refreshTimer = setInterval(refreshIndex, REFRESH_INTERVAL_MS);
}

export function createCopyMintWatcher(onEvent: CopyMintCallback): ChainWatcher {
  ensureIndexRefreshing();

  return {
    async onTransaction(tx: TxInfo, chain: ChainId) {
      if (!tx.to) return;
      const fromNormalized = normalizeAddress(tx.from);
      const trackers = trackedIndex.get(fromNormalized);
      if (!trackers || trackers.length === 0) return;

      const selector = (tx.input || "0x").slice(0, 10);
      if (!MINT_SELECTORS.has(selector)) return;

      for (const { telegramId, tracked } of trackers) {
        await onEvent({
          chain,
          whaleAddress: fromNormalized,
          contractAddress: tx.to,
          txHash: tx.hash,
          calldata: tx.input,
          value: tx.value,
          telegramId,
          tracked,
        }).catch((cause) => console.error("[copyMint] event handler error:", cause));
      }
    },
  };
}
