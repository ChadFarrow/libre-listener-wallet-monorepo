// Which backup channel runs. Google Drive, once configured, REPLACES the local auto-download
// (a dated file every state change is redundant next to Drive sync and spams Downloads under
// payment traffic); and mobile never auto-downloads at all — silent repeated downloads are
// hostile or broken in mobile browsers, so Drive is the only backup channel there. Pure so the
// policy is unit-testable; callers pass the live inputs.

export function isMobileUa(ua: string): boolean {
  return /Android|iPhone|iPad|iPod/i.test(ua || "");
}

export function shouldAutoDownload(opts: {
  toggleOn: boolean;
  driveConfigured: boolean;
  mobile: boolean;
}): boolean {
  return opts.toggleOn && !opts.driveConfigured && !opts.mobile;
}
