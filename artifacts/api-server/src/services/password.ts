import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Password hashing via Node's built-in scrypt (no external dependency, no
// external auth service — keeps this portable to a plain Ubuntu/Docker/
// Postgres deployment later). Format: "scrypt:<saltHex>:<hashHex>".
const KEY_LENGTH = 64;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEY_LENGTH);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, saltHex, hashHex] = parts;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(plain, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Server-generated temporary password used only for resetting a PAM's
// access (account creation instead takes its initial password from
// CreateUserInput.password). 18 random bytes -> 24-char base64url string
// (144 bits of entropy), well above the 16-char minimum enforced on
// CreateUserInput.password. Caller is responsible for showing this to the
// admin exactly once and never logging it -- this module only ever returns
// the plaintext, it does not persist it.
export function generateTemporaryPassword(): string {
  return randomBytes(18).toString("base64url");
}
