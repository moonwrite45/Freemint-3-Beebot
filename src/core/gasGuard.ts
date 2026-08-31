/**
 * A hard stop between "we verified this mint is free" and "we actually
 * spent the user's ETH on gas." Free mint != free transaction — gas is
 * always real money, and a spike (or a malicious contract with an
 * expensive fallback) could cost far more than the user expects. This
 * check runs immediately before every send, using a live gas price read,
 * never a cached/stale one.
 */

import { formatGwei, type PublicClient } from "viem";
import { err, ok, type Result } from "./errors.js";

export async function checkGasPrice(
  client: PublicClient,
  maxGasGwei: number | null | undefined
): Promise<Result<{ currentGwei: number }>> {
  let gasPriceWei: bigint;
  try {
    gasPriceWei = await client.getGasPrice();
  } catch (cause) {
    return err("rpc_error", "Could not read current gas price — refusing to send blind.", cause);
  }

  const currentGwei = Number(formatGwei(gasPriceWei));

  if (maxGasGwei != null && currentGwei > maxGasGwei) {
    return err(
      "unknown",
      `Current gas price (${currentGwei.toFixed(2)} gwei) exceeds your configured max ` +
        `(${maxGasGwei} gwei). Mint skipped — raise your limit with /setgaslimit if this was too conservative.`
    );
  }

  return ok({ currentGwei });
}
