/**
 * User watchlists — contracts someone wants to keep an eye on without
 * subscribing to a whole chain's alert stream. The UI for this (👁
 * buttons in keyboards.ts) existed since Phase 2, but nothing implemented
 * it — this module plus the handlers.ts wiring closes that gap.
 */

import { prisma } from "../db/client.js";
import type { ChainId } from "./chains.js";

async function resolveUserId(telegramId: bigint): Promise<string> {
  const user = await prisma.user.upsert({
    where: { telegramId },
    update: {},
    create: { telegramId },
  });
  return user.id;
}

export interface WatchlistItem {
  contractAddress: string;
  chain: ChainId;
}

export async function addToWatchlist(telegramId: bigint, contractAddress: string, chain: ChainId): Promise<void> {
  const userId = await resolveUserId(telegramId);
  await prisma.watchlistEntry.upsert({
    where: { userId_contractAddress_chain: { userId, contractAddress, chain } },
    update: {},
    create: { userId, contractAddress, chain },
  });
}

export async function removeFromWatchlist(telegramId: bigint, contractAddress: string, chain: ChainId): Promise<boolean> {
  const userId = await resolveUserId(telegramId);
  const result = await prisma.watchlistEntry.deleteMany({ where: { userId, contractAddress, chain } });
  return result.count > 0;
}

export async function getWatchlist(telegramId: bigint): Promise<WatchlistItem[]> {
  const userId = await resolveUserId(telegramId);
  const rows = await prisma.watchlistEntry.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  return rows.map((r) => ({ contractAddress: r.contractAddress, chain: r.chain as ChainId }));
}
