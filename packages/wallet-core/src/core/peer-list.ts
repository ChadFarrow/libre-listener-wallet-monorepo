// Pure combiner for the Peers screen: live connected pubkeys (running node), the
// persisted address book (works stopped), and channel counterparties.

export interface PeerRow {
  pubkey: string;
  address?: string;
  connected: boolean;
  hasChannel: boolean;
}

export function buildPeerRows(input: {
  connected: string[];
  book: Record<string, { host: string; port: number }>;
  channelPeers: string[];
}): PeerRow[] {
  const connected = new Set(input.connected);
  const channels = new Set(input.channelPeers);
  const pubkeys = new Set<string>([...input.channelPeers, ...input.connected, ...Object.keys(input.book)]);
  const rows: PeerRow[] = [...pubkeys].map((pubkey) => {
    const addr = input.book[pubkey];
    return {
      pubkey,
      address: addr ? `${addr.host}:${addr.port}` : undefined,
      connected: connected.has(pubkey),
      hasChannel: channels.has(pubkey),
    };
  });
  // Channel peers first (the ones that matter), then live connections, then the rest.
  return rows.sort(
    (a, b) => Number(b.hasChannel) - Number(a.hasChannel) || Number(b.connected) - Number(a.connected),
  );
}
