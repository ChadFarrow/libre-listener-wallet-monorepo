// The always-on diagnostics tap (spec: 2026-07-11-diag-log-design.md). Wraps console.*
// (originals always called through — the cable Web Inspector sees everything unchanged),
// captures uncaught errors/rejections, and stamps page-lifecycle events — the timestamps
// that make overnight iOS debugging possible. Module-level singleton by design: console
// is global, so its tap is too (same shape as core/events.ts).
import { DiagBuffer, formatDiagLines, type DiagEntry, type DiagLevel, DEFAULT_DIAG_POLICY } from "./diag-log";
import { DiagStore } from "./diag-store";

const buffer = new DiagBuffer();
const store = new DiagStore();
let installed = false;
let recording = false; // reentrancy guard: nothing inside the tap may record
let flushTimer: ReturnType<typeof setInterval> | undefined;
let warnedStoreBroken = false;

const original = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function argToString(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return `${a.message}`;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
}

function record(level: DiagLevel, args: unknown[]): void {
  if (recording) return;
  recording = true;
  try {
    const due = buffer.add(level, args.map(argToString).join(" "), Date.now());
    if (due) void flush();
  } catch {
    /* diagnostics must never break the app */
  } finally {
    recording = false;
  }
}

async function flush(): Promise<void> {
  const batch = buffer.drainUnflushed();
  if (batch.length === 0) return;
  try {
    await store.append(batch, DEFAULT_DIAG_POLICY.cap);
  } catch (e) {
    if (!warnedStoreBroken) {
      warnedStoreBroken = true;
      original.warn("[Diag] persist failed (recording continues in memory):", (e as Error)?.message ?? e);
    }
  }
}

export function installDiagTap(): void {
  if (installed) return;
  installed = true;

  console.log = (...args: unknown[]) => {
    original.log(...args);
    record("log", args);
  };
  console.warn = (...args: unknown[]) => {
    original.warn(...args);
    record("warn", args);
  };
  console.error = (...args: unknown[]) => {
    original.error(...args);
    record("error", args);
  };

  window.addEventListener("error", (e) => record("error", [`uncaught: ${e.message}`]));
  window.addEventListener("unhandledrejection", (e) =>
    record("error", [`unhandledrejection: ${argToString((e as PromiseRejectionEvent).reason)}`]),
  );

  // Lifecycle stamps — the backbone of overnight diagnosis. hidden/pagehide flush
  // immediately: issued IndexedDB puts complete even if the page is killed right after.
  document.addEventListener("visibilitychange", () => {
    record("event", [`visibilitychange ${document.visibilityState}`]);
    if (document.visibilityState === "hidden") void flush();
  });
  window.addEventListener("pagehide", (e) => {
    record("event", [`pagehide persisted=${(e as PageTransitionEvent).persisted}`]);
    void flush();
  });
  window.addEventListener("pageshow", (e) => record("event", [`pageshow persisted=${(e as PageTransitionEvent).persisted}`]));
  document.addEventListener("freeze", () => record("event", ["freeze"]));
  document.addEventListener("resume", () => record("event", ["resume"]));
  window.addEventListener("online", () => record("event", ["online"]));
  window.addEventListener("offline", () => record("event", ["offline"]));

  // Time-based batch flush (the 2s path); count-based flushes happen inline in record().
  flushTimer = setInterval(() => {
    if (buffer.flushDue(Date.now())) void flush();
  }, 2000);
  void flushTimer; // interval runs for the page's lifetime by design
}

/** Full export body: persisted history + the in-memory tail, oldest first. */
export async function diagExportText(): Promise<string> {
  await flush(); // fold the tail in first so the file is complete
  let history: DiagEntry[] = [];
  try {
    history = await store.readAll();
  } catch {
    history = buffer.snapshot(); // store broken — export what memory has
  }
  return formatDiagLines(history);
}

export async function diagStats(): Promise<{ count: number; bytes: number }> {
  try {
    const entries = await store.readAll();
    const bytes = entries.reduce((n, e) => n + e.msg.length + 30, 0);
    return { count: entries.length, bytes };
  } catch {
    return { count: buffer.count(), bytes: 0 };
  }
}

export async function diagClear(): Promise<void> {
  buffer.clear();
  try {
    await store.clear();
  } catch {
    /* disposable data */
  }
}

/** Test/handler hook: push the pending batch to the store now. */
export function diagFlushNow(): Promise<void> {
  return flush();
}
