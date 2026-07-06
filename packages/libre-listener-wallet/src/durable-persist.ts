import {
  Persist,
  ChannelMonitorUpdateStatus,
  OutPoint,
  ChainMonitor,
  ChannelMonitor,
  ChannelMonitorUpdate,
} from "lightningdevkit";
import type { Logger } from "./index";

// Schedule the durable acknowledgement: only ack (mark the monitor update complete to LDK) once the
// write is durably committed; on a failed flush, do NOT ack — LDK stays paused on that channel,
// which is the safe outcome. Pure; unit-testable without LDK.
export function scheduleDurableAck(
  flush: () => Promise<void>,
  ack: () => void,
  onFlushError: (e: unknown) => void,
): void {
  flush().then(ack, onFlushError);
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
): Persist {
  const ackDurable = (txidLe: Uint8Array, index: number, updateId: bigint): void => {
    const cm = getChainMonitor();
    if (!cm) return;
    const txo = OutPoint.constructor_new(txidLe, index);
    const res = cm.channel_monitor_updated(txo, updateId);
    if (!res.is_ok()) {
      logger?.error(`[DurablePersist] channel_monitor_updated failed for update ${updateId}`);
    }
  };
  const onFlushError = (e: unknown): void => {
    logger?.error(
      `[DurablePersist] durable flush failed; leaving channel paused: ${e instanceof Error ? e.message : String(e)}`,
    );
  };

  return Persist.new_impl({
    persist_new_channel(txo: OutPoint, monitor: ChannelMonitor): ChannelMonitorUpdateStatus {
      inner.persist_new_channel(txo, monitor);
      const txidLe = txo.get_txid();
      const index = txo.get_index();
      const updateId = monitor.get_latest_update_id();
      scheduleDurableAck(flush, () => ackDurable(txidLe, index, updateId), onFlushError);
      return ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_InProgress;
    },
    update_persisted_channel(
      txo: OutPoint,
      update: ChannelMonitorUpdate | null,
      monitor: ChannelMonitor,
    ): ChannelMonitorUpdateStatus {
      inner.update_persisted_channel(txo, update as any, monitor);
      const txidLe = txo.get_txid();
      const index = txo.get_index();
      const updateId = update ? update.get_update_id() : monitor.get_latest_update_id();
      scheduleDurableAck(flush, () => ackDurable(txidLe, index, updateId), onFlushError);
      return ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_InProgress;
    },
    archive_persisted_channel(txo: OutPoint): void {
      inner.archive_persisted_channel(txo);
    },
  });
}
