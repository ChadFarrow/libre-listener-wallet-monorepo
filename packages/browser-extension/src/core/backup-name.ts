// Filename for a DOWNLOADED backup (manual or auto). This is a LOCAL label only — restore-from-file
// reads the envelope contents, not the name, and the pinned Drive filename is separate. Includes the
// envelope format version + a to-the-second timestamp so saved backups are unique and sort by newest.
export function downloadBackupName(network: string, envelope: string, now: Date): string {
  let ver = "";
  try {
    const parsed = JSON.parse(envelope);
    ver = `-v${parsed.v ?? parsed.version ?? "?"}`;
  } catch {
    /* no version tag if the envelope isn't parseable */
  }
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `libre-wallet-backup-${network}${ver}-${stamp}.json`;
}
