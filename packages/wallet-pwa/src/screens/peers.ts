import type { AppContext } from "../core/app-context";
import { onControllerEvent } from "../core/events";
import { isDemoMode } from "../core/demo-mode";
import { parsePeerString } from "../core/wallet-config";
import { guardedClick } from "../core/ui-helpers";
import { registerScreen, currentScreen, showScreen, goBack } from "../ui/nav";
import { $, setMsg } from "./util";

export function initPeersScreen(ctx: AppContext): void {
  const controller = ctx.controller;

  async function refresh(): Promise<void> {
    const host = $("peer-list");
    host.innerHTML = "";
    const rows = await controller.listPeers().catch(() => []);
    if (!rows.length) {
      const note = document.createElement("p");
      note.className = "center-note";
      note.textContent = "No peers yet.";
      host.appendChild(note);
      return;
    }
    for (const p of rows) {
      const el = document.createElement("div");
      el.className = "peer-row";
      const dot = document.createElement("span");
      dot.className = `p-dot${p.connected ? "" : " off"}`;
      const main = document.createElement("div");
      main.className = "p-main";
      const name = document.createElement("div");
      name.className = "p-name";
      name.textContent = p.connected ? "Connected" : "Known peer";
      if (p.hasChannel) {
        const tag = document.createElement("span");
        tag.className = "p-tag";
        tag.textContent = "channel";
        name.appendChild(tag);
      }
      const pk = document.createElement("div");
      pk.className = "p-sub";
      pk.textContent = `${p.pubkey.slice(0, 14)}…${p.pubkey.slice(-8)}`;
      main.append(name, pk);
      if (p.address) {
        const addr = document.createElement("div");
        addr.className = "p-sub2";
        addr.textContent = p.address;
        main.appendChild(addr);
      }
      el.append(dot, main);
      host.appendChild(el);
    }
  }

  $("btn-peer-connect").addEventListener("click", () => showScreen("screen-peer-connect"));
  $("btn-peer-add").addEventListener("click", () => showScreen("screen-peer-connect"));

  // guardedClick: a double-tap must not fire duplicate connectPeer dials.
  guardedClick($<HTMLButtonElement>("connect-peer"), async () => {
    let peer;
    try {
      peer = parsePeerString($<HTMLTextAreaElement>("peer-conn").value.trim());
    } catch (e) {
      if (isDemoMode()) {
        // Demo requires no real info: any input becomes a fake peer.
        const raw = $<HTMLTextAreaElement>("peer-conn").value.trim();
        peer = { pubkey: "03" + "ab".repeat(32), host: raw || "demo.peer", port: 9735 };
      } else {
        setMsg("peer-msg", (e as Error).message, "err");
        return;
      }
    }
    setMsg("peer-msg", "Connecting…");
    try {
      await controller.connectPeer(peer.pubkey, peer.host, peer.port);
      setMsg("peer-msg", "Peer connected", "ok");
      setTimeout(() => goBack(), 600);
    } catch (e) {
      setMsg("peer-msg", (e as Error).message, "err");
    }
  });

  registerScreen("screen-peers", { onShow: () => void refresh() });
  registerScreen("screen-peer-connect", { onShow: () => setMsg("peer-msg", "") });
  onControllerEvent(() => {
    if (currentScreen() === "screen-peers") void refresh();
  });
}
