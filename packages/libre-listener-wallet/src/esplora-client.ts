import {
  FilterInterface,
  WatchedOutput,
  TwoTuple_usizeTransactionZ,
  ChannelManager,
  ChainMonitor,
  ConfirmationTarget,
  Option_ThirtyTwoBytesZ_Some,
} from "lightningdevkit";
import { Logger } from "./index";
import { bytesToHex, hexToBytes } from "./storage-cache";

export interface EsploraTxStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

export interface EsploraTx {
  txid: string;
  version: number;
  locktime: number;
  vin: any[];
  vout: any[];
  size: number;
  weight: number;
  fee: number;
  status: EsploraTxStatus;
}

export interface EsploraMerkleProof {
  block_height: number;
  merkle: string[];
  pos: number;
}

export interface EsploraSpendInfo {
  spent: boolean;
  txid?: string;
  vin?: number;
  status?: EsploraTxStatus;
}

// Decide which watched txs are "buried" — confirmed on-chain at a height the forward
// sync loop won't revisit (block_height <= bestHeight) — and group them by height
// ascending so the caller can confirm them in chain order. Pure; no LDK, no direct network.
// `fetchStatus` returns null for fetch errors/missing txs (caller logs); null = skip.
export async function planBuriedConfirmations(
  watchedTxids: string[],
  fetchStatus: (txid: string) => Promise<{ confirmed: boolean; block_height?: number } | null>,
  bestHeight: number,
): Promise<{ height: number; txids: string[] }[]> {
  const byHeight = new Map<number, string[]>();
  for (const txid of watchedTxids) {
    const status = await fetchStatus(txid);
    if (!status || !status.confirmed || typeof status.block_height !== "number") continue;
    if (status.block_height > bestHeight) continue;
    const h = status.block_height;
    const group = byHeight.get(h);
    if (group) group.push(txid);
    else byHeight.set(h, [txid]);
  }
  return [...byHeight.keys()]
    .sort((a, b) => a - b)
    .map((height) => ({ height, txids: byHeight.get(height)! }));
}

// LDK hands txids as raw bytes in internal (little-endian) order; esplora's REST API
// addresses txs by display (big-endian) hex — the reverse. Convert before any esplora query.
// (Do NOT use this when feeding a txid back to LDK, e.g. transaction_unconfirmed.)
export function ldkTxidToDisplay(txidBytes: Uint8Array): string {
  return bytesToHex(new Uint8Array(txidBytes).reverse());
}

export class EsploraSyncClient implements FilterInterface {
  private esploraUrl: string;
  private logger?: Logger;
  private registeredTxs: Map<string, Uint8Array> = new Map(); // txid hex -> scriptPubKey
  private registeredOutputs: Map<string, WatchedOutput> = new Map(); // outpoint hex (txid:index) -> WatchedOutput

  constructor(esploraUrl: string, logger?: Logger) {
    this.esploraUrl = esploraUrl.replace(/\/$/, "");
    this.logger = logger;
  }

  // --- FilterInterface implementation ---

  register_tx(txid: Uint8Array, script_pubkey: Uint8Array): void {
    const txidHex = ldkTxidToDisplay(txid); // display order for esplora lookups
    this.logger?.info(`Registering tx filter: ${txidHex}`);
    this.registeredTxs.set(txidHex, script_pubkey);
  }

  register_output(output: WatchedOutput): void {
    const outpoint = output.get_outpoint();
    const txidHex = ldkTxidToDisplay(outpoint.get_txid()); // display order for esplora lookups
    const index = outpoint.get_index();
    const outpointHex = `${txidHex}:${index}`;
    this.logger?.info(`Registering output filter: ${outpointHex}`);
    this.registeredOutputs.set(outpointHex, output);
  }

  // --- Custom sync methods ---

  getRegisteredTxs(): Map<string, Uint8Array> {
    return this.registeredTxs;
  }

  getRegisteredOutputs(): Map<string, WatchedOutput> {
    return this.registeredOutputs;
  }

