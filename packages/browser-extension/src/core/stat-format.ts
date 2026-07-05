// Label for the popup's Channels tile: "usable/total" (e.g. "2/2") so a peer being offline is
// visible as "1/2" instead of a healthy-looking bare count.
export function channelCountLabel(total?: number, usable?: number): string {
  if (total === undefined) return "—";
  if (usable === undefined) return String(total);
  return `${usable}/${total}`;
}
