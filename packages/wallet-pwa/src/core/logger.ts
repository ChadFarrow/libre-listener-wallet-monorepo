// Console-log terminal: appendLog (capped buffer), the severity filter, and the
// clear/copy/filter controls. Self-contained — owns its DOM refs.
export type LogType = "info" | "warn" | "error" | "system" | "ldk-info" | "ldk-debug" | "ldk-trace";

const terminalContent = document.getElementById("terminal-content") as HTMLDivElement;
const logFilter = document.getElementById("log-filter") as HTMLSelectElement;

const MAX_LOG_LINES = 500;

function matchesFilter(el: HTMLDivElement, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "error") return el.classList.contains("error");
  if (filter === "warn") return el.classList.contains("warn");
  if (filter === "info") {
    return el.classList.contains("info") || el.classList.contains("system") || el.classList.contains("ldk-info");
  }
  return false;
}

export function appendLog(msg: string, type: LogType) {
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  line.innerText = msg;
  // Apply the active filter to just the new line. Re-walking all ≤500 existing
  // lines on every append was O(n²) during LDK trace bursts (1s tick + traces).
  line.style.display = matchesFilter(line, logFilter.value) ? "block" : "none";
  terminalContent.appendChild(line);

  // Cap the buffer so the terminal doesn't grow unboundedly — the 1s event tick +
  // LDK trace output can otherwise accumulate thousands of DOM nodes over a session.
  while (terminalContent.childElementCount > MAX_LOG_LINES) {
    terminalContent.removeChild(terminalContent.firstChild!);
  }

  terminalContent.parentElement!.scrollTop = terminalContent.parentElement!.scrollHeight;
}

/** Re-apply the current filter to every line — used only on filter change. */
export function applyLogFilter() {
  const filter = logFilter.value;
  const lines = terminalContent.querySelectorAll(".log-line");
  lines.forEach((lineNode) => {
    const el = lineNode as HTMLDivElement;
    el.style.display = matchesFilter(el, filter) ? "block" : "none";
  });
}

/** Wire the Clear / Copy All / filter controls. Call once at startup. */
export function initLogControls() {
  const clearLogsBtn = document.getElementById("clear-logs-btn") as HTMLButtonElement;
  const copyLogsBtn = document.getElementById("copy-logs-btn") as HTMLButtonElement;

  clearLogsBtn.addEventListener("click", () => {
    terminalContent.innerHTML = "";
    appendLog("[SYSTEM] Console cleared.", "system");
  });

  copyLogsBtn.addEventListener("click", async () => {
    // Copy every log line (regardless of the active filter) as plain text.
    const lines = Array.from(terminalContent.querySelectorAll(".log-line")).map((el) => el.textContent || "");
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      appendLog(`[SYSTEM] Copied ${lines.length} log lines to clipboard.`, "system");
    } catch (e) {
      appendLog(`[ERROR] Failed to copy logs: ${e instanceof Error ? e.message : e}`, "error");
    }
  });

  logFilter.addEventListener("change", applyLogFilter);
}
