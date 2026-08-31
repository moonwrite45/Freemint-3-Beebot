import { randomBytes } from "crypto";
import type { Hex } from "viem";
import { prisma } from "../db/client.js";
import { encrypt, decrypt } from "./walletCrypto.js";
import { getAddressFromPrivateKey, isValidPrivateKey, normalizePrivateKey, normalizeAddress } from "./chain.js";

/**
 * Every function here takes a telegramId AND resolves/verifies the
 * caller's internal userId before touching a Wallet row — and every
 * Wallet query filters by that userId, not just the wallet's own id.
 * This is the fix for the old bot's bug: getWalletPrivateKey(walletId)
 * and deleteWallet(walletId) used to trust the id alone, which meant a
 * leaked or guessed wallet id (cuid, not trivially guessable, but IDs
 * do end up in logs/callback payloads) could expose or delete another
 * user's wallet. Ownership is now enforced at the query itself, not
 * just assumed from "well the UI only shows you your own wallets."
 */

export interface WalletInfo {
  id: string;
  address: string;
  label: string;
  isActive: boolean;
}

async function resolveUserId(telegramId: bigint): Promise<string> {
  const user = await prisma.user.upsert({
    where: { telegramId },
    update: {},
    create: { telegramId },
  });
  return user.id;
}

function toInfo(w: { id: string; address: string; label: string; isActive: boolean }): WalletInfo {
  return { id: w.id, address: w.address, label: w.label, isActive: w.isActive };
}

export async function generateNewWallet(telegramId: bigint, label?: string): Promise<WalletInfo> {
  const userId = await resolveUserId(telegramId);
  const privateKey = `0x${randomBytes(32).toString("hex")}` as Hex;
  const address = normalizeAddress(getAddressFromPrivateKey(privateKey));
  const encrypted = encrypt(privateKey);
  const count = await prisma.wallet.count({ where: { userId } });

  const wallet = await prisma.wallet.create({
    data: {
      userId,
      address,
      encryptedPrivateKey: encrypted,
      label: label || `W${count + 1}`,
      isActive: true,
    },
  });

  return toInfo(wallet);
}

export async function importWallet(telegramId: bigint, privateKeyInput: string, label?: string): Promise<WalletInfo> {
  const userId = await resolveUserId(telegramId);

  if (!isValidPrivateKey(privateKeyInput)) {
    throw new Error("Invalid private key format. Expected 64 hex characters (with or without 0x prefix).");
  }

  const normalizedKey = normalizePrivateKey(privateKeyInput);
  const address = normalizeAddress(getAddressFromPrivateKey(normalizedKey));

  const existing = await prisma.wallet.findFirst({ where: { userId, address } });
  if (existing) throw new Error("This wallet is already imported.");

  const encrypted = encrypt(normalizedKey);
  const count = await prisma.wallet.count({ where: { userId } });

  const wallet = await prisma.wallet.create({
    data: {
      userId,
      address,
      encryptedPrivateKey: encrypted,
      label: label || `W${count + 1}`,
      isActive: true,
    },
  });

  return toInfo(wallet);
}

export async function getWallets(telegramId: bigint): Promise<WalletInfo[]> {
  const userId = await resolveUserId(telegramId);
  const wallets = await prisma.wallet.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  return wallets.map(toInfo);
}

export async function getActiveWallets(telegramId: bigint): Promise<WalletInfo[]> {
  const userId = await resolveUserId(telegramId);
  const wallets = await prisma.wallet.findMany({ where: { userId, isActive: true }, orderBy: { createdAt: "asc" } });
  return wallets.map(toInfo);
}

/** Ownership enforced: the update only matches a row that is BOTH this id AND owned by this user. */
export async function toggleWallet(telegramId: bigint, walletId: string): Promise<WalletInfo | null> {
  const userId = await resolveUserId(telegramId);
  const wallet = await prisma.wallet.findFirst({ where: { id: walletId, userId } });
  if (!wallet) return null; // not found OR not owned by this user — same response either way, no leak of existence
  const updated = await prisma.wallet.update({
    where: { id: wallet.id },
    data: { isActive: !wallet.isActive },
  });
  return toInfo(updated);
}

export async function deleteWallet(telegramId: bigint, walletId: string): Promise<boolean> {
  const userId = await resolveUserId(telegramId);
  const result = await prisma.wallet.deleteMany({ where: { id: walletId, userId } });
  return result.count > 0;
}

/** Ownership enforced before decryption — this is the highest-stakes read in the whole bot. */
export async function getWalletPrivateKey(telegramId: bigint, walletId: string): Promise<string> {
  const userId = await resolveUserId(telegramId);
  const wallet = await prisma.wallet.findFirst({ where: { id: walletId, userId } });
  if (!wallet) throw new Error("Wallet not found.");
  return decrypt(wallet.encryptedPrivateKey);
}

/** Ownership enforced — used internally by auto-mint/copy-mint, never exposes the key itself to the caller's caller without going through here. */
export async function getWalletByIdForUser(telegramId: bigint, walletId: string): Promise<WalletInfo | null> {
  const userId = await resolveUserId(telegramId);
  const wallet = await prisma.wallet.findFirst({ where: { id: walletId, userId } });
  return wallet ? toInfo(wallet) : null;
}
