import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Phase 11.5B: encrypts/decrypts integration secrets (Tavily/DeepSeek API
// keys) at rest. AES-256-GCM via Node's built-in crypto only -- no new
// dependency, matching services/password.ts's existing house style (that
// module uses scryptSync for one-way password hashing; this one needs a
// reversible cipher instead, since the plaintext secret must be usable
// again for real provider calls).
//
// INTEGRATION_ENCRYPTION_KEY format -- the one explicit format this app
// supports, nothing else: exactly 64 hex characters (32 bytes / 256 bits),
// e.g. the output of `openssl rand -hex 32`. Missing or malformed always
// throws (fail closed) -- this never silently falls back to storing an
// unencrypted secret, and error messages never include the key, the
// plaintext, the ciphertext, or the IV/auth tag, only what's wrong with
// the key's *format*.
const ALGORITHM = "aes-256-gcm";
const KEY_BYTE_LENGTH = 32;
const KEY_HEX_LENGTH = KEY_BYTE_LENGTH * 2;
const IV_BYTE_LENGTH = 12; // GCM-recommended 96-bit IV
const CURRENT_KEY_VERSION = 1;

export class EncryptionKeyMissingError extends Error {
  constructor() {
    super("INTEGRATION_ENCRYPTION_KEY is not set.");
    this.name = "EncryptionKeyMissingError";
  }
}

export class EncryptionKeyMalformedError extends Error {
  constructor() {
    super(`INTEGRATION_ENCRYPTION_KEY must be exactly ${KEY_HEX_LENGTH} hex characters (32 bytes).`);
    this.name = "EncryptionKeyMalformedError";
  }
}

export class SecretDecryptionError extends Error {
  constructor() {
    super("Stored secret could not be decrypted.");
    this.name = "SecretDecryptionError";
  }
}

function loadEncryptionKey(): Buffer {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!raw) throw new EncryptionKeyMissingError();
  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) throw new EncryptionKeyMalformedError();
  const key = Buffer.from(trimmed, "hex");
  if (key.length !== KEY_BYTE_LENGTH) throw new EncryptionKeyMalformedError(); // defensive; the regex above already guarantees this
  return key;
}

export interface EncryptedSecret {
  /** Packed as ivBase64:authTagBase64:ciphertextBase64. Store verbatim; never decode/inspect outside this module. */
  ciphertext: string;
  /** Last 4 characters of the plaintext -- masking Settings never needs to decrypt. */
  last4: string;
  keyVersion: number;
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  if (!plaintext || plaintext.trim().length === 0) {
    throw new Error("Cannot encrypt an empty secret.");
  }
  const key = loadEncryptionKey();
  const iv = randomBytes(IV_BYTE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
  return { ciphertext, last4: plaintext.slice(-4), keyVersion: CURRENT_KEY_VERSION };
}

export function decryptSecret(ciphertext: string, keyVersion: number): string {
  if (keyVersion !== CURRENT_KEY_VERSION) {
    throw new SecretDecryptionError();
  }
  const key = loadEncryptionKey();
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new SecretDecryptionError();
  const [ivB64, authTagB64, dataB64] = parts as [string, string, string];
  let iv: Buffer, authTag: Buffer, data: Buffer;
  try {
    iv = Buffer.from(ivB64, "base64");
    authTag = Buffer.from(authTagB64, "base64");
    data = Buffer.from(dataB64, "base64");
  } catch {
    throw new SecretDecryptionError();
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    // GCM auth-tag mismatch, wrong key, or corrupted data all land here --
    // never surface the underlying crypto library error (it can include
    // buffer contents in some Node versions' stack traces).
    throw new SecretDecryptionError();
  }
}
