// Boundary-stable error discrimination. SDK errors carry a stable `code` that is ALSO mirrored
// into `.message`, because errors crossing chrome.runtime.sendMessage (offscreen→background→popup)
// are flattened — only `.message` survives. So a code is matched BOTH as an object `.code`
// (in-process frontends) AND as a substring of a flattened message/string (the extension).
// One matcher here; the per-error predicates (isNodeAlreadyRunningError, …) are thin wrappers.

export function errorMatchesCode(e: unknown, code: string): boolean {
  if (e == null) return false;
  if (typeof e === "string") return e.includes(code);
  if (typeof e === "object") {
    if ((e as { code?: unknown }).code === code) return true;
    const msg = (e as { message?: unknown }).message;
    return typeof msg === "string" && msg.includes(code);
  }
  return false;
}
