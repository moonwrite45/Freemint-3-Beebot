/**
 * Executes real mint transactions. This is the highest-stakes code in
 * the whole bot — it decrypts a private key and spends real gas. Every
 * safety measure elsewhere in this codebase converges here:
 *   - wallet.ts's ownership check (can't touch a wallet you don't own)
 *   - gasGuard.ts's live price check (never send blind into a gas spike)
 *   - scanner.ts's buildCandidateArgs (same args already proven via
 *     dry-run, not a second hand-written copy) — for executeMint only
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
  contractAddress: string,
  chain: ChainId,
  trigger: "manual" | "auto" | "copy",
  outcome: { status: "sent"; txHash: string } | { status: "failed"; errorMessage: string }
): Promise<void> {
  const userId = await resolveUserId(telegramId);
  await prisma.mintAttempt
    .create({
      data: {
        userId,
        walletId,
        contractAddress,
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
    await recordAttempt(telegramId, walletId, scan.contractAddress, chain, trigger, {
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
    await recordAttempt(telegramId, walletId, scan.contractAddress, chain, trigger, { status: "failed", errorMessage: message });
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

    await recordAttempt(telegramId, walletId, scan.contractAddress, chain, trigger, { status: "sent", txHash });
    return ok({ txHash });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await recordAttempt(telegramId, walletId, scan.contractAddress, chain, trigger, { status: "failed", errorMessage: message });
    return err("unknown", `Mint transaction failed: ${message}`, cause);
  }
}

/**
 * Copy-mint execution — replays a tracked whale's exact calldata and
 * value (up to the user's configured spend cap) via their designated
 * auto-mint wallet. Deliberately does NOT re-derive or decode the
 * whale's transaction into a reconstructed function call the way
 * scanner.ts does for free-mint detection — it just resends the literal
 * bytes the whale sent, to the same contract, which is a more faithful
 * "copy" than trying to re-encode arguments (and sidesteps any bugs in
 * that re-encoding entirely).
 */
export async function executeCopyMint(
  telegramId: bigint,
  chain: ChainId,
  contractAddress: string,
  calldata: string,
  value: bigint,
  maxSpendWei: bigint,
  maxGasGwei: number | null,
  walletId: string
): Promise<Result<MintExecutionResult>> {
  if (value > maxSpendWei) {
    return err(
      "unknown",
      `Whale's mint costs ${value.toString()} wei, which exceeds your configured max spend ` +
        `(${maxSpendWei.toString()} wei). Copy skipped.`
    );
  }

  const wallet = await getWalletByIdForUser(telegramId, walletId);
  if (!wallet) return err("unknown", "Auto-mint wallet not found or not owned by you.");
  if (!wallet.isActive) return err("unknown", "Your auto-mint wallet is deactivated.");

  const client = getPublicClient(chain);
  const gasCheck = await checkGasPrice(client, maxGasGwei);
  if (!gasCheck.ok) {
    await recordAttempt(telegramId, walletId, contractAddress, chain, "copy", { status: "failed", errorMessage: gasCheck.error.message });
    return gasCheck;
  }

  let privateKey: string;
  try {
    privateKey = await getWalletPrivateKey(telegramId, walletId);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Could not access wallet key.";
    await recordAttempt(telegramId, walletId, contractAddress, chain, "copy", { status: "failed", errorMessage: message });
    return err("unknown", message, cause);
  }

  const walletClient = getWalletClient(privateKey as Hex, chain);
  const account = walletClient.account;
  if (!account) return err("unknown", "Wallet client has no account attached — this should never happen.");

  try {
    const txHash = await walletClient.sendTransaction({
      account,
      to: contractAddress as Hex,
      data: calldata as Hex,
      value,
      chain: walletClient.chain,
    });

    await recordAttempt(telegramId, walletId, contractAddress, chain, "copy", { status: "sent", txHash });
    return ok({ txHash });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await recordAttempt(telegramId, walletId, contractAddress, chain, "copy", { status: "failed", errorMessage: message });
    return err("unknown", `Copy-mint transaction failed: ${message}`, cause);
  }
}
