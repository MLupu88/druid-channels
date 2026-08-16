// Phase 11.5B: pure unit tests for services/encryption.ts -- no DB, no
// network. Sets/restores INTEGRATION_ENCRYPTION_KEY directly on
// process.env per test so each case controls its own key state.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  encryptSecret,
  decryptSecret,
  EncryptionKeyMissingError,
  EncryptionKeyMalformedError,
  SecretDecryptionError,
} from "../src/services/encryption";

const VALID_KEY = "a".repeat(64); // 64 hex chars = 32 bytes
const OTHER_VALID_KEY = "b".repeat(64);
const originalKey = process.env.INTEGRATION_ENCRYPTION_KEY;

after(() => {
  if (originalKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
  else process.env.INTEGRATION_ENCRYPTION_KEY = originalKey;
});

test("encrypt then decrypt round-trips the exact plaintext", () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = VALID_KEY;
  const secret = encryptSecret("tvly-abc123XYZ");
  assert.equal(decryptSecret(secret.ciphertext, secret.keyVersion), "tvly-abc123XYZ");
});

test("last4 is exactly the last 4 characters of the plaintext, nothing more", () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = VALID_KEY;
  const secret = encryptSecret("sk-deepseek-9f8e7d6c5b4a");
  assert.equal(secret.last4, "5b4a");
});

test("ciphertext never contains the plaintext as a substring", () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = VALID_KEY;
  const plaintext = "super-secret-tavily-key-value";
  const secret = encryptSecret(plaintext);
  assert.equal(secret.ciphertext.includes(plaintext), false);
});

test("missing key throws EncryptionKeyMissingError on encrypt and decrypt", () => {
  delete process.env.INTEGRATION_ENCRYPTION_KEY;
  assert.throws(() => encryptSecret("anything"), EncryptionKeyMissingError);
  assert.throws(() => decryptSecret("iv:tag:data", 1), EncryptionKeyMissingError);
});

test("malformed key (wrong length) throws EncryptionKeyMalformedError, fails closed rather than degrading", () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = "tooshort";
  assert.throws(() => encryptSecret("anything"), EncryptionKeyMalformedError);
});

test("malformed key (non-hex characters) throws EncryptionKeyMalformedError", () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = "z".repeat(64); // right length, not valid hex
  assert.throws(() => encryptSecret("anything"), EncryptionKeyMalformedError);
});

test("decrypting with the wrong key fails closed with SecretDecryptionError, never returns wrong/garbage plaintext", () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = VALID_KEY;
  const secret = encryptSecret("original-secret-value");

  process.env.INTEGRATION_ENCRYPTION_KEY = OTHER_VALID_KEY;
  assert.throws(() => decryptSecret(secret.ciphertext, secret.keyVersion), SecretDecryptionError);
});

test("decrypting a tampered ciphertext fails closed (GCM auth tag catches it)", () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = VALID_KEY;
  const secret = encryptSecret("original-secret-value");
  const [iv, tag, data] = secret.ciphertext.split(":");
  const tamperedData = Buffer.from(data!, "base64");
  tamperedData[0] = tamperedData[0]! ^ 0xff; // flip a bit
  const tampered = [iv, tag, tamperedData.toString("base64")].join(":");
  assert.throws(() => decryptSecret(tampered, secret.keyVersion), SecretDecryptionError);
});

test("decrypting an unsupported key version fails closed without attempting decryption", () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = VALID_KEY;
  const secret = encryptSecret("value");
  assert.throws(() => decryptSecret(secret.ciphertext, 999), SecretDecryptionError);
});

test("encrypting the same plaintext twice produces different ciphertexts (random IV per call)", () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = VALID_KEY;
  const a = encryptSecret("same-value");
  const b = encryptSecret("same-value");
  assert.notEqual(a.ciphertext, b.ciphertext);
  // ...but both still decrypt to the same plaintext.
  assert.equal(decryptSecret(a.ciphertext, a.keyVersion), "same-value");
  assert.equal(decryptSecret(b.ciphertext, b.keyVersion), "same-value");
});

test("cannot encrypt an empty secret", () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = VALID_KEY;
  assert.throws(() => encryptSecret(""));
  assert.throws(() => encryptSecret("   "));
});
