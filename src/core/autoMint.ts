/**
 * Executes a real mint transaction. This is the highest-stakes piece of
 * code in the whole bot — it decrypts a private key and spends real gas.
 * Every safety measure that exists elsewhere in this codebase converges
 * here:
 *   - wallet.ts's ownership check (can't touch a wallet you don't own)
 *   - gasGuard.ts's live price check (never send blind into a gas spike)
 *   - scanner.ts's buildCandidateArgs (same args already proven via
 *     dry-run, not a second hand-written copy)
 *   - every outcome recorded to MintAttempt, success or failure, so
 *     nothing silently disappears the way the old bot's failures did
 */

import { parseAbi, encodeFunctionData, type Hex } from "viem";
import { getPublicClient, getWalletClient } from "./chain.js";
import { getWalletPrivateKey, getWalletByIdForUser } from "./wallet.js";
import { checkGasPrice } from "./gasGuard.js";
import { buildCandidateArgs, type ScanResult } from "./scanner.js";
import { prisma } from "../db/client.js";
import { err, ok, type Result } from "./errors.js";
import type { ChainId } from "./chains.js";

export interface MintExecutionResult {
  txHash: string;
}

async function resolveUserId(telegramId: bigint): Promise<string> {
  const user = await prisma.user.upsert({
    where: { telegramId },
    update: {},
    create: { telegramId },
  });
  return user.id;
}

async function recordAttempt(
  telegramId: bigint,
  walletId: string,
  scan: ScanResult,
  chain: ChainId,
  trigger: "manual" | "auto",
  outcome: { status: "sent"; txHash: string } | { status: "failed"; errorMessage: string }
): Promise<void> {
  const userId = await resolveUserId(telegramId);
  await prisma.mintAttempt
    .create({
      data: {
        userId,
        walletId,
        contractAddress: scan.contractAddress,
        chain,
        trigger,
        status: outcome.status,
        txHash: outcome.status === "sent" ? outcome.txHash : null,
        errorMessage: outcome.status === "failed" ? outcome.errorMessage : null,
      },
    })
    .catch((cause) => console.error("[autoMint] failed to record MintAttempt:", cause));
}

/**
 * Executes a verified free mint for a specific user's wallet. Ownership
 * of the wallet is checked (via getWalletPrivateKey) before anything
 * else runs — the same discipline as every other wallet.ts caller.
 */
export async function executeMint(
  telegramId: bigint,
  walletId: string,
  scan: ScanResult,
  chain: ChainId,
  trigger: "manual" | "auto",
  maxGasGwei: number | null
): Promise<Result<MintExecutionResult>> {
  if (!scan.freeMint) {
    return err("no_free_mint_function", "This scan result has no verified free mint to execute.");
  }

  const wallet = await getWalletByIdForUser(telegramId, walletId);
  if (!wallet) {
    return err("unknown", "Wallet not found or not owned by you.");
  }
  if (!wallet.isActive) {
    return err("unknown", "This wallet is deactivated — activate it before minting.");
  }

  const client = getPublicClient(chain);

  const gasCheck = await checkGasPrice(client, maxGasGwei);
  if (!gasCheck.ok) {
    await recordAttempt(telegramId, walletId, scan, chain, trigger, {
      status: "failed",
      errorMessage: gasCheck.error.message,
    });
    return gasCheck;
  }

  let privateKey: string;
  try {
    privateKey = await getWalletPrivateKey(telegramId, walletId);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Could not access wallet key.";
    await recordAttempt(telegramId, walletId, scan, chain, trigger, { status: "failed", errorMessage: message });
    return err("unknown", message, cause);
  }

  const candidate = scan.freeMint.candidate;
  const walletClient = getWalletClient(privateKey as Hex, chain);
  const account = walletClient.account;
  if (!account) {
    return err("unknown", "Wallet client has no account attached — this should never happen.");
  }

  try {
    const abiItem = parseAbi([`function ${candidate.name}(${candidate.args.join(",")})`] as const);
    const args = buildCandidateArgs(candidate, account.address);
    const data = encodeFunctionData({ abi: abiItem, functionName: candidate.name, args: args as any });

    const txHash = await walletClient.sendTransaction({
      account,
      to: scan.contractAddress as Hex,
      data,
      value: 0n,
      chain: walletClient.chain,
    });

    await recordAttempt(telegramId, walletId, scan, chain, trigger, { status: "sent", txHash });
    return ok({ txHash });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await recordAttempt(telegramId, walletId, scan, chain, trigger, { status: "failed", errorMessage: message });
    return err("unknown", `Mint transaction failed: ${message}`, cause);
  }
}
