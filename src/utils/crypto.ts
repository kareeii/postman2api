import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config";

const VERSION_AES_GCM = 0x01;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const DEFAULT_ENCRYPTION_KEY = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

function deriveKey(): Buffer {
  return createHash("sha256").update(config.encryptionKey, "utf8").digest();
}

function getLegacyKeyBytes(): Uint8Array {
  return new TextEncoder().encode(config.encryptionKey);
}

function legacyXorDecrypt(data: Uint8Array): string {
  const key = getLegacyKeyBytes();
  if (key.length === 0) throw new Error("Encryption key must not be empty");
  const decrypted = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    decrypted[i] = data[i]! ^ key[i % key.length]!;
  }
  return new TextDecoder().decode(decrypted);
}

export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([Buffer.from([VERSION_AES_GCM]), iv, ciphertext, authTag]);
  return payload.toString("base64");
}

export function decrypt(ciphertext: string): string {
  const data = Buffer.from(ciphertext, "base64");
  if (data.length > 0 && data[0] === VERSION_AES_GCM) {
    const minLength = 1 + IV_LENGTH + AUTH_TAG_LENGTH;
    if (data.length < minLength) throw new Error("Ciphertext too short for AES-GCM payload");
    const iv = data.subarray(1, 1 + IV_LENGTH);
    const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
    const encrypted = data.subarray(1 + IV_LENGTH, data.length - AUTH_TAG_LENGTH);
    const key = deriveKey();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return plaintext.toString("utf8");
  }
  return legacyXorDecrypt(new Uint8Array(data));
}

export function isDefaultEncryptionKey(): boolean {
  return config.encryptionKey === DEFAULT_ENCRYPTION_KEY;
}
