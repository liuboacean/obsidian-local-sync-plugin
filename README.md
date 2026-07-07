<div align="center">

# 🔄 Local Sync

**Zero-cloud · Zero-conflict · Zero‑config — LAN bidirectional sync for Obsidian vaults**

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License"></a>
  <a href="https://obsidian.md"><img src="https://img.shields.io/badge/Obsidian-Plugin-7C3AED?logo=obsidian" alt="Obsidian Plugin"></a>
  <img src="https://img.shields.io/badge/version-1.2.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-239%2F239-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/dependencies-3-brightgreen" alt="Dependencies">
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs Welcome">
</p>

---

<p align="center">
  <b>🌐 LAN | 🔒 WSS/TLS | 🤝 CRDT | 📡 UDP | 🔐 PSK</b>
</p>

---

</div>

## ✨ Features

<table>
<tr>
<td width="50%">

**🔗 LAN Direct Sync**
Peer‑to‑peer WebSocket/WSS connection.
Zero cloud dependency — your data stays on your network.

**🤝 Zero‑Conflict CRDT**
Yjs CRDT automatically merges concurrent text edits.
No manual conflict resolution. Ever.

**🔒 TLS Encrypted**
WSS transport with auto‑generated ECDSA P‑256 certificates.
Certificate PIN verification prevents MITM attacks.

**📡 Auto Discovery**
UDP broadcast finds devices on the same LAN.
No IP typing needed.

</td>
<td width="50%">

**🔐 Security First**
PSK challenge‑response authentication.
Path traversal protection against rogue file writes.

**🎯 Selective Sync**
Exclude folders & file types.
Ignore `.trash`, `.tmp`, `node_modules` — your choice.

**🖥️ Cross‑Platform**
macOS (NSFileCoordinator aware)
Linux (writeFile + chmod)  
Windows (write + lock‑retry)

**🔌 Zero Config**
Install, set IP (or auto‑discover), and go.
Certificates auto‑generate on first launch.

</td>
</tr>
</table>

---

## 🚀 Quick Start

### Installation

> 📁 Plugin ID: `local-sync` · Folder: `your-vault/.obsidian/plugins/local-sync/`

