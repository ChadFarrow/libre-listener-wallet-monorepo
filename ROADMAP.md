# Roadmap — Libre Listener Wallet

This is the **forward-looking** roadmap: where the project goes after the initial build.

The original build checklist — [`ai/reference/this-monorepo/libre-listener-wallet-roadmap.md`](ai/reference/this-monorepo/libre-listener-wallet-roadmap.md)
— is fully complete and now serves as the historical record of Phase 0. This document picks up from there.

## Where we are

The core wallet is **experimental but real**: an LDK-WASM node runs entirely in the browser/PWA
sandbox, opens channels via LSPS1/LSPS2, sends V4V boosts as keysend with bLIP-10 TLVs, is controllable
over NWC (NIP-47), wakes offline PWAs via the push gateway, and has been proven end-to-end on regtest
and — for funding, sending, receiving, and force-close recovery — on **mainnet**. It remains
non-custodial by construction (see [`CUSTODY.md`](CUSTODY.md)): no component the app developer runs can
read keys or move funds.

What's left is the gap between "feature-complete against its own build checklist" and "genuinely usable
by a non-technical person in production." The phases below chart that path. Sequencing is by
**dependency and effort**, not calendar dates — each phase's "Why now" explains its placement.

> **Guardrails are non-negotiable across every phase.** Absolute key isolation, the zero-custody
> gateway, storage-contract invariants, and `instanceof`-based LDK event dispatch must survive all of
> this work. See [`ai/contracts/guardrails.md`](ai/contracts/guardrails.md) and the storage-contract
> guard in [`CLAUDE.md`](CLAUDE.md).

---

## Phase 0 — Foundation *(shipped)*

**Goal:** A working, non-custodial browser Lightning wallet for the V4V ecosystem, proven end-to-end.

Everything in the six original milestones is done and validated in practice:

- Monorepo + Turborepo + regtest Docker stack; Vitest/jsdom/MSW test harness.
- LDK-WASM node engine with Esplora chain sync and IndexedDB (network-namespaced) persistence.
- Multi-tier onboarding: LSPS2 JIT channels (Tier 1) and LSPS1 capacity leases (Tier 2).
- V4V payments: keysend, bLIP-10 boostagram TLVs (`7629169` / `7629175`), multi-recipient splits.
- NWC / NIP-47 portability with spending limits and a pairing dashboard.
- Offline background wake-ups via the stateless push gateway + PWA service worker.
- Hardened by real debugging: encrypted backup/recovery, force-close on-chain sweeper, network-scoped
  storage with a contract-test guard.

Detailed record: [`ai/reference/this-monorepo/libre-listener-wallet-roadmap.md`](ai/reference/this-monorepo/libre-listener-wallet-roadmap.md).

---

## Phase 1 — Trustworthy Baseline

**Goal:** Make the project honest about its state and safe to point real users at — the highest-trust,
lowest-effort work first.

**Why now:** These items are cheap, unblock everything downstream, and close the credibility gap
between the mainnet-proven reality and the "not yet functional" framing.

