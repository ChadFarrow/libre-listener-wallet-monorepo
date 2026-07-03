// gRPC client for lnd's HTLC interceptor (routerrpc.Router/HtlcInterceptor) — a bidirectional
// stream that is NOT exposed on lnd's REST gateway, so it needs gRPC. Rather than vendor lnd's full
// proto tree (which imports lightning.proto + google/api/*), we embed a MINIMAL self-contained proto
// with only the interceptor messages, using lnd's exact field numbers (from lnrpc/routerrpc/
// router.proto @ v0.18.5-beta) so the fields we read/write decode correctly. Unused fields are
// simply omitted — proto3 ignores unknown fields on decode and we never set them on encode.
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { InterceptRequest, InterceptDecision } from "./intercept-types";

const ROUTER_PROTO = `syntax = "proto3";
package routerrpc;
service Router {
  rpc HtlcInterceptor (stream ForwardHtlcInterceptResponse) returns (stream ForwardHtlcInterceptRequest);
}
message CircuitKey { uint64 chan_id = 1; uint64 htlc_id = 2; }
message ForwardHtlcInterceptRequest {
  CircuitKey incoming_circuit_key = 1;
  bytes payment_hash = 2;
  uint64 outgoing_amount_msat = 3;
  uint64 outgoing_requested_chan_id = 7;
}
message ForwardHtlcInterceptResponse {
  CircuitKey incoming_circuit_key = 1;
  ResolveHoldForwardAction action = 2;
  uint64 out_amount_msat = 7;
}
enum ResolveHoldForwardAction { SETTLE = 0; FAIL = 1; RESUME = 2; RESUME_MODIFIED = 3; }
`;

export interface LndGrpcConfig {
  host: string; // e.g. 127.0.0.1:10009
  tlsCert: Buffer; // lnd tls.cert PEM (grpc-js needs it explicitly; NODE_TLS override doesn't apply)
  macaroonHex: string; // admin macaroon, hex
  serverNameOverride?: string; // must match a cert SAN; lnd's cert includes "localhost"
}

interface GrpcLogger {
  info: (m: string) => void;
  error: (m: string) => void;
}

export class LndGrpcInterceptor {
  private client: any = null;
  private stream: any = null;
  private stopped = false;

  constructor(private cfg: LndGrpcConfig, private logger?: GrpcLogger) {}

  // Opens the bidi interceptor stream. For each intercepted HTLC, calls onHtlc and writes back the
  // decision. While this stream is open lnd routes every forward through it (resume = unchanged).
  start(onHtlc: (req: InterceptRequest) => Promise<InterceptDecision>): void {
    const protoPath = path.join(os.tmpdir(), "libre-lnd-router.proto");
    fs.writeFileSync(protoPath, ROUTER_PROTO);
    const def = protoLoader.loadSync(protoPath, { keepCase: true, longs: String, enums: String, defaults: true });
    const pkg: any = grpc.loadPackageDefinition(def);

    const ssl = grpc.credentials.createSsl(this.cfg.tlsCert);
    const macaroon = grpc.credentials.createFromMetadataGenerator((_args, cb) => {
      const md = new grpc.Metadata();
      md.add("macaroon", this.cfg.macaroonHex);
      cb(null, md);
    });
    const creds = grpc.credentials.combineChannelCredentials(ssl, macaroon);

    this.client = new pkg.routerrpc.Router(this.cfg.host, creds, {
      "grpc.ssl_target_name_override": this.cfg.serverNameOverride ?? "localhost",
    });
    this.stream = this.client.htlcInterceptor();
    this.stream.on("data", (req: any) => {
      void this.handle(req, onHtlc);
    });
    this.stream.on("error", (err: any) => {
      if (!this.stopped) this.logger?.error(`[Interceptor] stream error: ${err?.message || err}`);
    });
    this.logger?.info(`[Interceptor] HTLC interceptor stream opened to ${this.cfg.host}`);
  }

  private async handle(req: any, onHtlc: (r: InterceptRequest) => Promise<InterceptDecision>): Promise<void> {
    const parsed: InterceptRequest = {
      incomingCircuitKey: {
        chanId: String(req.incoming_circuit_key?.chan_id ?? "0"),
        htlcIndex: String(req.incoming_circuit_key?.htlc_id ?? "0"),
      },
      outgoingRequestedChanId: String(req.outgoing_requested_chan_id ?? "0"),
      paymentHash: Buffer.from(req.payment_hash ?? []).toString("hex"),
      outgoingAmountMsat: BigInt(req.outgoing_amount_msat ?? "0"),
    };
    let decision: InterceptDecision;
    try {
      decision = await onHtlc(parsed);
    } catch (e: any) {
      this.logger?.error(`[Interceptor] handler error, resuming: ${e?.message || e}`);
      decision = { action: "resume" };
    }
    const resp: any = { incoming_circuit_key: req.incoming_circuit_key };
    if (decision.action === "resume_modified") {
      resp.action = "RESUME_MODIFIED";
      resp.out_amount_msat = decision.outAmountMsat.toString();
    } else if (decision.action === "fail") {
      resp.action = "FAIL";
    } else {
      resp.action = "RESUME";
    }
    try {
      this.stream.write(resp);
    } catch (e: any) {
      this.logger?.error(`[Interceptor] response write failed: ${e?.message || e}`);
    }
  }

  stop(): void {
    this.stopped = true;
    try {
      this.stream?.end();
    } catch {
      /* already closed */
    }
    try {
      this.client?.close?.();
    } catch {
      /* already closed */
    }
  }
}
