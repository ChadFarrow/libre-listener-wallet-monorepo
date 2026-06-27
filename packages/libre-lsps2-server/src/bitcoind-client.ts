export interface BitcoindConfig {
  rpcUrl: string;
  user: string;
  pass: string;
  // Address to mine confirmation blocks to. A fixed regtest address is used so we
  // don't call `getnewaddress`, which fails when bitcoind has no wallet loaded.
  mineAddress: string;
  fetchImpl?: typeof fetch;
}

export class BitcoindClient {
  private cfg: BitcoindConfig;
  private fetchImpl: typeof fetch;
  constructor(cfg: BitcoindConfig) {
    this.cfg = cfg;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async rpc(method: string, params: any[]): Promise<any> {
    const auth = Buffer.from(`${this.cfg.user}:${this.cfg.pass}`).toString("base64");
    const res = await this.fetchImpl(this.cfg.rpcUrl, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "1.0", id: "lsps2", method, params }),
    });
    if (!res.ok) throw new Error(`bitcoind HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.error) throw new Error(`bitcoind: ${data.error.message ?? JSON.stringify(data.error)}`);
    return data.result;
  }

  async mineBlocks(n: number): Promise<void> {
    await this.rpc("generatetoaddress", [n, this.cfg.mineAddress]);
  }
}
