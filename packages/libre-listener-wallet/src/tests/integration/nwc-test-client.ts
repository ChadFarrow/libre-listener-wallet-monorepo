// A NIP-47 (NWC) client for tests — the "app" side that drives the wallet's NwcManager over a relay.
// Uses nostr-tools exactly like a real NWC client: parse the pairing URI, NIP-04-encrypt a
// {method,params} request as a kind-23194 event signed by the connection secret, publish it, and
// await the wallet's kind-23195 response (matched by #e = request id), decrypting the result.
import { finalizeEvent, getPublicKey, nip04, Relay } from "nostr-tools";
import { hexToBytes } from "../../storage-cache";

export interface NwcResponse {
  result_type?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface NwcClient {
  clientPubkey: string;
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<NwcResponse>;
  close(): Promise<void>;
}

export function parsePairingUri(uri: string): { walletPubkey: string; relayUrl: string; secret: string } {
  const u = new URL(uri.replace("nostr+walletconnect://", "http://"));
  const walletPubkey = u.hostname;
  const secret = u.searchParams.get("secret");
  const relay = u.searchParams.get("relay");
  if (!walletPubkey || !secret || !relay) throw new Error(`Malformed NWC pairing URI: ${uri}`);
  return { walletPubkey, relayUrl: decodeURIComponent(relay), secret };
}

export async function connectNwcClient(pairingUri: string): Promise<NwcClient> {
  const { walletPubkey, relayUrl, secret } = parsePairingUri(pairingUri);
  const secretBytes = hexToBytes(secret);
  const clientPubkey = getPublicKey(secretBytes);
  const relay = await Relay.connect(relayUrl);

  async function request(method: string, params: Record<string, unknown>, timeoutMs = 60000): Promise<NwcResponse> {
    const content = await nip04.encrypt(secret, walletPubkey, JSON.stringify({ method, params }));
    const reqEvent = finalizeEvent(
      { kind: 23194, tags: [["p", walletPubkey]], content, created_at: Math.floor(Date.now() / 1000) },
      secretBytes,
    );

    const responsePromise = new Promise<NwcResponse>((resolve, reject) => {
      const sub = relay.subscribe([{ kinds: [23195], "#e": [reqEvent.id] }], {
        async onevent(ev) {
          try {
            const plain = await nip04.decrypt(secret, walletPubkey, ev.content);
            resolve(JSON.parse(plain) as NwcResponse);
          } catch (e) {
            reject(e);
          } finally {
            clearTimeout(timer);
            sub.close();
          }
        },
      });
      const timer = setTimeout(() => {
        sub.close();
        reject(new Error(`NWC ${method} request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    await relay.publish(reqEvent);
    return responsePromise;
  }

  return { clientPubkey, request, close: async () => relay.close() };
}