  async fetchTipHeight(): Promise<number> {
    const res = await fetch(`${this.esploraUrl}/blocks/tip/height`);
    if (!res.ok) throw new Error(`Failed to fetch tip height: ${res.statusText}`);
    const text = await res.text();
    return parseInt(text.trim(), 10);
  }

  async fetchTipHash(): Promise<string> {
    const res = await fetch(`${this.esploraUrl}/blocks/tip/hash`);
    if (!res.ok) throw new Error(`Failed to fetch tip hash: ${res.statusText}`);
    const text = await res.text();
    return text.trim();
  }

  async fetchBlockHash(height: number): Promise<string> {
    const res = await fetch(`${this.esploraUrl}/block-height/${height}`);
    if (!res.ok) throw new Error(`Failed to fetch block hash at height ${height}: ${res.statusText}`);
    const text = await res.text();
    return text.trim();
  }

  async fetchBlockHeader(height: number): Promise<string> {
    const hash = await this.fetchBlockHash(height);
    const res = await fetch(`${this.esploraUrl}/block/${hash}/header`);
    if (!res.ok) throw new Error(`Failed to fetch block header for hash ${hash}: ${res.statusText}`);
    const text = await res.text();
    return text.trim();
  }

  async fetchTx(txid: string): Promise<EsploraTx | null> {
    const res = await fetch(`${this.esploraUrl}/tx/${txid}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to fetch tx ${txid}: ${res.statusText}`);
    return res.json() as Promise<EsploraTx>;
  }

  async fetchRawTx(txid: string): Promise<string> {
    const res = await fetch(`${this.esploraUrl}/tx/${txid}/hex`);
    if (!res.ok) throw new Error(`Failed to fetch raw tx hex ${txid}: ${res.statusText}`);
    const text = await res.text();
    return text.trim();
  }

  async fetchMerkleProof(txid: string): Promise<EsploraMerkleProof | null> {
    const res = await fetch(`${this.esploraUrl}/tx/${txid}/merkle-proof`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to fetch merkle proof for tx ${txid}: ${res.statusText}`);
    return res.json() as Promise<EsploraMerkleProof>;
  }

  async fetchSpendInfo(txid: string, index: number): Promise<EsploraSpendInfo | null> {
    const res = await fetch(`${this.esploraUrl}/tx/${txid}/outspends`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to fetch outspends for tx ${txid}: ${res.statusText}`);
    const outspends = (await res.json()) as EsploraSpendInfo[];
    return outspends[index] || null;
  }

