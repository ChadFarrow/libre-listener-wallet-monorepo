export interface LndRestConfig {
  restUrl: string;
  macaroonHex: string;
  fetchImpl?: typeof fetch;
}

export class LndRestClient {
  private restUrl: string;
  private macaroonHex: string;
  private fetchImpl: typeof fetch;

  constructor(cfg: LndRestConfig) {
    this.restUrl = cfg.restUrl.replace(/\/$/, "");
    this.macaroonHex = cfg.macaroonHex;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async call(method: string, path: string, body?: object): Promise<any> {
    const res = await this.fetchImpl(`${this.restUrl}${path}`, {
      method,
      headers: { "Grpc-Metadata-macaroon": this.macaroonHex, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`lnd REST ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async getInfo(): Promise<{ identity_pubkey: string }> {
    return this.call("GET", "/v1/getinfo");
  }

  // OpenChannelSync — POSTs to /v1/channels and returns void.
  // Real lnd returns funding_txid_bytes (base64, internal byte order), NOT funding_txid_str,
  // so we never parse the funding point — channel matching uses remote_pubkey instead.
  async openChannel(p: { nodePubkeyHex: string; localFundingSat: number; pushSat: number }): Promise<void> {
    await this.call("POST", "/v1/channels", {
      node_pubkey_string: p.nodePubkeyHex,
      local_funding_amount: String(p.localFundingSat),
      push_sat: String(p.pushSat),
      private: true,
      commitment_type: "STATIC_REMOTE_KEY",
    });
  }

  // Opens an INSTANT zero-conf channel (no confirmation wait) to the client. Requires lnd's
  // --protocol.zero-conf + --protocol.option-scid-alias (set on libre-lnd) and an anchors
  // commitment. The client must accept 0-conf from this peer (trustedZeroConfPeers).
  async openZeroConfChannel(p: { nodePubkeyHex: string; localFundingSat: number; pushSat: number }): Promise<void> {
    await this.call("POST", "/v1/channels", {
      node_pubkey_string: p.nodePubkeyHex,
      local_funding_amount: String(p.localFundingSat),
      push_sat: String(p.pushSat),
      private: true,
      zero_conf: true,
      commitment_type: "ANCHORS",
    });
  }

  // Polls listchannels for the just-opened zero-conf channel and returns lnd's OWN scid alias
  // (`alias_scids[0]`, falling back to `peer_scid_alias`) as a decimal string. This is the scid an
  // external payer's onion carries for the LSP->client hop and that the interceptor sees as
  // `outgoing_requested_chan_id` — so it's what the client must advertise and the store keys on.
  async findZeroConfAlias(p: { nodePubkeyHex: string; retries?: number; delayMs?: number }): Promise<string> {
    const totalAttempts = (p.retries ?? 20) + 1;
    const delayMs = p.delayMs ?? 500;
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const r = await this.call("GET", "/v1/channels");
      const matches = (r.channels ?? []).filter((c: any) => c.remote_pubkey === p.nodePubkeyHex);
      for (const c of matches) {
        const alias = (Array.isArray(c.alias_scids) && c.alias_scids[0]) || c.peer_scid_alias;
        if (alias && String(alias) !== "0") return String(alias);
      }
      if (attempt < totalAttempts) await new Promise((res) => setTimeout(res, delayMs));
    }
    throw new Error(`no zero-conf alias for ${p.nodePubkeyHex} in listchannels after ${totalAttempts} tries`);
  }

  // Lists active channels and returns the chan_id of the last channel matching the given
  // remote pubkey. Retries up to `retries` additional times (default 5) with `delayMs`
  // delay (default 500 ms) between attempts to handle the mine→listchannels race.
  async findChannelScid(p: { nodePubkeyHex: string; retries?: number; delayMs?: number }): Promise<string> {
    const totalAttempts = (p.retries ?? 5) + 1;
    const delayMs = p.delayMs ?? 500;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const r = await this.call("GET", "/v1/channels");
      const matches = (r.channels ?? []).filter(
        (c: any) => c.remote_pubkey === p.nodePubkeyHex
      );
      if (matches.length > 0) {
        const lastMatch = matches[matches.length - 1];
        return String(lastMatch.chan_id);
      }
      if (attempt < totalAttempts) {
        await new Promise((res) => setTimeout(res, delayMs));
      }
    }

    throw new Error(
      `no channel to ${p.nodePubkeyHex} found in listchannels after ${totalAttempts} tries`
    );
  }
}
