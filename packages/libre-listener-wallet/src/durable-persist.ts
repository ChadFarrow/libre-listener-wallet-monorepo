import {
  Persist,
  ChannelMonitorUpdateStatus,
  OutPoint,
  ChainMonitor,
  ChannelMonitor,
  ChannelMonitorUpdate,
} from "lightningdevkit";
import type { Logger } from "./index";

// A live LDK binding wrapper has a non-zero internal `ptr`; a Rust None is a wrapper with ptr 0n
// (every accessor on it silently returns 0). Mirrors hint-selection.ts's null-ptr guard.
export function isPresentWrapper(w: unknown): boolean {
  if (w == null) return false;
  const ptr = (w as { ptr?: unknown }).ptr;
  return !(ptr === undefined || ptr === null || ptr === 0 || ptr === 0n);
}

// Pick the update id to ack. LDK's Persist.new_impl trampoline hands update_persisted_channel a
// TRUTHY wrapper whose internal ptr === 0n for a Rust None update (NOT a JS null), so a naive
// `update ? update.get_update_id() : latest` always takes the truthy branch and reads a bogus id
// off the None-wrapper. Detect the None-wrapper by its ptr and fall back to the monitor's latest.
export function pickUpdateId(
  update: { get_update_id?: () => bigint } | null,
  latestUpdateId: bigint,
): bigint {
  return isPresentWrapper(update)
    ? (update as { get_update_id: () => bigint }).get_update_id()
    : latestUpdateId;
}

// True if the inner persister reported an unrecoverable error. LDK enum: Completed=0,
// InProgress=1, UnrecoverableError=2. Kept as a pure numeric compare so the wrapper can
// propagate that status instead of masking it as InProgress (see below).
export function isUnrecoverableStatus(status: unknown): boolean {
  return status === ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_UnrecoverableError;
}

// Compose the manager write into the durable batch. The channel_manager historically persisted
// lazily (stop()/export only), so a page kill left disk with monitor N + manager N-k — which LDK
// resolves on next load by FORCE-CLOSING the channel ("A ChannelManager is stale compared to the
// current ChannelMonitor!"; reproduced live 2026-07-09). Enqueue the manager snapshot BEFORE the
// flush so monitor + manager land in one durable batch; a failed manager write rejects without
// flushing, so the ack never fires on a batch missing the manager (channel stays safely paused).
//
// NOTE for callers: persistManager must only SERIALIZE + ENQUEUE (KVStore write) — it runs in the
// flush promise chain, safely outside any LDK callback stack, which is the only place
// ChannelManager.write() may be called (inside a Persist callback LDK still holds its locks).
export function composeDurableFlush(
  persistManager: (() => Promise<void>) | undefined,
  flush: () => Promise<void>,
): () => Promise<void> {
  if (!persistManager) return flush;
  return async () => {
    // Unwind the LDK callback stack FIRST. This composed flush is invoked synchronously inside
    // Persist.persist_new_channel/update_persisted_channel, and an async body runs synchronously
    // until its first await — so without this, persistManager()'s ChannelManager.write() executes
    // inside LDK's Persist callback while LDK holds its locks (WASM BorrowMutError panic, the same
    // re-entrancy class as the peer-disconnect trap). Microtasks only run once the whole
    // JS→WASM→JS stack returns to the event loop, so after this await we are safely outside LDK.
    await Promise.resolve();
    await persistManager();
    await flush();
  };
}

// Schedule the durable acknowledgement: only ack (mark the monitor update complete to LDK) once the
// write is durably committed; on a failed flush, do NOT ack — LDK stays paused on that channel,
// which is the safe outcome. A synchronous throw inside `ack` is routed to onError too (never left
// as an unobserved rejection). Pure; unit-testable without LDK.
export function scheduleDurableAck(
  flush: () => Promise<void>,
  ack: () => void,
  onError: (e: unknown) => void,
): void {
  flush().then(() => {
    try {
      ack();
    } catch (e) {
      onError(e);
    }
  }, onError);
}