- **Truthful status pass** — bring the README and status banners in line with what actually works
  (and what genuinely doesn't), so the warnings are accurate rather than blanket.
- **Real independent LSP integration** — replace the temporary own-node test stand-in with vetted,
  independent commercial LSPs in a hosted `.well-known/lightning-providers.json`, and complete the
  LSP money-transmission legal review flagged in [`CUSTODY.md`](CUSTODY.md). (The dev `libre-lsps2-server`
  stays regtest-only.)
- **Surface the passphrase-backup path** — the SDK already supports the v2 dual passphrase/seed
  backup; expose it in the app so users aren't limited to seed-only recovery.
- **Finish the `main.ts` modularization** — extract the remaining inline handlers into feature modules,
  paying down the tech debt before the UI and extension work builds on top of it.

---

## Phase 2 — Wider Reach

**Goal:** Get the wallet into more surfaces, and make those surfaces genuinely easy for
non-technical people.

**Why now:** A working, trustworthy core is worth distributing. The browser extension already exists
(built on the `claude/browser-extension-architecture-hxg0n4` branch: MV3, a standard `window.webln`
provider, Chrome/Brave) — landing it is high-leverage reach.

- **Browser extension + WebLN** — merge and ship the extension so any web app that detects
  `window.webln` (or a UI like Bitcoin Connect) can use the wallet with zero per-app integration.
  Add Firefox support (a listed follow-up).
- **Simple-and-easy bar for the extension** — the extension is a first-run touchpoint for
  non-technical users, so its UX must clear a real usability bar, not just be wired up: frictionless
  first-run setup, one-tap per-origin approval with clear spending limits, a guided seed-backup prompt,
  and plain-language errors. The Phase 3 UI/UX principles apply to the extension's popup/approval
  surfaces as much as to the web app.
- **BIP39 word seeds** — move from 64-hex seeds to human-writable word seeds: friendlier backup and
  the portability groundwork mobile and cross-app reuse will lean on.

---

## Phase 3 — Product UI Redesign

**Goal:** Turn the example app from a developer "playground" into a **polished, user-facing wallet**.

**Why now:** Reach (Phase 2) brings real users; they need a real product, not a feature-test console.
The HTML is already decoupled from the logic (handlers bind by element `id`), so this is a
presentation-layer redesign, not a rewrite of wallet behavior.

- **Clean information hierarchy** — balance, receive, send, and boost front-and-center; protocol/debug
  panels demoted or hidden behind an advanced view.
- **Guided onboarding & backup flow** — a calm, linear path from "create/restore wallet" through
  verified backup, instead of a wall of cards.
- **Mobile-first, responsive layout** — the primary target is a phone browser / PWA.
- **Consistent visual language** — shared components and styling that the browser-extension surfaces
  reuse, so the wallet feels like one product everywhere.

---

## Phase 4 — Protocol Depth

**Goal:** Make routing robust enough that arbitrary V4V payments reliably find a path.

**Why now:** Once real users send boosts to arbitrary artists, single-hop and snapshot-only graphs
become the limiting factor. This is deeper Lightning work, best done after the product surface is stable.

- **Richer network graph / live P2P gossip** — move beyond the RGS-proxy snapshot (today gossip is
  disabled via `IgnoringMessageHandler`), so multi-hop no longer depends on the channel peer having a
  public announced path.
- **Tier 3 Native Liquidity Ads** — the sovereign gossip-rebalancing tier specified in the
  architecture but never built (BOLT 2 liquidity ads, on-demand RGS, dual-funded L1, lease terms),
  completing the multi-tier liquidity engine.

---

## Phase 5 — Native Mobile (Target B)

**Goal:** A native mobile wrapper so the wallet runs reliably in the background on phones.

**Why now:** The largest-effort reach item, and it depends on the earlier UX, seed, and storage work.
Browser background execution is inherently constrained; native unlocks proper OS-level background
runtime and push.

- **React Native / Flutter wrapper** embedding native LDK C/Rust bindings.
- **OS-level background execution and push wake-ups** for NWC while the app is closed.
- **Native storage + socket adapters** injected through the SDK's existing platform-abstraction
  interfaces (`SecureStorageProvider`, `WebSocketStreamProvider`) — the SDK core stays unchanged.

---

## Phase 6 — Ecosystem & Hardening *(ongoing)*

**Goal:** Support the wider V4V ecosystem and keep the project maintainable and auditable over time.

**Why now:** Continuous work that runs alongside the phases above rather than blocking them.

- **Shared cross-app storage helper** — package the network-namespaced storage layer so v4vmusic.com
  and other apps reuse it instead of reimplementing it.
- **External security audit** — an independent review of the key-isolation and custody guarantees.
- **Release hygiene** — a CHANGELOG, issue templates, and versioned releases.
- **Observability** — lightweight, privacy-preserving diagnostics for the hosted infrastructure
  (bridge, push gateway, RGS proxy).

---

*Guardrails reminder:* every phase must preserve absolute key isolation, the zero-custody gateway, the
storage-contract invariants, and `instanceof`-based LDK event dispatch. See
[`ai/contracts/guardrails.md`](ai/contracts/guardrails.md) and [`CLAUDE.md`](CLAUDE.md).
