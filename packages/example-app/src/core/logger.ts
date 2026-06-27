// Console-log terminal: appendLog (capped buffer), the severity filter, and the
// clear/copy/filter controls. Self-contained — owns its DOM refs.
export type LogType = "info" | "warn" | "error" | "system" | "ldk-info" | "ldk-debug" | "ldk-trace";

const terminalContent = document.getElementById("terminal-content") as HTMLDivElement;
const logFilter = document.getElementById("log-filter") as HTMLSelectElement;

const MAX_LOG_LINES = 500;

export function appendLog(msg: string, type: LogType) {
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  line.innerText = msg;
  terminalContent.appendChild(line);

  // Cap the buffer so the terminal doesn't grow unboundedly — the 1s event tick +
  // LDK trace output can otherwise accumulate thousands of DOM nodes over a session.
  while (terminalContent.childElementCount > MAX_LOG_LINES) {
    terminalContent.removeChild(terminalContent.firstChild!);
  }

  terminalContent.parentElement!.scrollTop = terminalContent.parentElement!.scrollHeight;
  applyLogFilter();
}

export function applyLogFilter() {
  const filter = logFilter.value;
  const lines = terminalContent.querySelectorAll(".log-line");
  lines.forEach((lineNode) => {
    const el = lineNode as HTMLDivElement;
    if (filter === "all") {
      el.style.display = "block";
    } else if (filter === "error" && el.classList.contains("error")) {
      el.style.display = "block";
    } else if (filter === "warn" && el.classList.contains("warn")) {
      el.style.display = "block";
    } else if (filter === "info" && (el.classList.contains("info") || el.classList.contains("system") || el.classList.contains("ldk-info"))) {
      el.style.display = "block";
    } else {
      el.style.display = "none";
    }
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
