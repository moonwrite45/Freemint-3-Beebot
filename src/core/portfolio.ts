/**
 * Portfolio tracking.
 *
 * Deliberately does NOT treat MintAttempt.status === "sent" as "you own
 * this NFT" — "sent" only means the transaction was broadcast, not that
 * it was mined or succeeded. Trusting that alone would be the same
 * "confident but wrong" failure mode this whole rebuild exists to fix,
 * just relocated to a new feature.
 *
 * Two real checks happen before anything is shown:
 *   1. Reconcile — any attempt still at "sent" gets its real transaction
 *      receipt checked and is moved to "confirmed" or "reverted".
 *   2. Verify — for every contract with a confirmed mint, the wallet's
 *      REAL live on-chain balanceOf() is read. Our own attempt log is
 *      only ever a starting point for which contracts to check, never
 *      the final answer for what's currently held — a later transfer or
 *      sale is real, and our log has no way to know about it otherwise.
 */

import { parseAbi } from "viem";
import { getPublicClient } from "./chain.js";
import { prisma } from "../db/client.js";
import type { ChainId } from "./chains.js";

const ERC721_READ_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
]);

// Caps enumeration RPC calls so one wallet holding hundreds of tokens
// from one contract can't turn a single portfolio view into hundreds of
// sequential reads.
const MAX_TOKEN_IDS_SHOWN = 20;

async function resolveUserId(telegramId: bigint): Promise<string> {
  const user = await prisma.user.upsert({
    where: { telegramId },
    update: {},
    create: { telegramId },
  });
  return user.id;
}

/**
 * Moves any "sent" MintAttempt forward to "confirmed" or "reverted" by
 * checking its real transaction receipt. An attempt with no receipt yet
 * (still pending, or a momentary RPC hiccup) is left as "sent" and
 * retried on the next call — never guessed at either way.
 */
async function reconcilePendingAttempts(userId: string): Promise<void> {
  const pending = await prisma.mintAttempt.findMany({
    where: { userId, status: "sent", txHash: { not: null } },
  });

  for (const attempt of pending) {
    if (!attempt.txHash) continue;
    const client = getPublicClient(attempt.chain as ChainId);
    try {
      const receipt = await client.getTransactionReceipt({ hash: attempt.txHash as `0x${string}` });
      const newStatus = receipt.status === "success" ? "confirmed" : "reverted";
      await prisma.mintAttempt.update({
        where: { id: attempt.id },
        data: {
          status: newStatus,
          errorMessage: newStatus === "reverted" ? "Transaction was mined but reverted on-chain." : null,
        },
      });
    } catch {
      // No receipt yet, or the RPC hiccuped — leave as "sent", retry later.
    }
  }
}

export interface PortfolioHolding {
  walletId: string;
  walletLabel: string;
  walletAddress: string;
  chain: ChainId;
  contractAddress: string;
  /** Real, live balanceOf() result — never derived from our own attempt count. */
  balance: number;
  /** Only present when the contract implements ERC721Enumerable; otherwise omitted, never guessed. */
  tokenIds?: string[];
}

/**
 * Returns everything this user's wallets currently, verifiably hold —
 * not everything they've ever successfully minted. A confirmed mint
 * whose token was since transferred or sold correctly disappears from
 * this list, because balanceOf() is ground truth and our attempt log
 * isn't.
 */
export async function getPortfolio(telegramId: bigint): Promise<PortfolioHolding[]> {
  const userId = await resolveUserId(telegramId);
  await reconcilePendingAttempts(userId);

  const wallets = await prisma.wallet.findMany({ where: { userId } });
  if (wallets.length === 0) return [];

  const confirmedAttempts = await prisma.mintAttempt.findMany({
    where: { userId, status: "confirmed" },
    distinct: ["walletId", "contractAddress", "chain"],
  });

  const holdings: PortfolioHolding[] = [];

  for (const attempt of confirmedAttempts) {
    const wallet = wallets.find((w) => w.id === attempt.walletId);
    if (!wallet) continue; // wallet was deleted since this attempt was recorded — nothing to check

    const client = getPublicClient(attempt.chain as ChainId);

    let balance: bigint;
    try {
      balance = (await client.readContract({
        address: attempt.contractAddress as `0x${string}`,
        abi: ERC721_READ_ABI,
        functionName: "balanceOf",
        args: [wallet.address as `0x${string}`],
      })) as bigint;
    } catch (cause) {
      // Non-ERC721 contract, or the RPC failed — skip rather than show a
      // guessed or stale entry. A silent gap here is safer than a wrong number.
      console.error(`[portfolio] balanceOf failed for ${attempt.contractAddress} on ${attempt.chain}:`, cause);
      continue;
    }

    if (balance === 0n) continue; // minted at some point, no longer held — live balance wins over history

    let tokenIds: string[] | undefined;
    try {
      const count = balance < BigInt(MAX_TOKEN_IDS_SHOWN) ? Number(balance) : MAX_TOKEN_IDS_SHOWN;
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const id = (await client.readContract({
          address: attempt.contractAddress as `0x${string}`,
          abi: ERC721_READ_ABI,
          functionName: "tokenOfOwnerByIndex",
          args: [wallet.address as `0x${string}`, BigInt(i)],
        })) as bigint;
        ids.push(id.toString());
      }
      tokenIds = ids;
    } catch {
      // Contract doesn't implement ERC721Enumerable — very common. Show
      // the balance count only; never fabricate token IDs.
      tokenIds = undefined;
    }

    holdings.push({
      walletId: wallet.id,
      walletLabel: wallet.label,
      walletAddress: wallet.address,
      chain: attempt.chain as ChainId,
      contractAddress: attempt.contractAddress,
      balance: Number(balance),
      tokenIds,
    });
  }

  return holdings;
}
