# Libre Listener Client Playground (`example-app`)

This is a browser-native developer playground designed to test and demonstrate the `@libre/listener-wallet` SDK. It runs a local in-browser **LDK WebAssembly (WASM)** node instance, allowing you to establish peer connections, request JIT channels (LSPS2), and buy inbound capacity (LSPS1) inside a local regtest sandbox.

---

## Architecture Context

* **Browser-WASM Execution:** The wallet's private keys, seed, and channel states remain 100% inside your browser's execution context.
* **WebSocket Bridge:** LDK communicates over TCP, but browsers can only open WebSockets. The app connects to the LSP node via a `websockify` bridge container running locally.
* **Storage Cache:** Wallet states and channels are persisted in browser `localStorage` to test recovering state during cold boots.

---

## Local Setup & Run Guide

### 1. Start the Docker Regtest Cluster
From the root of the monorepo, launch the local blockchain, mock LSP (LND), Esplora indexer, and WebSocket proxy:
```bash
docker compose up -d
```

### 2. Build the Workspace
Build the shared packages and compilation bundles:
```bash
pnpm build
```

### 3. Launch the Vite Development Server
Start the playground application locally:
```bash
pnpm --filter @libre/example-app dev
```
Open the local URL (usually `http://localhost:5173`) in your web browser.

---

## Operations Walkthrough

### Step 1: Initialize the LDK Node
1. Leave the default **LDK Seed** (hex) and the **Esplora Sync URL** (`http://127.0.0.1:3002`).
2. Click **Start Node**.
3. Watch the **Console Logs** at the bottom of the page. LDK will sync with the local regtest block headers. Once booted, the **Status Badge** will turn green (`Running`) and your client's **Node ID** will populate.

### Step 2: Establish LSP Peer Connection
1. Ensure the **LSP Connection String** contains LND's pubkey and the local websockify proxy bridge host/port.
2. Click **Connect Peer**.
3. LDK will complete a Noise protocol handshake over WebSockets. Once connected, the **Peers Connected** counter will update to `1`.

### Step 3: Request an LSPS2 JIT Channel (Onboarding a 0-Sat Balance)
1. In the **LSPS2 card**, set your desired onboarding amount (e.g., `20000` Satoshis) and a description.
2. Click **Request Invoice**.
3. The SDK client queries the LSP API, registers the payment preimage, and returns a standard BOLT11 invoice.
4. **Trigger Payment from Docker:**
   To simulate an external service paying the invoice, run the payment command in your local LND Docker container:
   ```bash
   docker exec libre-lnd lncli --network=regtest payinvoice --force --pay_req <GENERATED_INVOICE>
   ```
5. **Watch JIT Activation:**
   * The LSP captures the payment, detects the JIT request, and opens a channel to your WASM node.
   * LDK fires an `Event_OpenChannelRequest` which your client automatically accepts as a trusted 0-conf channel.
   * LDK fires a `Event_PaymentClaimable` and claims the payment using the local preimage.
   * Mine a block to settle the transactions:
     ```bash
     docker exec libre-bitcoind bitcoin-cli -regtest -rpcuser=libre -rpcpassword=listener generatetoaddress 1 bcrt1qwqp2ru0sx58gpv4fmleuf02wcmu8rs5w93ld6u
     ```

### Step 4: Purchase LSPS1 Inbound Capacity (Leases)
1. In the **LSPS1 card**, enter the capacity amount (e.g., `100000` satoshis).
2. Click **Order Capacity**.
3. The client calls `lsps1.create_order` to lease a channel from the LSP.
4. An invoice representing the channel lease setup fee is generated and displayed. Paying this invoice using LND CLI triggers the LSP to open the requested inbound channel to your node.

---

## Log Filtering
The **Console Logs** panel streams LDK WASM trace information. You can use the drop-down menu in the panel header to filter messages by severity (`All Logs`, `Info`, `Warnings`, `Errors`) to isolate sync or payment routing events.
