import { prisma } from "../db/client.js";
import type { ChainId } from "./chains.js";

export async function ensureUser(telegramId: bigint): Promise<void> {
  await prisma.user.upsert({
    where: { telegramId },
    update: {},
    create: { telegramId },
  });
}

export async function subscribeToChain(telegramId: bigint, chain: ChainId): Promise<void> {
  const user = await prisma.user.upsert({
    where: { telegramId },
    update: {},
    create: { telegramId },
  });
  await prisma.chainSubscription.upsert({
    where: { userId_chain: { userId: user.id, chain } },
    update: {},
    create: { userId: user.id, chain },
  });
}

export async function unsubscribeFromChain(telegramId: bigint, chain: ChainId): Promise<void> {
  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) return;
  await prisma.chainSubscription.deleteMany({ where: { userId: user.id, chain } });
}

export async function getSubscribedChains(telegramId: bigint): Promise<ChainId[]> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    include: { chainSubscriptions: true },
  });
  if (!user) return [];
  return user.chainSubscriptions.map((s) => s.chain as ChainId);
}

/** Returns every Telegram user id currently subscribed to alerts on this chain. */
export async function getSubscribersForChain(chain: ChainId): Promise<bigint[]> {
  const subs = await prisma.chainSubscription.findMany({
    where: { chain },
    include: { user: true },
  });
  return subs.map((s) => s.user.telegramId);
}
