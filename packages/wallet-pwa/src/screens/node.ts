import type { AppContext } from "../core/app-context";
import { onControllerEvent } from "../core/events";
import { AUTO_START_KEY, isAutoStartEnabled } from "@libre/shared";
import { registerScreen, currentScreen } from "../ui/nav";
import { startNodeWithGuards } from "./start-node";
import { $, setMsg, copyText } from "./util";

export function initNodeScreen(ctx: AppContext): void {
  const controller = ctx.controller;
  let running = false;

  async function refresh(): Promise<void> {
    try {
      const s = await controller.getState();
      running = s.running;
      const st = $("node-status");
      st.textContent = s.running ? "Running" : "Stopped";
      st.style.color = s.running ? "var(--accent)" : "var(--warn)";
      $("node-network").textContent = s.network;
      $("node-peers").textContent = s.peers != null ? `${s.peers} connected` : "—";
      $("node-id").textContent = s.nodeId || "(start the node to load)";
      $("node-toggle").textContent = s.running ? "Stop node" : "Start node";
    } catch (e) {
      setMsg("node-msg", (e as Error).message, "err");
    }
  }

  async function startNode(): Promise<void> {
    await startNodeWithGuards(controller, (msg, level) => setMsg("node-msg", msg, level));
    void refresh();
  }

  $("node-toggle").addEventListener("click", () => {
    if (running) {
      void controller
        .stopNode()
        .catch((e) => setMsg("node-msg", (e as Error).message, "err"))
        .then(() => refresh());
    } else {
      void startNode();
    }
  });

  $("copy-node-id").addEventListener("click", () => {
    void (async () => {
      // Only report success for a REAL node id (running node) that actually copied — the display
      // text can be a placeholder, and clipboard writes can reject.
      const s = await controller.getState().catch(() => null);
      if (!s?.nodeId) {
        setMsg("node-msg", "Start the node first — there's no Node ID to copy yet.", "err");
        return;
      }
      if (await copyText(s.nodeId)) setMsg("node-msg", "Node ID copied", "ok");
      else setMsg("node-msg", "Couldn't copy — select the Node ID and copy it manually.", "err");
    })();
  });

  const autoStart = $<HTMLInputElement>("auto-start");
  autoStart.checked = isAutoStartEnabled(localStorage.getItem(AUTO_START_KEY));
  autoStart.addEventListener("change", () => {
    localStorage.setItem(AUTO_START_KEY, autoStart.checked ? "1" : "0");
  });

  // Node name (BOLT7 alias) — what peer nodes display instead of "Unknown". Loaded only on
  // show (never in refresh(), which controller events re-run while typing); applied at start().
  const aliasInput = $<HTMLInputElement>("node-alias");
  async function loadAlias(): Promise<void> {
    try {
      const cfg = await controller.getConfig();
      aliasInput.value = cfg.nodeAlias ?? "";
    } catch {
      /* leave the field as-is; saving still works */
    }
  }
  $("save-node-alias").addEventListener("click", () => {
    void controller
      .setNodeAlias(aliasInput.value)
      .then(() =>
        setMsg(
          "node-alias-msg",
          running ? "Saved — applies when the node restarts" : "Saved",
          "ok"
        )
      )
      .catch((e) => setMsg("node-alias-msg", (e as Error).message, "err"));
  });

  registerScreen("screen-node", {
    onShow: () => {
      void refresh();
      void loadAlias();
      setMsg("node-alias-msg", "");
    },
  });
  onControllerEvent(() => {
    if (currentScreen() === "screen-node") void refresh();
  });
}
