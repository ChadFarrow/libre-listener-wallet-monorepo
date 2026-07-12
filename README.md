# Libre Listener Wallet Monorepo

> [!WARNING]
> **Experimental / active development.** This is a research project exploring several ways to ship a browser-based Lightning wallet. Interfaces, packages, and deployments change often and things break.

> [!CAUTION]
> **Loss of Bitcoin is highly likely.** Do not put in more than you are willing to lose. Use at your own risk.

---

The **Libre Listener Wallet** is a **non-custodial** Bitcoin Lightning wallet built for the Podcasting 2.0 / Value-for-Value (`v4vmusic.com`) ecosystem. It wraps **LDK (Lightning Development Kit) WASM**, keeps node state in IndexedDB, opens just-in-time channels through LSP protocols, and sends V4V "boost" payments as keysend with bLIP-10 TLV metadata.

This repo is an **ongoing experiment, not a finished product.** It probes several parallel ways to run the same wallet engine — as a **PWA**, a **WebLN browser extension**, and a **native Android app** — and the direction is still open. The PWA is the surface getting the most attention right now, but none of the three is "the" blessed client yet.

**On "non-custodial":** the seed, private keys, and unclaimed preimages never leave the client sandbox. A couple of small hosted relays exist to make browser Lightning possible (a WebSocket→TCP bridge and a Nostr push gateway), but **they hold no keys and no funds** — they route blind, encrypted envelopes and proxy bytes. See [`CUSTODY.md`](CUSTODY.md) for the full custody model.

## How it works (the intended flow)

1. **Onboarding** — the app generates a BIP39 seed locally and initializes an LDK WASM node (state persisted in IndexedDB). You have a sovereign wallet with a `0 sat` balance.
2. **Funding** — you request an invoice; with no channel yet, the wallet gets inbound liquidity from an LSP (LSPS2 JIT interception, or an LSPS1-REST channel purchase).
3. **Liquidity** — the LSP opens a channel to the browser node and the channel becomes spendable.
4. **V4V boosts** — playing music/podcasts, "Boost" constructs a keysend payment with bLIP-10 metadata (TLV `7629169` boost data, `7629175` feed GUID), signed locally and routed instantly.

## Workspace packages

A TypeScript monorepo managed by `pnpm` + Turborepo. Every package's own README is current — follow the links for detail.

**Apps (parallel client experiments)**
| Package | What it is |
|---|---|
| [`packages/wallet-pwa`](packages/wallet-pwa) (`@libre/wallet-pwa`) | Installable, mobile-first PWA that hosts the LDK node in one persistent page. **Most active surface.** |
| [`packages/browser-extension`](packages/browser-extension) (`@libre/browser-extension`) | MV3 extension (Chrome/Brave) that injects a `window.webln` provider so any web app drives the wallet. |
| [`packages/android-app`](packages/android-app) (`@libre/android-app`) | Capacitor wrapper of the PWA; a foreground service keeps the node alive in the background. Play-Services-free / GrapheneOS-friendly. |
| [`packages/example-app`](packages/example-app) (`@libre/example-app`) | Vite dev playground/testbed for the SDK against a local regtest sandbox. |

**Libraries**
| Package | What it is |
|---|---|
| [`packages/libre-listener-wallet`](packages/libre-listener-wallet) (`@libre/listener-wallet`) | The core client SDK wrapping LDK WASM — peers, channels, payments, NWC, encrypted backup/recovery. |
| [`packages/shared`](packages/shared) (`@libre/shared`) | Protocol types, Zod schemas, and pure calc utilities shared by the SDK and gateway (single source of truth for LSPS/NWC shapes). |

**Servers (hold no keys)**
| Package | What it is |
|---|---|
| [`packages/libre-nwc-push-gateway`](packages/libre-nwc-push-gateway) (`@libre/nwc-push-gateway`) | Stateless Nostr→Web Push relay that wakes offline PWAs for NWC requests; also a CORS-enabled RGS gossip proxy. |
| [`ws-bridge`](ws-bridge) (`@libre/ws-bridge`) | Allowlisted WebSocket→TCP bridge so a browser node (no raw TCP) can reach Lightning peers. |

**Dev / regtest tools**
| Package | What it is |
|---|---|
| [`packages/libre-lsps2-server`](packages/libre-lsps2-server) (`@libre/lsps2-server`) | Regtest-only dev LSP with real HTLC-interception JIT channel opens. |
| [`packages/libre-lsps1-mock-server`](packages/libre-lsps1-mock-server) (`@libre/lsps1-mock-server`) | Mock mainnet LSPS1-REST provider for building the "get a channel from an LSP" flow offline (no node, money, or docker). |

## Deployments & live URLs

The one place to see what's live and where it deploys from.

| Surface | Live URL | Deploys from |
|---|---|---|
| PWA (most active) | `https://libre-wallet-pwa.pages.dev` | `.github/workflows/deploy-wallet-pwa.yml` → Cloudflare Pages (gated on repo var `CLOUDFLARE_DEPLOY_ENABLED`) |
| Example-app playground | `https://chadfarrow.github.io/libre-listener-wallet-monorepo/` | `.github/workflows/deploy-pages.yml` → GitHub Pages |
| NWC push gateway (+ RGS proxy) | `https://nwc-push-gateway-production.up.railway.app` | Railway, root `railway.json` |
| ws-bridge | `wss://ws-bridge-production-9e2f.up.railway.app` | Railway, `ws-bridge/railway.json` |
| Browser extension (rolling build) | GitHub Releases → `browser-extension-latest` asset | `.github/workflows/release-extension-latest.yml` |
| Android APK (signed) | GitHub Releases | Built on a Mac per [`packages/android-app/README.md`](packages/android-app/README.md) |

> Pinned rollback: the pre-redesign PWA UI stays reachable at `https://62281737.libre-wallet-pwa.pages.dev`.

## Developer & AI-agent orientation

- The authoritative contracts and design docs live in [**`ai/`**](ai/reference/this-monorepo/libre-listener-wallet-roadmap.md) — read the roadmap and the `ai/contracts/` rules before non-trivial changes.
- [**`ai/prompts/primer-prompt.md`**](ai/prompts/primer-prompt.md) covers the security constraints, ports, and testing rules.
- [`CLAUDE.md`](CLAUDE.md) is the living, detailed engineering log (architecture, gotchas, invariants).

## Quick start

```bash
pnpm install                 # install workspace deps
pnpm build                   # turbo: build shared, then SDK + servers
pnpm test                    # turbo: vitest across all packages
```

**Run the PWA (the main app):**
```bash
pnpm --filter @libre/wallet-pwa dev     # http://127.0.0.1:5173  (append ?demo for a zero-setup fake wallet)
```

**Run the SDK playground:**
```bash
pnpm --filter @libre/example-app dev    # http://localhost:5173
```

**Local regtest sandbox** (for integration tests; all ports bound to `127.0.0.1`):
```bash
docker compose up -d         # bitcoind, electrs (esplora), lnd LSP, websockify bridge
```

**Push gateway daemon:**
```bash
pnpm --filter @libre/nwc-push-gateway dev    # port 3001
```

See [`how-to-deploy.md`](how-to-deploy.md) and [`how-to-integrate.md`](how-to-integrate.md) for more.

## License

[MIT](LICENSE).
