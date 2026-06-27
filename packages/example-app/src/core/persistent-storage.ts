// Returns true only if browser storage will survive the session (i.e. NOT a
// private/Incognito window where IndexedDB lives in memory and is wiped on
// close). A wallet created in non-persistent storage can silently lose its seed
// — so creation must be blocked unless this returns true.
//
// Lives in the app layer on purpose: the SDK must never touch `navigator`.
export async function ensurePersistentStorage(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage || !navigator.storage.persist) {
    return false;
  }
  if (await navigator.storage.persisted()) return true;
  return await navigator.storage.persist();
}
