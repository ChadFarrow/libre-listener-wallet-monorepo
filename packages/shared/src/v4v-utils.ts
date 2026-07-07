export interface BoostRecord {
  action: "boost" | "stream" | "auto";
  value_msat_total: number;
  app_name: string;
  url?: string;
  ts?: number;
  time?: string;
  app_version?: string;
  speed?: string;
  sender_id?: string;
  signature?: string;
  sender_name?: string;
  name?: string;
  message?: string;
  podcast?: string;
  episode?: string;
  guid?: string;
  episode_guid?: string;
  feedGuid?: string;
  itemGuid?: string;
  feedID?: string;
  boost_link?: string;
  reply_address?: string;
  reply_custom_key?: string;
  reply_custom_value?: string;
  remote_feed_guid?: string;
  remote_item_guid?: string;
  boost_uuid?: string;
  uuid?: string;
}

export interface SplitDestination {
  destinationPubkey: string;
  customKey?: number;
  customValue?: string;
  share: number;
}

export interface TlvRecord {
  key: number;
  value: Uint8Array;
}

export interface SplitResult {
  destinationPubkey: string;
  amountSats: number;
  boostRecord: BoostRecord;
  tlvRecords: TlvRecord[];
}

function generateUUID(): string {
  if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Encodes the Boostagram metadata and optional Feed GUID into sorted TLV records.
 */
export function encodeV4VTlvs(options: {
  boostRecord: BoostRecord;
  feedGuid?: string;
  customKey?: number;
  customValue?: string;
  extraTlvs?: Record<number, Uint8Array | string>;
}): TlvRecord[] {
  const encoder = new TextEncoder();
  const records: TlvRecord[] = [];

  // 1. Key 7629169: Boostagram JSON string
  const boostJson = JSON.stringify(options.boostRecord);
  records.push({
    key: 7629169,
    value: encoder.encode(boostJson),
  });

  // 2. Key 7629175: Podcast Index feed GUID
  if (options.feedGuid) {
    records.push({
      key: 7629175,
      value: encoder.encode(options.feedGuid),
    });
  }

  // 3. Custom keys (e.g. split routing keys)
  if (options.customKey !== undefined && options.customValue !== undefined) {
    records.push({
      key: options.customKey,
      value: encoder.encode(options.customValue),
    });
  }

  // 4. Extra TLVs
  if (options.extraTlvs) {
    for (const [keyStr, val] of Object.entries(options.extraTlvs)) {
      const key = parseInt(keyStr, 10);
      if (isNaN(key)) continue;
      
      const value = typeof val === "string" ? encoder.encode(val) : val;
      records.push({ key, value });
    }
  }

  // Deduplicate and sort by key in ascending order (LDK requirement)
  const dedupedMap = new Map<number, Uint8Array>();
  for (const rec of records) {
    dedupedMap.set(rec.key, rec.value);
  }

  const sortedRecords: TlvRecord[] = [];
  const sortedKeys = Array.from(dedupedMap.keys()).sort((a, b) => a - b);
  for (const key of sortedKeys) {
    sortedRecords.push({
      key,
      value: dedupedMap.get(key)!,
    });
  }

  return sortedRecords;
}

/**
 * Calculates micropayment splits and builds the corresponding BoostRecords and TLVs.
 */
export function calculateSplits(options: {
  destinations: SplitDestination[];
  amountSats: number;
  boostRecordTemplate: Omit<BoostRecord, "boost_uuid" | "uuid" | "value_msat_total">;
  feedGuid?: string;
}): SplitResult[] {
  const { destinations, amountSats, boostRecordTemplate, feedGuid } = options;
  if (destinations.length === 0) {
    return [];
  }

  // Guard the split math against malformed (feed-derived) inputs. Without these,
  // a zero total → `Math.floor(amount * share / 0)` = NaN on every recipient, and a
  // negative share → the last recipient's `amount - allocated` OVER-pays (e.g. shares
  // [-1, 2] pays destination B twice the boost). Reject rather than silently mis-allocate money.
  if (!Number.isFinite(amountSats) || amountSats < 0) {
    throw new Error("calculateSplits: amountSats must be a finite, non-negative number");
  }
  if (destinations.some((d) => !Number.isFinite(d.share) || d.share < 0)) {
    throw new Error("calculateSplits: every destination share must be a finite, non-negative number");
  }
  const totalShares = destinations.reduce((sum, d) => sum + d.share, 0);
  if (totalShares <= 0) {
    throw new Error("calculateSplits: total shares must be greater than zero");
  }
  const boostUuid = generateUUID();
  const valueMsatTotal = amountSats * 1000;

  let allocatedSats = 0;
  
  return destinations.map((dest, index) => {
    let destSats = 0;
    if (index === destinations.length - 1) {
      destSats = amountSats - allocatedSats;
    } else {
      destSats = Math.floor((amountSats * dest.share) / totalShares);
      allocatedSats += destSats;
    }

    const uuid = generateUUID();
    const boostRecord: BoostRecord = {
      ...boostRecordTemplate,
      value_msat_total: valueMsatTotal,
      boost_uuid: boostUuid,
      uuid,
    };

    const tlvRecords = encodeV4VTlvs({
      boostRecord,
      feedGuid,
      customKey: dest.customKey,
      customValue: dest.customValue,
    });

    return {
      destinationPubkey: dest.destinationPubkey,
      amountSats: destSats,
      boostRecord,
      tlvRecords,
    };
  });
}
