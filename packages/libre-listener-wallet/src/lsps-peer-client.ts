// LSPS0 request/response client over LDK custom peer messages (type 37913). Implements LDK's
// CustomMessageHandler/CustomMessageReader from JS: outbound LSPS requests are queued and flushed by
// PeerManager.process_events(); incoming responses are correlated to pending promises by JSON-RPC id.
import {
  CustomMessageHandler,
  CustomMessageReader,
  Type,
  TwoTuple_PublicKeyTypeZ,
  Option_TypeZ,
  NodeFeatures,
  InitFeatures,
  Result_NoneLightningErrorZ,
  Result_NoneNoneZ,
  Result_COption_TypeZDecodeErrorZ,
  type PeerManager,
  type Init,
} from "lightningdevkit";
import type { Lsps2GetVersionsResponse, Lsps2GetInfoResponse } from "@libre/shared";
import {
  LSPS_PEER_MSG_TYPE,
  encodeLspsMessage,
  decodeLspsMessage,
  buildRequest,
  parseResponse,
  newRequestId,
  hexToBytes,
  type JsonRpcResponseObj,
} from "./lsps-message";

export interface LspsPeerClientConfig {
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LspsPeerClient {
  private outbound: Array<{ peer: Uint8Array; obj: unknown }> = [];
  private pending = new Map<string, Pending>();
  private pm?: PeerManager;
  private logger?: LspsPeerClientConfig["logger"];

  constructor(cfg: LspsPeerClientConfig = {}) {
    this.logger = cfg.logger;
  }

  setPeerManager(pm: PeerManager): void {
    this.pm = pm;
  }

  // Build the LDK CustomMessageHandler backed by this client's queue + pending map.
  buildHandler(): CustomMessageHandler {
    const reader = CustomMessageReader.new_impl({
      read: (messageType: number, buffer: Uint8Array): Result_COption_TypeZDecodeErrorZ => {
        if (messageType !== LSPS_PEER_MSG_TYPE) {
          return Result_COption_TypeZDecodeErrorZ.constructor_ok(Option_TypeZ.constructor_none());
        }
        const t = Type.new_impl({
          type_id: () => LSPS_PEER_MSG_TYPE,
          debug_str: () => "lsps",
          write: () => buffer,
        });
        return Result_COption_TypeZDecodeErrorZ.constructor_ok(Option_TypeZ.constructor_some(t));
      },
    });

    return CustomMessageHandler.new_impl(
      {
        handle_custom_message: (msg: Type, _sender: Uint8Array): Result_NoneLightningErrorZ => {
          try {
            const resp = parseResponse(decodeLspsMessage(msg.write()));
            if (resp) this.deliver(resp);
          } catch (e) {
            this.logger?.warn?.(`[LSPS] undecodable custom message: ${(e as Error).message}`);
          }
          return Result_NoneLightningErrorZ.constructor_ok();
        },
        get_and_clear_pending_msg: (): TwoTuple_PublicKeyTypeZ[] => {
          const drained = this.outbound.splice(0);
          return drained.map(({ peer, obj }) =>
            TwoTuple_PublicKeyTypeZ.constructor_new(
              peer,
              Type.new_impl({
                type_id: () => LSPS_PEER_MSG_TYPE,
                debug_str: () => "lsps",
                write: () => encodeLspsMessage(obj),
              })
            )
          );
        },
        peer_disconnected: (_id: Uint8Array): void => {},
        peer_connected: (_id: Uint8Array, _msg: Init, _inbound: boolean): Result_NoneNoneZ =>
          Result_NoneNoneZ.constructor_ok(),
        provided_node_features: (): NodeFeatures => NodeFeatures.constructor_empty(),
        provided_init_features: (_id: Uint8Array): InitFeatures => InitFeatures.constructor_empty(),
      },
      reader
    );
  }

  private deliver(resp: JsonRpcResponseObj): void {
    const p = this.pending.get(resp.id);
    if (!p) return; // unknown or already-expired id — ignore
    this.pending.delete(resp.id);
    clearTimeout(p.timer);
    if (resp.error) p.reject(new Error(`LSPS error ${resp.error.code}: ${resp.error.message}`));
    else p.resolve(resp.result);
  }

  request(peerPubkeyHex: string, method: string, params: unknown, opts: { timeoutMs?: number } = {}): Promise<any> {
    const id = newRequestId();
    const timeoutMs = opts.timeoutMs ?? 15000;
    const peer = hexToBytes(peerPubkeyHex);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSPS request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.outbound.push({ peer, obj: buildRequest(method, params, id) });
      // Flush now; LDK also flushes on its own timer, but this sends promptly.
      this.pm?.process_events();
    });
  }

  getVersions(peerPubkeyHex: string): Promise<Lsps2GetVersionsResponse> {
    return this.request(peerPubkeyHex, "lsps2.get_versions", {});
  }

  getInfo(peerPubkeyHex: string, params: { version: number; token?: string }): Promise<Lsps2GetInfoResponse> {
    return this.request(peerPubkeyHex, "lsps2.get_info", params);
  }
}