1. **Download** the latest release from the [Releases page](https://github.com/liuboacean/obsidian-local-sync-plugin/releases)
2. Copy `main.js` + `manifest.json` + `styles.css` to `your-vault/.obsidian/plugins/local-sync/`
3. Open Obsidian → ⚙️ **Settings** → **Community plugins** → **Enable** `Local Sync`

### Usage

<table>
<tr>
<th>Step</th>
<th>Action</th>
</tr>
<tr>
<td>1️⃣</td>
<td>Open ⚙️ **Settings** → **Local Sync**</td>
</tr>
<tr>
<td>2️⃣</td>
<td>Enter the **other device's IP** in "Target Address"</td>
</tr>
<tr>
<td>3️⃣</td>
<td>Click **Connect**</td>
</tr>
<tr>
<td>4️⃣</td>
<td>🟢 Status bar turns green — files are syncing!</td>
</tr>
</table>

> **💡 Pro tip:** On the same subnet? Enable **UDP discovery** for zero‑config auto‑connect.  
> **🔒 TLS** is on by default with auto‑generated ECDSA P‑256 certificates.

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────┐
│              UI Layer                            │
│  SettingTab / ConflictModal / StatusBar          │
│  └─ TLS settings, fingerprint display, reset     │
├──────────────────────────────────────────────────┤
│           Service Layer                          │
│  SyncEngine + CrdtEngine(Yjs) + ConflictDetector │
├──────────────────────────────────────────────────┤
│         Discovery Layer                          │
│  UDP broadcast + QR pairing (desktop↔mobile)     │
├──────────────────────────────────────────────────┤
│          Security Layer                          │
│  TLS encryption + PSK auth + path validation     │
│  └─ CertManager (ECDSA P‑256, auto‑generate)     │
├──────────────────────────────────────────────────┤
│       Network & IO Layer                         │
│  WebSocket(WSS/WS) + chokidar + OsWriter         │
│  └─ http/https dual‑protocol server              │
└──────────────────────────────────────────────────┘
```

### Module Overview

| Layer | Module | Responsibility |
|-------|--------|---------------|
| 🔒 **Security** | `cert-manager.ts` | ECDSA P‑256 certificate lifecycle (generate/load/reset) |
| 🔒 **Security** | `auth-handshake.ts` | PSK challenge‑response authentication |
| 🔒 **Security** | `path-validator.ts` | Path traversal protection |
| 🌐 **Network** | `connection-manager.ts` | WebSocket/WSS server/client/duplex + TLS fallback |
| 🌐 **Network** | `protocol.ts` | Message serialization protocol |
| 🔄 **Sync** | `sync-engine.ts` ⭐ | Sync orchestration & file state tracking |
| 🔄 **Sync** | `crdt-engine.ts` ⭐ | Yjs CRDT auto‑merge for text files |
| 🔄 **Sync** | `conflict-detector.ts` | Binary‑only conflict detection |
| 🔄 **Sync** | `initial-sync.ts` | Two‑phase initial sync (manifest → transfer) |
| 📡 **Discovery** | `discovery-manager.ts` | UDP broadcast device discovery |
| 📂 **IO** | `file-watcher.ts` | Chokidar‑based file change detection |
| 📂 **IO** | `os-writer.ts` | Platform‑aware file writing (macOS/Linux/Win) |
| 🖥️ **UI** | `setting-tab.ts` | Settings panel with 6 configuration sections |
| 🖥️ **UI** | `sync-status-bar.ts` | Status bar indicators |
| 🖥️ **UI** | `conflict-resolver.ts` | Binary file conflict resolution dialog |

---

## 🔄 How It Works

### Sync Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Initial Sync                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Device A ── FILE_LIST_BATCH (manifest, 100 files/batch) ──→ Device B │
│                ←── FILE_LIST_ACK (missing + different) ──────────┤  │
│                ── FILE_RESPONSE (missing files, 10 concurrent) ──→   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Incremental Sync                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  File change detected                                                │
│      ├── TEXT (.md/.txt/.canvas) → CRDT incremental update          │
│      └── BINARY (.png/.pdf/.zip) → Full file transfer               │
│                                                                     │
│  Both paths: protected by recentlyPushed(2s) + originDeviceId       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### TLS Handshake

```
Client (WSS)                  Server (WSS)
     │                            │
     │──── wss://connect ──────→│  TLS 1.2/1.3 handshake
     │←── TLS established ─────│  Transport encrypted
     │                            │
     │── cert-fingerprint ────→│  Exchange SHA‑256 fingerprints
     │←── cert-fingerprint-ack─│  PIN verification
     │                            │
     │── PSK challenge ───────→│  Inside encrypted channel
     │←── authenticated ──────│
     │                            │
     │── sync data (encrypted) →│  All traffic protected
```

### Conflict Resolution

| File Type | Strategy |
|-----------|----------|
| 📝 **.md / .txt / .canvas** | Yjs CRDT auto‑merge — no user intervention needed |
| 🖼️ **.png / .pdf / .zip** | Detected → User prompted to keep local / remote / both |

### Synchronization Safeguards

| Mechanism | Purpose |
|-----------|---------|
| `recentlyPushed` (2s TTL) | Prevents sync loop |
| `originDeviceId` | Ignores changes originated from self |
| Debounce (500ms) | Avoids redundant sync on rapid saves |
| UUID dedup | Prevents duplicate message processing |
| Heartbeat (120s ping/pong) | Detects dead connections |
| Exponential backoff (1s→60s) | Smart reconnection |
| Version tracking | Discards stale file versions |
| Pending queue | Buffers changes when offline, flushes on reconnect |

---

## 🔒 TLS Encryption (v1.1.0)

| Feature | Description |
|---------|-------------|
| **Protocol** | WSS (WebSocket Secure) — TLS 1.2/1.3 |
| **Certificate** | ECDSA P‑256 self‑signed, auto‑generated on first launch |
| **Storage** | `~/.obsidian-sync/certs/cert.pem` + `key.pem` |
| **Validation** | SHA‑256 fingerprint exchange + PIN code verification |
| **Fallback** | Automatic downgrade to plain WS (configurable) |
| **Dependencies** | **Zero** — all Node.js built‑ins (`crypto`, `tls`, `http`, `https`) |

> No CA needed. No OpenSSL setup. No external dependencies.
> Just works — with or without TLS.

---

## 🆕 What's New in v1.2.0

- **🔍 Sync History Viewer — Category Filters**: Filter the sync log by log level (Debug / Info / Success / Warning / Error) and by event type (file pushed / connected / sync completed …). Combines with existing path, date, and quick filters via **AND**.
- **🌐 Full Log Localization (incl. DEBUG)**: All log levels are now Chinese, including the previously‑English DEBUG diagnostics (32 `debugLog` calls translated). Technical tokens (WS / WSS / TLS / UDP / CRDT / port / deviceId) and prefixes (`[ObsSync]` / `[Obsidian Local Sync]`) are preserved.
- **📝 Diff Preview**: Preview text/Markdown differences before they sync, powered by `diff-preview-modal.ts` + `diff-preview-service.ts`.
- **📈 Quality**: Build & type‑check clean; test suite grows to **239 passing** (incl. 10 new filter unit tests). Zero breaking changes; `minAppVersion` stays 1.6.6.

---

## 🔍 Security & Review Notes

This plugin intentionally uses a few APIs that trigger Obsidian's automated review warnings. Each is required for the plugin's core LAN‑sync function and is scoped as tightly as possible:

- **Direct filesystem access (`fs`)** — *By design.* A sync plugin must read and write the files it synchronizes, which live **outside** the Obsidian vault. Access is limited to (a) the user‑configured sync paths and (b) the plugin's own data directory `~/.obsidian-sync/` (logs, CRDT snapshots, TLS certs). It never touches unrelated files.
- **System identity (`os.networkInterfaces`, `os.homedir`)** — Used only for LAN peer discovery and to locate the plugin data dir. The plugin does **not** call `os.hostname()` or `os.userInfo()`, and no longer reads identity‑related environment variables (replaced `process.env.HOME/USERPROFILE` with `os.homedir()`). The device identifier is a randomly generated UUID, not derived from machine identity.
- **`document` → `activeDocument`** — *Fixed.* All DOM creation in the sync‑history view now uses Obsidian's `activeDocument` global for popout‑window compatibility.
- **`diff` dependency advisory (GHSA‑73rr‑hh4g‑fpgx)** — *Not affected.* The dependency is `diff@^7.0.0` (resolved **7.0.0**); `npm audit` reports **0 vulnerabilities**. The advisory only affects earlier `diff` versions.

---

## 📊 Project Stats

| Metric | Value |
|--------|-------|
| 📁 Source Files | **26** `.ts` files, ~9,900 lines |
| 🧪 Tests | **239** passing (unit + integration + E2E) |
| ⏱️ Test Duration | ~1 second |
| 📦 Build Output | Single `main.js` (~620KB) |
| 🔗 External Deps | `ws` · `chokidar` · `yjs` (all bundled) |
| 🖥️ Platforms | macOS ✅ · Linux ✅ · Windows ✅ |
| 🔒 TLS Deps | **Zero** (all Node.js built‑in) |
| 🏷️ Latest | **v1.2.0** — Sync history filters, log i18n, diff preview |

---

## 🛠️ Development

```bash
# Clone & build
git clone https://github.com/liuboacean/obsidian-local-sync-plugin.git
cd obsidian-local-sync-plugin
npm install
npm run build     # Production build (main.js)
npm run dev       # Watch mode (for Hot Reload plugin)
npm test          # Run all 239 tests

# Quick local test with two vaults:
cp main.js manifest.json styles.css /path/to/vault-a/.obsidian/plugins/local-sync/
cp main.js manifest.json styles.css /path/to/vault-b/.obsidian/plugins/local-sync/
# Open both vaults in Obsidian, enable plugin, connect
```

---

## 📋 Changelog

| Version | Date | Highlights |
|:-------:|:----:|-----------|
| **1.2.0** | Jul 7, 2026 | ✅ Sync history viewer with category filters, full DEBUG log i18n, diff preview, 239 tests |
| **1.1.0** | Jul 2, 2026 | ✅ TLS encryption (WSS), ECDSA P‑256 certs, 148 tests |
| 1.0.9 | Jul 2, 2026 | Obsidian community review fixes |
| 1.0.8 | Jul 2, 2026 | Release format fix |
| 1.0.7 | Jul 2, 2026 | Initial release, 131 tests |

---

## 🗺️ Roadmap

- [x] Yjs CRDT auto‑merge
- [x] PSK auth + path security
- [x] UDP auto‑discovery
- [x] Cross‑platform file writer
- [x] **TLS encryption (WSS)** ← v1.1.0
- [ ] Mobile client support (P2)
- [x] Sync history viewer (P2)
- [x] Diff preview before sync (P2)

---

## 🤝 Contributing

PRs are welcome! Check the [issues](https://github.com/liuboacean/obsidian-local-sync-plugin/issues) for areas to contribute.

## 📄 License

MIT © 2026 Obsidian Local Sync Team

---

<div align="center">
  
**Made with ❤️ for the Obsidian community**

</div>