// Wrap an inner Persist so it advertises InProgress and only signals ChainMonitor.channel_monitor_updated
// AFTER the durable commit. The on-disk format is the inner persister's (unchanged).
//
// WASM lifetime: the OutPoint/ChannelMonitor args may be freed after this synchronous call returns, so
// capture plain values (txid bytes, index, update id) synchronously and rebuild the OutPoint in the ack.
export function createDurablePersist(
  inner: Persist,
  flush: () => Promise<void>,
  getChainMonitor: () => ChainMonitor | undefined,
  logger?: Logger,
  // Invoked with the funding outpoint + update id AFTER a durable flush lands, so the caller
  // can advance a persisted high-water mark exactly in step with durably-persisted state (never
  // ahead of it). Best-effort; a throw is swallowed so it can't break the ack path.
  onDurablePersisted?: (txidLe: Uint8Array, index: number, updateId: bigint) => void,
  // Serializes + enqueues the channel_manager so it lands in the SAME durable batch as the
  // monitor update (see composeDurableFlush — the OutdatedChannelManager force-close fix).
  persistManager?: () => Promise<void>,
): Persist {
  const durableFlush = composeDurableFlush(persistManager, flush);
  const ackDurable = (txidLe: Uint8Array, index: number, updateId: bigint): void => {
    const cm = getChainMonitor();
    if (!cm) {
      logger?.warn(
        `[DurablePersist] chain monitor unavailable; skipping durable ack for update ${updateId}`,
      );
      return;
    }
    const txo = OutPoint.constructor_new(txidLe, index);
    const res = cm.channel_monitor_updated(txo, updateId);
    if (!res.is_ok()) {
      logger?.error(`[DurablePersist] channel_monitor_updated failed for update ${updateId}`);
    }
    if (onDurablePersisted) {
      try {
        onDurablePersisted(txidLe, index, updateId);
      } catch (e) {
        logger?.error(`[DurablePersist] onDurablePersisted hook threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  const onFlushError = (e: unknown): void => {
    logger?.error(
      `[DurablePersist] durable flush failed; leaving channel paused: ${e instanceof Error ? e.message : String(e)}`,
    );
  };

  return Persist.new_impl({
    persist_new_channel(txo: OutPoint, monitor: ChannelMonitor): ChannelMonitorUpdateStatus {
      const innerStatus = inner.persist_new_channel(txo, monitor);
      // If the inner persister itself failed unrecoverably (e.g. a serialization/namespace fault
      // BEFORE any KVStore write, which never sets the StorageCache degraded flag), do NOT schedule
      // an ack — masking it as InProgress + acking would let LDK advance past state that was never
      // written. Propagate the real status so LDK treats the channel as unrecoverable (safe).
      if (isUnrecoverableStatus(innerStatus)) {
        logger?.error("[DurablePersist] inner persist_new_channel returned UnrecoverableError; not acking");
        return innerStatus;
      }
      const txidLe = txo.get_txid();
      const index = txo.get_index();
      const updateId = monitor.get_latest_update_id();
      scheduleDurableAck(durableFlush, () => ackDurable(txidLe, index, updateId), onFlushError);
      return ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_InProgress;
    },
    update_persisted_channel(
      txo: OutPoint,
      update: ChannelMonitorUpdate | null,
      monitor: ChannelMonitor,
    ): ChannelMonitorUpdateStatus {
      const innerStatus = inner.update_persisted_channel(txo, update as any, monitor);
      if (isUnrecoverableStatus(innerStatus)) {
        logger?.error("[DurablePersist] inner update_persisted_channel returned UnrecoverableError; not acking");
        return innerStatus;
      }
      const txidLe = txo.get_txid();
      const index = txo.get_index();
      const latest = monitor.get_latest_update_id();
      const updateId = pickUpdateId(update as any, latest);
      scheduleDurableAck(durableFlush, () => ackDurable(txidLe, index, updateId), onFlushError);
      return ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_InProgress;
    },
    archive_persisted_channel(txo: OutPoint): void {
      inner.archive_persisted_channel(txo);
    },
  });
}
