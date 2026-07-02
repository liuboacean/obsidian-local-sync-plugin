// ============================================================
// Obsidian Local Sync Plugin — Main Entry Point
// ============================================================
// Integrates all system components: FileWatcher, ConnectionManager,
// CrdtEngine, ConflictDetector, SyncEngine, DiscoveryManager,
// InitialSyncManager, Logger, StatusBar, and Settings.

import { Plugin, TFile } from "obsidian";
import {
  SyncSettings,
  SyncMode,
  FileChange,
  SyncMessage,
  SyncStats,
  ChangeType,
  ConflictInfo,
  LogLevel,
  SyncEventType,
  MessageType,
} from "./types";
import { DEFAULT_SETTINGS } from "./settings";
import { LocalSyncSettingTab } from "./setting-tab";
import { ConflictResolverModal, ConflictResolution } from "./conflict-resolver";
import { SyncStatusBar } from "./sync-status-bar";
import { FileWatcher } from "./file-watcher";
import { OsWriter } from "./os-writer";
import { CrdtEngine } from "./crdt-engine";
import { ConflictDetector } from "./conflict-detector";
import { SyncEngine } from "./sync-engine";
import { ConnectionManager } from "./connection-manager";
import { DiscoveryManager } from "./discovery-manager";
import { InitialSyncManager } from "./initial-sync";
import { syncLogger, debugLog } from "./sync-logger";
import { generateDeviceId } from "./utils";

// ============================================================
// Plugin Main Class
// ============================================================

export default class ObsidianLocalSyncPlugin extends Plugin {
  // Settings
  settings!: SyncSettings;

  // Core components
  connMgr!: ConnectionManager;
  watcher!: FileWatcher;
  engine!: SyncEngine;
  crdtEngine!: CrdtEngine;
  conflictDetector!: ConflictDetector;
  discoveryMgr!: DiscoveryManager;
  initialSync!: InitialSyncManager;
  statusBar!: SyncStatusBar;
  osWriter!: OsWriter;

  /** Generated unique device ID (persistent per vault). */
  private deviceId: string = "";

  // ============================================================
  // Lifecycle: onload
  // ============================================================

  async onload(): Promise<void> {
    // Initialize log directory so all log entries are persisted to file
    await syncLogger.initLogDir();
    debugLog("[Obsidian Local Sync] loading plugin...");

    await this.loadSettings();
    debugLog("[Obsidian Local Sync] settings loaded, deviceId: " + this.settings.deviceId);

    // Initialize device ID (persisted in settings)
    this.deviceId = this.settings.deviceId || generateDeviceId();
    if (!this.settings.deviceId) {
      this.settings.deviceId = this.deviceId;
      await this.saveSettings();
    }

    // Get vault path
    const vaultPath = (this.app.vault.adapter as any).getBasePath?.() || "";
    debugLog("[Obsidian Local Sync] vaultPath:", vaultPath);

    // Initialize components
    try {
      this.initComponents(vaultPath);
      debugLog("[Obsidian Local Sync] components initialized");
    } catch (err) {
      console.error("[Obsidian Local Sync] initComponents FAILED:", err);
    }

    // Bind component events
    try {
      this.bindEvents();
      debugLog("[Obsidian Local Sync] events bound");
    } catch (err) {
      console.error("[Obsidian Local Sync] bindEvents FAILED:", err);
    }

    // Start file watcher
    try {
      this.watcher.start(vaultPath, this.settings.ignoreFolders, this.settings.ignoreExtensions);
      debugLog("[Obsidian Local Sync] file watcher started");
    } catch (err) {
      console.error("[Obsidian Local Sync] file watcher FAILED:", err);
    }

    // Start UDP discovery if enabled
    if (this.settings.enableUdpDiscovery) {
      try {
        this.startDiscovery();
        debugLog("[Obsidian Local Sync] UDP discovery started");
      } catch (err) {
        console.error("[Obsidian Local Sync] UDP discovery FAILED:", err);
      }
    }

    // Auto-start the WebSocket server on plugin load
    // This allows other devices to connect to this instance
    this.connMgr.startServer()
      .then(() => debugLog("[Obsidian Local Sync] WebSocket server started on port", this.settings.port))
      .catch((err) => {
        console.error("[Obsidian Local Sync] Server start FAILED:", err);
        syncLogger.log(LogLevel.ERROR, `Auto-start server failed: ${err}`, undefined, SyncEventType.ERROR);
      });

    // Auto-connect to remote device if target address is configured
    // Saves the user from having to click "连接" after each restart
    if (this.settings.targetAddress && (this.settings.mode === SyncMode.CLIENT || this.settings.mode === SyncMode.DUPLEX)) {
      debugLog("[Obsidian Local Sync] Auto-connecting to", this.settings.targetAddress);
      this.startSync().catch((err) => {
        console.error("[Obsidian Local Sync] Auto-connect failed:", err);
      });
    }

    // Register settings tab
    this.addSettingTab(new LocalSyncSettingTab(this.app, this));

    // Register status bar
    this.statusBar.registerStatusBar();
    debugLog("[Obsidian Local Sync] settings tab + status bar registered");

    // Register commands
    this.registerCommands();
    debugLog("[Obsidian Local Sync] commands registered");

    debugLog("[Obsidian Local Sync] plugin load COMPLETE. Device ID:", this.deviceId);

    syncLogger.log(
      LogLevel.SUCCESS,
      "Plugin loaded successfully. Device ID: " + this.deviceId,
      undefined,
      SyncEventType.SYNC_STARTED,
    );
  }

