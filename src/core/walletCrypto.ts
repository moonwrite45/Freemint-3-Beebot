import crypto from "crypto";

/**
 * Ported from the old bot's crypto.ts — the algorithm choice itself was
 * already correct (AES-256-GCM, proper 12-byte GCM IV, proper auth tag
 * handling) so it's kept as-is. What was NOT fine was how callers used
 * this: wallet.ts looked wallets up by id alone with no check that the
 * requesting user actually owned that wallet. That's fixed in wallet.ts,
 * not here — this module only ever sees a plaintext/ciphertext string,
 * it has no concept of "whose" key it is.
 *
 * Residual risk worth knowing about, not solved by this file: a single
 * master ENCRYPTION_KEY env var decrypts every user's wallet. That's a
 * standard tradeoff for a self-hosted bot without a real KMS, but it
 * means the env var itself is the single most sensitive secret in this
 * whole deployment — treat it accordingly (Railway's env var storage,
 * never logged, never committed, rotated if you ever suspect exposure).
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY is not set. Provide a 32-byte hex key (64 hex chars).");
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must be 32 bytes (64 hex chars), got ${key.length} bytes.`);
  }
  return key;
}

/** Returns a fresh random 32-byte hex key — run this once to generate ENCRYPTION_KEY, never log the result anywhere persistent. */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString("hex");
}

export function decrypt(payload: string): string {
  const key = getKey();
  const data = Buffer.from(payload, "hex");
  if (data.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Invalid encrypted payload: too short.");
  }
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(data.length - TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH, data.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}