  async broadcastTransaction(txBytes: Uint8Array): Promise<void> {
    const hex = bytesToHex(txBytes);
    const res = await fetch(`${this.esploraUrl}/tx`, {
      method: "POST",
      body: hex,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to broadcast transaction: ${text}`);
    }
    this.logger?.info(`Successfully broadcasted transaction: ${await res.text()}`);
  }

  private cachedFeeEstimates: Record<string, number> = {};

  async fetchFeeEstimates(): Promise<Record<string, number>> {
    const res = await fetch(`${this.esploraUrl}/fee-estimates`);
    if (!res.ok) throw new Error(`Failed to fetch fee estimates: ${res.statusText}`);
    return res.json() as Promise<Record<string, number>>;
  }

  async updateFeeEstimates(): Promise<void> {
    try {
      this.cachedFeeEstimates = await this.fetchFeeEstimates();
    } catch (e) {
      this.logger?.warn(`Failed to update fee estimates: ${e instanceof Error ? e.message : e}`);
    }
  }

  getFeeRate(target: ConfirmationTarget): number {
    let blockTarget = 6; // Default to 6 blocks confirmation (medium priority)
    
    switch (target) {
      case ConfirmationTarget.LDKConfirmationTarget_UrgentOnChainSweep:
        blockTarget = 1;
        break;
      case ConfirmationTarget.LDKConfirmationTarget_AnchorChannelFee:
      case ConfirmationTarget.LDKConfirmationTarget_NonAnchorChannelFee:
      case ConfirmationTarget.LDKConfirmationTarget_OutputSpendingFee:
        blockTarget = 6;
        break;
      case ConfirmationTarget.LDKConfirmationTarget_ChannelCloseMinimum:
        blockTarget = 36;
        break;
      default:
        blockTarget = 6;
    }

    const feeRate = this.cachedFeeEstimates[blockTarget] || this.cachedFeeEstimates["6"] || this.cachedFeeEstimates["144"] || 2.0;
    return Math.max(253, Math.round(feeRate * 250));
  }

  async sync(channelManager: ChannelManager, chainMonitor: ChainMonitor): Promise<void> {
    await this.updateFeeEstimates();
    const tipHeight = await this.fetchTipHeight();
    const tipHashHex = await this.fetchTipHash();

    const confirmManager = channelManager.as_Confirm();
    const confirmMonitor = chainMonitor.as_Confirm();

    // Get current best block in manager
    const managerBestBlock = channelManager.current_best_block();
    let bestHeight = managerBestBlock.get_height();
    let bestHashHex = bytesToHex(new Uint8Array(managerBestBlock.get_block_hash()).reverse());

    this.logger?.info(`Syncing LDK: best height ${bestHeight} (${bestHashHex}) -> tip height ${tipHeight} (${tipHashHex})`);

    // 1. Reorganization check
    if (bestHeight > 0) {
      let currentLocalHeight = bestHeight;
      let currentLocalHashHex = bestHashHex;

      while (currentLocalHeight > 0) {
        const remoteHashHex = await this.fetchBlockHash(currentLocalHeight);
        if (remoteHashHex === currentLocalHashHex) {
          break;
        }
        this.logger?.warn(`Reorg detected at height ${currentLocalHeight}: local ${currentLocalHashHex} != remote ${remoteHashHex}`);
        currentLocalHeight--;
        if (currentLocalHeight > 0) {
          currentLocalHashHex = await this.fetchBlockHash(currentLocalHeight);
        } else {
          currentLocalHashHex = "";
        }
      }

      if (currentLocalHeight < bestHeight) {
        this.logger?.warn(`Handling reorg: rolling back from height ${bestHeight} to common ancestor ${currentLocalHeight}`);

        const managerRelevant = confirmManager.get_relevant_txids();
        const monitorRelevant = confirmMonitor.get_relevant_txids();
        const allRelevantTxids = new Set<string>();

        for (const tuple of [...managerRelevant, ...monitorRelevant]) {
          allRelevantTxids.add(bytesToHex(tuple.get_a()));
        }

        // Notify unconfirmed for all relevant txs that were confirmed above the common ancestor
        for (const txidHex of allRelevantTxids) {
          const txid = hexToBytes(txidHex);
          confirmManager.transaction_unconfirmed(txid);
          confirmMonitor.transaction_unconfirmed(txid);
        }

        // Notify best block updated to the common ancestor
        const commonAncestorHeaderHex = await this.fetchBlockHeader(currentLocalHeight);
        const commonAncestorHeader = hexToBytes(commonAncestorHeaderHex);
        confirmManager.best_block_updated(commonAncestorHeader, currentLocalHeight);
        confirmMonitor.best_block_updated(commonAncestorHeader, currentLocalHeight);

        bestHeight = currentLocalHeight;
        bestHashHex = currentLocalHashHex;
      }
    }

    // 1.5 Catch-up: confirm watched txs already buried at/below bestHeight.
    // The forward loop (step 2) only confirms txs whose block is in (bestHeight, tip].
    // A funding tx registered AFTER its block was synced — instant regtest mining, or
    // app closed -> funding confirms -> reopen past the block — would otherwise never
    // confirm, leaving the channel stuck "pending" forever (no channel_ready sent).
    {
      const watched = new Set<string>();
      for (const tuple of [...confirmManager.get_relevant_txids(), ...confirmMonitor.get_relevant_txids()]) {
        if (!(tuple.get_c() instanceof Option_ThirtyTwoBytesZ_Some)) {
          watched.add(ldkTxidToDisplay(tuple.get_a())); // esplora display order
        }
      }
      for (const txidHex of this.registeredTxs.keys()) watched.add(txidHex);

      const groups = await planBuriedConfirmations(
        [...watched],
        async (txid) => {
          try {
            const tx = await this.fetchTx(txid);
            return tx?.status ?? null;
          } catch (e) {
            this.logger?.warn(`Catch-up confirm: failed to fetch tx ${txid}: ${e instanceof Error ? e.message : e}`);
            return null;
          }
        },
        bestHeight,
      );

      for (const { height, txids } of groups) {
        try {
          const header = hexToBytes(await this.fetchBlockHeader(height));
          const entries: { pos: number; rawTx: Uint8Array }[] = [];
          for (const txidHex of txids) {
            const rawTx = hexToBytes(await this.fetchRawTx(txidHex));
            const merkle = await this.fetchMerkleProof(txidHex);
            entries.push({ pos: merkle ? merkle.pos : 0, rawTx });
          }
          entries.sort((a, b) => a.pos - b.pos);
          const txdata = entries.map((e) => TwoTuple_usizeTransactionZ.constructor_new(e.pos, e.rawTx));
          confirmManager.transactions_confirmed(header, txdata, height);
          confirmMonitor.transactions_confirmed(header, txdata, height);
          this.logger?.info(`Catch-up confirmed ${txids.length} buried tx(s) at height ${height}`);
        } catch (e) {
          this.logger?.warn(`Catch-up confirm at height ${height} failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    // 2. Sync forward block-by-block
    let currentHeight = bestHeight + 1;
    while (currentHeight <= tipHeight) {
      const blockHashHex = await this.fetchBlockHash(currentHeight);
      const blockHeaderHex = await this.fetchBlockHeader(currentHeight);
      const blockHeader = hexToBytes(blockHeaderHex);

      const txdata: TwoTuple_usizeTransactionZ[] = [];
      const activeTxidsToCheck = new Set<string>();

      // Load transactions LDK is monitoring
      const managerRelevant = confirmManager.get_relevant_txids();
      const monitorRelevant = confirmMonitor.get_relevant_txids();
      for (const tuple of [...managerRelevant, ...monitorRelevant]) {
        // If it was previously confirmed, check if it was at or after currentHeight
        // Or if it needs confirmation check
        activeTxidsToCheck.add(ldkTxidToDisplay(tuple.get_a())); // esplora display order
      }

      // Add manually registered transactions (e.g. funding transactions)
      for (const txidHex of this.registeredTxs.keys()) {
        activeTxidsToCheck.add(txidHex);
      }

      // Check registered outputs for spends
      for (const [outpointHex, watchedOutput] of this.registeredOutputs.entries()) {
        const [txidHex, indexStr] = outpointHex.split(":");
        const index = parseInt(indexStr, 10);
        const spendInfo = await this.fetchSpendInfo(txidHex, index);
        if (spendInfo && spendInfo.spent && spendInfo.status?.confirmed) {
          if (spendInfo.status.block_height === currentHeight) {
            if (spendInfo.txid) {
              activeTxidsToCheck.add(spendInfo.txid);
            }
          }
        }
      }

      // Query Esplora for each txid's confirmation status in the current block
      for (const txidHex of activeTxidsToCheck) {
        const tx = await this.fetchTx(txidHex);
        if (tx && tx.status?.confirmed && tx.status.block_height === currentHeight) {
          const rawTxHex = await this.fetchRawTx(txidHex);
          const rawTx = hexToBytes(rawTxHex);
          const merkle = await this.fetchMerkleProof(txidHex);
          const index = merkle ? merkle.pos : 0;
          txdata.push(TwoTuple_usizeTransactionZ.constructor_new(index, rawTx));
        }
      }

      // Sort by position (chain order)
      txdata.sort((a, b) => a.get_a() - b.get_a());

      // Notify confirmations
      if (txdata.length > 0) {
        confirmManager.transactions_confirmed(blockHeader, txdata, currentHeight);
        confirmMonitor.transactions_confirmed(blockHeader, txdata, currentHeight);
      }

      // Update best block
      confirmManager.best_block_updated(blockHeader, currentHeight);
      confirmMonitor.best_block_updated(blockHeader, currentHeight);

      currentHeight++;
    }
  }
}
