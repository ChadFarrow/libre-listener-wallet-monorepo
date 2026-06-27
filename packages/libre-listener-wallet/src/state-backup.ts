import { hexToBytes } from "./storage-cache";

export interface BackupPayload {
  version: 1;
  network: string;
  exportedAt: number;
  entries: Record<string, string>; // storageKey -> hex value
}

// --- v2 envelope (current) -------------------------------------------------
// Envelope encryption: a random data-encryption-key (DEK) encrypts the payload
// once; the DEK is wrapped to BOTH a passphrase (PBKDF2) and the seed (HKDF), so
// EITHER secret can recover the backup. This decouples "can I decrypt the backup"
// from "do I still have the exact seed", removing the original catch-22.
interface RecipientV2 {
  type: "passphrase" | "seed";
  kdf: "PBKDF2-SHA256" | "HKDF-SHA256";
  iter?: number; // passphrase only
  salt?: string; // passphrase only (base64)
  info?: string; // seed only
  iv: string; // base64, IV for the DEK wrap
  wrap: string; // base64, AES-GCM(DEK) under the KEK
}
interface BackupEnvelopeV2 {
  v: 2;
  alg: "AES-256-GCM";
  iv: string; // base64, payload IV
  ct: string; // base64, payload ciphertext
  recipients: RecipientV2[];
}

// --- v1 envelope (legacy, read-only + tests) -------------------------------
interface BackupEnvelopeV1 {
  v: 1;
  alg: "AES-256-GCM";
  kdf: "HKDF-SHA256";
  iv: string; // base64
  ct: string; // base64
}

const HKDF_INFO_V1 = new TextEncoder().encode("libre-wallet-backup-v1");
const SEED_KEK_INFO = "libre-wallet-backup-kek-v2";
const PBKDF2_ITER = 600000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function deriveKekFromPassphrase(passphrase: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function deriveKekFromSeed(seedHex: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", hexToBytes(seedHex), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(SEED_KEK_INFO) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function importDek(dek: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", dek, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function wrapDek(kek: CryptoKey, dek: Uint8Array): Promise<{ iv: string; wrap: string }> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, dek);
  return { iv: bytesToBase64(iv), wrap: bytesToBase64(new Uint8Array(ct)) };
}

async function unwrapDek(kek: CryptoKey, ivB64: string, wrapB64: string): Promise<Uint8Array> {
  const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(ivB64) }, kek, base64ToBytes(wrapB64));
  return new Uint8Array(out);
}

/**
 * Encrypt a backup payload (v2). The result can be decrypted with EITHER the
 * passphrase OR the seed.
 */
export async function serializeAndEncrypt(
  payload: BackupPayload,
  secrets: { passphrase: string; seedHex: string }
): Promise<string> {
  const dek = randomBytes(32);
  const dekKey = await importDek(dek);
  const iv = randomBytes(12);
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    dekKey,
    new TextEncoder().encode(JSON.stringify(payload))
  );

  const salt = randomBytes(16);
  const passKek = await deriveKekFromPassphrase(secrets.passphrase, salt, PBKDF2_ITER);
  const passWrap = await wrapDek(passKek, dek);
  const seedKek = await deriveKekFromSeed(secrets.seedHex);
  const seedWrap = await wrapDek(seedKek, dek);

  const envelope: BackupEnvelopeV2 = {
    v: 2,
    alg: "AES-256-GCM",
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ctBuf)),
    recipients: [
      { type: "passphrase", kdf: "PBKDF2-SHA256", iter: PBKDF2_ITER, salt: bytesToBase64(salt), iv: passWrap.iv, wrap: passWrap.wrap },
      { type: "seed", kdf: "HKDF-SHA256", info: SEED_KEK_INFO, iv: seedWrap.iv, wrap: seedWrap.wrap },
    ],
  };
  return JSON.stringify(envelope);
}

/** Decrypt a backup, auto-detecting v2 (passphrase or seed) or legacy v1 (seed). */
export async function decryptAndParse(envelopeStr: string, secret: string): Promise<BackupPayload> {
  let env: { v?: number };
  try {
    env = JSON.parse(envelopeStr);
  } catch {
    throw new Error("Invalid backup: not valid JSON");
  }
  if (env.v === 2) return decryptV2(env as BackupEnvelopeV2, secret);
  if (env.v === 1) return decryptV1(env as BackupEnvelopeV1, secret);
  throw new Error(`Unsupported backup version: ${env.v}`);
}

async function decryptV2(env: BackupEnvelopeV2, secret: string): Promise<BackupPayload> {
  const isHex = /^[0-9a-fA-F]{64}$/.test(secret);
  const order: Array<"seed" | "passphrase"> = isHex ? ["seed", "passphrase"] : ["passphrase", "seed"];
  let dek: Uint8Array | null = null;
  for (const t of order) {
    const r = env.recipients?.find((x) => x.type === t);
    if (!r) continue;
    try {
      const kek =
        t === "passphrase"
          ? await deriveKekFromPassphrase(secret, base64ToBytes(r.salt as string), r.iter as number)
          : await deriveKekFromSeed(secret);
      dek = await unwrapDek(kek, r.iv, r.wrap);
      break;
    } catch {
      /* wrong secret for this recipient — try the next */
    }
  }
  if (!dek) throw new Error("Decryption failed — wrong secret or corrupt backup");
  const dekKey = await importDek(dek);
  let ptBuf: ArrayBuffer;
  try {
    ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(env.iv) }, dekKey, base64ToBytes(env.ct));
  } catch {
    throw new Error("Decryption failed — wrong secret or corrupt backup");
  }
  return JSON.parse(new TextDecoder().decode(ptBuf)) as BackupPayload;
}

// --- legacy v1 ------------------------------------------------------------

async function deriveAesKeyV1(seedHex: string): Promise<CryptoKey> {
  const seed = hexToBytes(seedHex);
  const baseKey = await crypto.subtle.importKey("raw", seed, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: HKDF_INFO_V1 },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Legacy v1 encryptor (seed-only). Retained for back-compat tests. */
export async function serializeAndEncryptV1(payload: BackupPayload, seedHex: string): Promise<string> {
  const key = await deriveAesKeyV1(seedHex);
  const iv = randomBytes(12);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const envelope: BackupEnvelopeV1 = {
    v: 1,
    alg: "AES-256-GCM",
    kdf: "HKDF-SHA256",
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ctBuf)),
  };
  return JSON.stringify(envelope);
}

async function decryptV1(env: BackupEnvelopeV1, seedHex: string): Promise<BackupPayload> {
  if (typeof env.iv !== "string" || typeof env.ct !== "string") {
    throw new Error("Decryption failed — wrong seed or corrupt backup");
  }
  const key = await deriveAesKeyV1(seedHex);
  let ptBuf: ArrayBuffer;
  try {
    ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(env.iv) }, key, base64ToBytes(env.ct));
  } catch {
    throw new Error("Decryption failed — wrong seed or corrupt backup");
  }
  return JSON.parse(new TextDecoder().decode(ptBuf)) as BackupPayload;
}
