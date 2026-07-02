<div align="center">

# 🔄 Local Sync

**Zero-cloud, zero-conflict, zero-config — LAN bidirectional sync for Obsidian vaults**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-Plugin-7C3AED?logo=obsidian)](https://obsidian.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)]()

---

https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000

</div>

---

## ✨ Features

- **🔗 LAN Direct Sync** — Peer-to-peer WebSocket connection, zero cloud dependency
- **🤝 Zero-Conflict** — Yjs CRDT automatically merges text edits, no manual conflict resolution
- **🔐 Security First** — PSK challenge-response authentication + path traversal protection
- **📡 Auto Discovery** — UDP broadcast finds devices on the same LAN
- **📱 Mobile Ready** — Desktop as server, mobile as client (via QR code pairing)
- **🎯 Selective Sync** — Exclude folders / file types as needed
- **🖥️ Cross-Platform** — macOS, Linux, Windows — fully compatible
- **🔌 Zero Config** — Install, set IP (or auto-discover), and go

---

## 🚀 Quick Start

### Installation

1. **Download** from [Releases](https://github.com/liuboacean/obsidian-local-sync-plugin/releases)
2. Copy `main.js`, `manifest.json`, `styles.css` to `your-vault/.obsidian/plugins/obsidian-local-sync/`
3. Open Obsidian → **Settings** → **Community plugins** → Enable **Obsidian Local Sync**

### Usage

1. Open **Settings** → **Obsidian Local Sync**
2. Set **Target Address** to the other device's IP
3. Click **Connect**
4. ✅ Status bar turns green — files are syncing!

> **Pro tip:** On the same subnet? Enable UDP discovery for zero-config auto-connect.

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────┐
│  UI Layer (SettingTab / ConflictModal / StatusBar)
├──────────────────────────────────────────────┤
│  Service Layer (SyncEngine + CRDT + ConflictDetector)
├──────────────────────────────────────────────┤
│  Discovery Layer ── UDP broadcast + QR pairing
├──────────────────────────────────────────────┤
│  Security Layer ── PSK auth + path validation
├──────────────────────────────────────────────┤
│  Network & IO ── WebSocket + chokidar + OsWriter
└──────────────────────────────────────────────┘
```

| Layer | Module | Responsibility |
|-------|--------|---------------|
| **UI** | `setting-tab.ts` | 6-section settings panel |
| **UI** | `sync-status-bar.ts` | Status bar with connection/sync indicators |
| **UI** | `conflict-resolver.ts` | Binary file conflict resolution dialog |
| **Service** | `sync-engine.ts` ⭐ | Sync orchestration & file state tracking |
| **Service** | `crdt-engine.ts` ⭐ | Yjs CRDT auto-merge for text files |
| **Service** | `conflict-detector.ts` | Binary-only conflict detection |
| **Service** | `initial-sync.ts` | Two-phase initial sync (manifest → transfer) |
| **Discovery** | `discovery-manager.ts` | UDP broadcast device discovery |
| **Security** | `auth-handshake.ts` | PSK challenge-response auth |
| **Security** | `path-validator.ts` | Path traversal protection |
| **Network** | `connection-manager.ts` | WebSocket server/client/duplex |
| **Network** | `protocol.ts` | Message serialization protocol |
| **IO** | `file-watcher.ts` | Chokidar-based file change detection |
| **IO** | `os-writer.ts` | Platform-aware file writing |

---

## 🔄 How It Works

### Sync Flow

```
Device A ──→ Send File Manifest (FILE_LIST_BATCH) ──→ Device B
                │                                            │
                │     B compares against local files          │
                │                                            │
                │←── Reply with missing/different (FILE_LIST_ACK) ──┤
                │                                            │
                │── Transfer files (FILE_RESPONSE) ──────────┤
                                                                 
                                                                 
Device A ──→ File change detected ──→ CRDT incremental update ──→ Device B
                │                                                       │
                │     [Text files] Yjs merge & write                     │
                │     [Binary files] Full file transfer                  │
```

### Conflict Resolution

| File Type | Strategy |
|-----------|----------|
| **.md / .txt / .canvas** | Yjs CRDT auto-merge — no user intervention needed |
| **.png / .pdf / .zip** | Detected → User prompted to keep local / remote / both |

### Synchronization Safeguards

| Mechanism | Purpose |
|-----------|---------|
| `recentlyPushed` (2s TTL) | Prevents sync loop (A pushes → B writes → B pushes back) |
| `originDeviceId` | Ignores changes originated from self |
| Debounce (500ms) | Avoids redundant sync on rapid saves |
| UUID dedup | Prevents duplicate message processing |
| Heartbeat (30s ping/pong) | Detects dead connections |
| Exponential backoff | Smart reconnection (1s → 2s → 4s → 8s → ... → 60s max) |
| Version tracking | Discards stale file versions |
| Pending queue | Buffers changes when offline, flushes on reconnect |

---

## 📊 Stats

| Metric | Value |
|--------|-------|
| Source Files | 19 `.ts` files, ~6,700 lines |
| Tests | 131 tests (unit + integration + E2E), all passing |
| Dependencies | `ws` · `chokidar` · `yjs` |
| Build | esbuild — single `main.js` (~190KB) |

---

## 🛠️ Development

```bash
# Clone & build
git clone https://github.com/liuboacean/obsidian-local-sync-plugin.git
cd obsidian-local-sync-plugin
npm install
npm run build     # Production build
npm run dev       # Watch mode (for Hot Reload plugin)
npm test          # Run all tests

# Quick test with two vaults on the same machine:
# 1. Copy to Vault A: cp main.js manifest.json styles.css /path/to/vault-a/.obsidian/plugins/obsidian-local-sync/
# 2. Copy to Vault B (different port via settings)
# 3. Restart Obsidian on both vaults
# 4. Point Vault A → Vault B's address
```

---

## 📝 To-Do

- [x] Yjs CRDT auto-merge
- [x] PSK auth + path security
- [x] UDP auto-discovery
- [x] Cross-platform file writer (macOS/Linux/Windows)
- [ ] TLS encryption (P2)
- [ ] Mobile client support (P2)
- [ ] Sync history viewer (P2)
- [ ] Diff preview before sync (P2)

---

## 🤝 Contributing

PRs are welcome! Check the [issues](https://github.com/liuboacean/obsidian-local-sync-plugin/issues) for areas to contribute.

## 📄 License

MIT © 2026 Obsidian Local Sync Team

---

<div align="center">
  
**Made with ❤️ for the Obsidian community**

</div>