  // ============================================================
  // Lifecycle: onunload
  // ============================================================

  async onunload(): Promise<void> {
    debugLog("Obsidian Local Sync: unloading plugin");

    // Stop file watcher
    this.watcher?.stop();

    // Disconnect WebSocket
    this.connMgr?.disconnect();

    // Stop UDP discovery
    this.discoveryMgr?.stopDiscovery();

    // Snapshot all dirty CRDT documents
    if (this.crdtEngine) {
      await this.crdtEngine.snapshotAllDirty();
      this.crdtEngine.destroy();
    }

    // Stop sync engine
    this.engine?.stop();

    syncLogger.log(
      LogLevel.INFO,
      "Plugin unloaded",
      undefined,
      SyncEventType.DISCONNECTED,
    );
  }

  // ============================================================
  // Component Initialization
  // ============================================================

  private initComponents(vaultPath: string): void {
    // File watcher
    this.watcher = new FileWatcher();

    // OS-compatible writer
    this.osWriter = new OsWriter();
    this.osWriter.setVaultPath(vaultPath);
    this.osWriter.setVaultApis({
      modify: async (path: string, content: string) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await this.app.vault.modify(file, content);
        }
      },
      delete: async (path: string) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await this.app.vault.delete(file);
        }
      },
      rename: async (oldPath: string, newPath: string) => {
        const file = this.app.vault.getAbstractFileByPath(oldPath);
        if (file instanceof TFile) {
          await this.app.vault.rename(file, newPath);
        }
      },
      read: async (path: string) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          return await this.app.vault.read(file);
        }
        return "";
      },
    });
    this.osWriter.setMarkAsPushedFn((path: string) => {
      this.watcher.markAsPushed(path);
    });

    // CRDT Engine
    this.crdtEngine = new CrdtEngine();
    this.crdtEngine.init().catch((err) => {
      syncLogger.log(LogLevel.ERROR, `CRDT init error: ${err}`, undefined, SyncEventType.ERROR);
    });

    // Conflict Detector
    this.conflictDetector = new ConflictDetector();

    // Sync Engine
    this.engine = new SyncEngine(
      this.watcher,
      this.osWriter,
      this.crdtEngine,
      this.conflictDetector,
    );
    this.engine.init(this.deviceId, this.settings.deviceName, vaultPath);

    // Connection Manager
    this.connMgr = new ConnectionManager({
      mode: this.settings.mode,
      port: this.settings.port,
      targetAddress: this.settings.targetAddress,
      deviceId: this.deviceId,
      deviceName: this.settings.deviceName,
      sharedKey: this.settings.sharedKey,
    });

    // Wire ConnectionManager to SyncEngine
    this.engine.setConnectionManager(this.connMgr);

    // Discovery Manager
    this.discoveryMgr = new DiscoveryManager({
      deviceId: this.deviceId,
      deviceName: this.settings.deviceName,
      port: this.settings.port,
      udpDiscoveryPort: this.settings.udpDiscoveryPort,
    });

    // Initial Sync Manager
    this.initialSync = new InitialSyncManager({
      vaultPath,
      deviceId: this.deviceId,
      deviceName: this.settings.deviceName,
      connectionManager: this.connMgr,
      crdtEngine: this.crdtEngine,
      osWriter: this.osWriter,
      onProgress: (progress) => {
        this.statusBar?.setSyncProgress(progress.completed, progress.total);
      },
    });

    // Status Bar
    this.statusBar = new SyncStatusBar(this);
  }

  // ============================================================
  // Event Binding
  // ============================================================

  private bindEvents(): void {
    // File watcher -> Sync engine
    this.watcher.on("file-created", (change: FileChange) => {
      this.engine.handleLocalChange(change).catch((err) => {
        syncLogger.log(LogLevel.ERROR, `file-created handler: ${err}`, change.relativePath, SyncEventType.ERROR);
      });
    });

    this.watcher.on("file-modified", (change: FileChange) => {
      this.engine.handleLocalChange(change).catch((err) => {
        syncLogger.log(LogLevel.ERROR, `file-modified handler: ${err}`, change.relativePath, SyncEventType.ERROR);
      });
    });

    this.watcher.on("file-deleted", (change: FileChange) => {
      this.engine.handleLocalChange(change).catch((err) => {
        syncLogger.log(LogLevel.ERROR, `file-deleted handler: ${err}`, change.relativePath, SyncEventType.ERROR);
      });
    });

    // Connection Manager -> Status bar + Sync engine
    this.connMgr.on("connected", () => {
      this.statusBar.updateConnectionStatus("connected");
      // Update device count to 1 (the remote peer we connected to)
      // UDP discovery may not work across subnets, so this ensures
      // the status bar shows connected device count even without UDP
      this.statusBar.setDeviceCount(1);
      syncLogger.log(LogLevel.SUCCESS, "Connected to remote device", undefined, SyncEventType.CONNECTED);

      // Start sync engine
      this.engine.start();

      // Flush any pending changes
      this.engine.flushPendingQueue().catch((err) => {
        syncLogger.log(LogLevel.ERROR, `flushPendingQueue error: ${err}`, undefined, SyncEventType.ERROR);
      });

      // Request full sync on first connection
      this.initialSync.startFullSync()
        .then(() => {
          // Update sync stats after initial sync completes
          const now = new Date();
          const timeStr = now.toLocaleString("zh-CN", {
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit",
          });
          this.engine.setLastSyncTime(timeStr);
          this.engine.setInitialSyncCount(this.initialSync.getTransferredCount());
          syncLogger.log(
            LogLevel.SUCCESS,
            "Initial sync completed, " + this.initialSync.getTransferredCount() + " files synced",
            undefined,
            SyncEventType.SYNC_COMPLETED,
          );
        })
        .catch((err) => {
          syncLogger.log(LogLevel.ERROR, `initialSync error: ${err}`, undefined, SyncEventType.ERROR);
        });
    });

    this.connMgr.on("disconnected", () => {
      this.statusBar.updateConnectionStatus("disconnected");
      this.statusBar.setSyncing(false);
      syncLogger.log(LogLevel.WARN, "Disconnected from remote device", undefined, SyncEventType.DISCONNECTED);
    });

    this.connMgr.on("reconnecting", (info: { delay: number; attempt: number }) => {
      this.statusBar.updateConnectionStatus("connecting");
      syncLogger.log(LogLevel.INFO, `Reconnecting in ${info.delay}ms (attempt ${info.attempt})`);
    });

    this.connMgr.on("message-received", (msg: SyncMessage) => {
      // Route initial sync messages to InitialSyncManager
      if (msg.type === MessageType.FILE_LIST_BATCH) {
        this.initialSync.handleRemoteBatch(msg).catch((err) => {
          syncLogger.log(LogLevel.ERROR, `initialSync batch error: ${err}`, undefined, SyncEventType.ERROR);
        });
        return;
      }
      if (msg.type === MessageType.FILE_LIST_ACK) {
        this.initialSync.handleFileListAck(msg).catch((err) => {
          syncLogger.log(LogLevel.ERROR, `initialSync ack error: ${err}`, undefined, SyncEventType.ERROR);
        });
        return;
      }
      // All other messages go to the sync engine
      this.engine.handleRemoteMessage(msg).catch((err) => {
        syncLogger.log(LogLevel.ERROR, `message-received handler: ${err}`, undefined, SyncEventType.ERROR);
      });
    });

    // CRDT binary updates from connection manager
    this.connMgr.on("crdt-update-received", (data: unknown) => {
      // Binary CRDT updates are handled through the message-received path for text,
      // and direct binary for binary frames
      syncLogger.log(LogLevel.DEBUG, "CRDT binary update received");
    });

    // Sync engine -> Status bar
    this.engine.on("sync-progress", (_stats: SyncStats) => {
      const stats = this.engine.getSyncStats();
      this.statusBar.setPendingCount(stats.pendingFiles);
      this.statusBar.setConflictCount(stats.conflictedFiles);
    });

    // Sync engine -> Conflict detector -> Conflict UI
    this.engine.on("conflict-detected", (path: string) => {
      const conflict = this.conflictDetector.getConflict(path);
      if (conflict) {
        this.showConflictDialog(conflict);
      }
    });

    // Discovery manager -> Status bar
    this.discoveryMgr.on("device-discovered", () => {
      const count = this.discoveryMgr.getDiscoveredDevices().length;
      this.statusBar.setDeviceCount(count);
    });

    this.discoveryMgr.on("device-lost", () => {
      const count = this.discoveryMgr.getDiscoveredDevices().length;
      this.statusBar.setDeviceCount(count);
    });
  }

  // ============================================================
  // Commands
  // ============================================================

  private registerCommands(): void {
    this.addCommand({
      id: "start-sync",
      name: "Start sync connection",
      callback: async () => {
        await this.startSync();
      },
    });

    this.addCommand({
      id: "stop-sync",
      name: "Stop sync connection",
      callback: () => {
        this.disconnectSync();
      },
    });

    this.addCommand({
      id: "request-full-sync",
      name: "Request full sync from peer",
      callback: async () => {
        await this.engine.requestFullSync();
      },
    });
  }

  // ============================================================
  // Public API (used by setting-tab)
  // ============================================================

  getSettings(): SyncSettings {
    return this.settings;
  }

  async loadSettings(): Promise<void> {
    const loadedData = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings as unknown as Record<string, unknown>);
  }

  async startSync(): Promise<void> {
    await this.connMgr.start();
    this.statusBar.updateConnectionStatus("connecting");
  }

  disconnectSync(): void {
    this.connMgr.disconnect();
    this.statusBar.updateConnectionStatus("disconnected");
  }

  startDiscovery(): void {
    this.discoveryMgr.startDiscovery(this.settings.udpDiscoveryPort);
  }

  stopDiscovery(): void {
    this.discoveryMgr.stopDiscovery();
  }

  connectToDevice(ip: string, port: number): void {
    this.settings.targetAddress = ip;
    this.settings.port = port;
    this.connMgr.setTargetAddress(ip);
    this.saveSettings().catch(() => {});
    this.startSync().catch(() => {});
  }

  showConflictDialog(conflictInfo: ConflictInfo): void {
    ConflictResolverModal.showConflictModal(this.app, conflictInfo)
      .then((resolution: ConflictResolution) => {
        syncLogger.log(
          LogLevel.INFO,
          `Conflict resolved: ${conflictInfo.relativePath} → ${resolution}`,
          conflictInfo.relativePath,
          SyncEventType.CONFLICT_RESOLVED,
        );
        return this.engine.resolveConflict(conflictInfo.relativePath, resolution);
      })
      .catch((err) => {
        syncLogger.log(
          LogLevel.ERROR,
          `Conflict resolution error: ${err}`,
          conflictInfo.relativePath,
          SyncEventType.ERROR,
        );
      });
  }
}
