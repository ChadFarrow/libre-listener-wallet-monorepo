import { hexToBytes } from "./storage-cache";

export interface BackupPayload {
  version: 1;
  network: string;
  exportedAt: number;
  entries: Record<string, string>; // storageKey -> hex value
}

interface BackupEnvelope {
  v: 1;
  alg: "AES-256-GCM";
  kdf: "HKDF-SHA256";
  iv: string; // base64
  ct: string; // base64
}

const HKDF_INFO = new TextEncoder().encode("libre-wallet-backup-v1");

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

async function deriveAesKey(seedHex: string): Promise<CryptoKey> {
  const seed = hexToBytes(seedHex);
  const baseKey = await crypto.subtle.importKey("raw", seed, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: HKDF_INFO },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function serializeAndEncrypt(payload: BackupPayload, seedHex: string): Promise<string> {
  const key = await deriveAesKey(seedHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const envelope: BackupEnvelope = {
    v: 1,
    alg: "AES-256-GCM",
    kdf: "HKDF-SHA256",
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ctBuf)),
  };
  return JSON.stringify(envelope);
}

export async function decryptAndParse(envelopeStr: string, seedHex: string): Promise<BackupPayload> {
  let envelope: BackupEnvelope;
  try {
    envelope = JSON.parse(envelopeStr);
  } catch {
    throw new Error("Invalid backup: not valid JSON");
  }
  if (envelope.v !== 1) throw new Error(`Unsupported backup version: ${envelope.v}`);
  if (typeof envelope.iv !== "string" || typeof envelope.ct !== "string") {
    throw new Error("Decryption failed — wrong seed or corrupt backup");
  }
  const key = await deriveAesKey(seedHex);
  const iv = base64ToBytes(envelope.iv);
  const ct = base64ToBytes(envelope.ct);
  let plaintextBuf: ArrayBuffer;
  try {
    plaintextBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  } catch {
    throw new Error("Decryption failed — wrong seed or corrupt backup");
  }
  return JSON.parse(new TextDecoder().decode(plaintextBuf)) as BackupPayload;
}
