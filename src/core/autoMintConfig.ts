import { prisma } from "../db/client.js";
import { getWalletByIdForUser } from "./wallet.js";

export interface AutoMintSettings {
  walletId: string;
  enabled: boolean;
  maxGasGwei: number | null;
}

async function resolveUserId(telegramId: bigint): Promise<string> {
  const user = await prisma.user.upsert({
    where: { telegramId },
    update: {},
    create: { telegramId },
  });
  return user.id;
}

export async function getAutoMintConfig(telegramId: bigint): Promise<AutoMintSettings | null> {
  const userId = await resolveUserId(telegramId);
  const cfg = await prisma.autoMintConfig.findUnique({ where: { userId } });
  if (!cfg) return null;
  return { walletId: cfg.walletId, enabled: cfg.enabled, maxGasGwei: cfg.maxGasGwei ?? null };
}

/** Enabling requires a wallet the user actually owns — verified here, not assumed from the caller. */
export async function enableAutoMint(telegramId: bigint, walletId: string, maxGasGwei: number | null): Promise<AutoMintSettings> {
  const userId = await resolveUserId(telegramId);
  const wallet = await getWalletByIdForUser(telegramId, walletId);
  if (!wallet) throw new Error("Wallet not found or not owned by you.");

  const cfg = await prisma.autoMintConfig.upsert({
    where: { userId },
    update: { walletId, enabled: true, maxGasGwei },
    create: { userId, walletId, enabled: true, maxGasGwei },
  });
  return { walletId: cfg.walletId, enabled: cfg.enabled, maxGasGwei: cfg.maxGasGwei ?? null };
}

export async function disableAutoMint(telegramId: bigint): Promise<void> {
  const userId = await resolveUserId(telegramId);
  await prisma.autoMintConfig.updateMany({ where: { userId }, data: { enabled: false } });
}

/** Every enabled config paired with its owning user's telegramId — used by the discovery pipeline to fan out auto-mint attempts. */
export async function getEnabledAutoMintConfigs(): Promise<Array<AutoMintSettings & { telegramId: bigint }>> {
  const configs = await prisma.autoMintConfig.findMany({
    where: { enabled: true },
    include: { user: true },
  });
  return configs.map((c) => ({
    telegramId: c.user.telegramId,
    walletId: c.walletId,
    enabled: c.enabled,
    maxGasGwei: c.maxGasGwei ?? null,
  }));
}
