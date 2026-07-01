// ============================================================
// Core Sync Engine — Dispatcher & Scheduler
// ============================================================
// Central coordinator that connects FileWatcher, ConnectionManager,
// CrdtEngine, ConflictDetector, and OsWriter.
//
// Handles:
//   - Local file changes → classify → CRDT or binary → send
//   - Remote messages → dispatch by type → apply
//   - Pending queue for offline changes
//   - Full sync request on reconnect

import { EventEmitter } from "events";
import {
  FileChange,
  SyncMessage,
  MessageType,
  FileCategory,
  SyncFileState,
  SyncStats,
  SyncStatus,
  ChangeType,
  ConflictInfo,
  ConflictStatus,
} from "./types";
import { EVENTS } from "./constants";
import { classifyFile, computeFileHash, generateDocId, normalizePath } from "./utils";
import { serializeMessage, createMessage } from "./protocol";
import { FileWatcher } from "./file-watcher";
import { OsWriter } from "./os-writer";
import { CrdtEngine } from "./crdt-engine";
import { ConflictDetector, ConflictType } from "./conflict-detector";
import { ConnectionManager } from "./connection-manager";
import { syncLogger, SyncLogger } from "./sync-logger";
import { LogLevel, SyncEventType } from "./types";
import * as path from "path";

// ============================================================
// Queue Implementation
// ============================================================

class SimpleQueue<T> {
  private items: T[] = [];

  enqueue(item: T): void {
    this.items.push(item);
  }

  dequeue(): T | undefined {
    return this.items.shift();
  }

  peek(): T | undefined {
    return this.items[0];
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }

  getAll(): T[] {
    return [...this.items];
  }
}

// ============================================================
// Sync Engine Class
// ============================================================

export class SyncEngine extends EventEmitter {
  private fileWatcher: FileWatcher;
  private osWriter: OsWriter;
  private crdtEngine: CrdtEngine;
  private conflictDetector: ConflictDetector;
  private connectionManager: ConnectionManager | null = null;

  /** File state map: relativePath -> SyncFileState */
  private fileStates: Map<string, SyncFileState> = new Map();

  /** Pending changes queue (buffered while disconnected) */
  private pendingQueue: SimpleQueue<FileChange> = new SimpleQueue();

  /** Device identity */
  private deviceId: string = "";
  private deviceName: string = "";
  private vaultPath: string = "";

  /** Sync statistics */
  private stats: SyncStats = {
    pendingFiles: 0,
    syncedFiles: 0,
    conflictedFiles: 0,
    failedFiles: 0,
    totalBytes: 0,
    transferredBytes: 0,
    lastSyncTime: undefined,
  };

  /** Whether the engine is running. */
  private running = false;

  constructor(
    fileWatcher: FileWatcher,
    osWriter: OsWriter,
    crdtEngine: CrdtEngine,
    conflictDetector: ConflictDetector,
  ) {
    super();
    this.fileWatcher = fileWatcher;
    this.osWriter = osWriter;
    this.crdtEngine = crdtEngine;
    this.conflictDetector = conflictDetector;

    this.setMaxListeners(30);
  }

  // ============================================================
  // Initialization
  // ============================================================

  /**
   * Initialize the sync engine with device identity and vault path.
   */
  init(
    deviceId: string,
    deviceName: string,
    vaultPath: string,
  ): void {
    this.deviceId = deviceId;
    this.deviceName = deviceName;
    this.vaultPath = vaultPath;
  }

  /**
   * Set the connection manager reference after it's created.
   */
  setConnectionManager(connectionManager: ConnectionManager): void {
    this.connectionManager = connectionManager;
  }

  /**
   * Start the sync engine.
   * Binds to file watcher events and connection manager events.
   */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;

    // Bind file watcher events
    this.fileWatcher.on(EVENTS.FILE_CREATED, (change: FileChange) => {
      this.handleLocalChange(change).catch((err) => {
        syncLogger.log(LogLevel.ERROR, `handleLocalChange (CREATE) error: ${err}`, change.relativePath, SyncEventType.ERROR);
      });
    });

    this.fileWatcher.on(EVENTS.FILE_MODIFIED, (change: FileChange) => {
      this.handleLocalChange(change).catch((err) => {
        syncLogger.log(LogLevel.ERROR, `handleLocalChange (MODIFY) error: ${err}`, change.relativePath, SyncEventType.ERROR);
      });
    });

    this.fileWatcher.on(EVENTS.FILE_DELETED, (change: FileChange) => {
      this.handleLocalChange(change).catch((err) => {
        syncLogger.log(LogLevel.ERROR, `handleLocalChange (DELETE) error: ${err}`, change.relativePath, SyncEventType.ERROR);
      });
    });

    syncLogger.log(LogLevel.INFO, "Sync engine started", undefined, SyncEventType.SYNC_STARTED);
  }

  /**
   * Stop the sync engine.
   */
  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    syncLogger.log(LogLevel.INFO, "Sync engine stopped", undefined, SyncEventType.DISCONNECTED);
  }

  // ============================================================
  // Local Change Handling
  // ============================================================

  /**
   * Handle a local file change detected by the FileWatcher.
   *
   * Flow:
   * 1. Check if recently pushed (avoid circular sync)
   * 2. Classify file (TEXT / BINARY)
   * 3. TEXT: CRDT update via ConnectionManager.sendBinary()
   * 4. BINARY: full file sync via ConnectionManager.sendMessage()
   * 5. Update file state map
   */
  async handleLocalChange(change: FileChange): Promise<void> {
    // Avoid circular sync
    if (this.fileWatcher.isRecentlyPushed(change.relativePath)) {
      return;
    }

    // Update file state
    this.updateFileState(change);

    // If disconnected, enqueue for later
    if (!this.connectionManager || !this.connectionManager.getIsConnected()) {
      this.pendingQueue.enqueue(change);
      this.stats.pendingFiles = this.pendingQueue.size();
      syncLogger.log(
        LogLevel.INFO,
        `Queued local change (offline): ${change.relativePath}`,
        change.relativePath,
        SyncEventType.SYNC_STARTED,
      );
      return;
    }

    // Set origin device ID
    change.originDeviceId = this.deviceId;

    if (change.fileCategory === FileCategory.TEXT) {
      await this.handleLocalTextChange(change);
    } else {
      await this.handleLocalBinaryChange(change);
    }

    this.stats.syncedFiles++;
    this.stats.lastSyncTime = new Date().toISOString();
  }

  /**
   * Handle a local TEXT file change via CRDT.
   */
  private async handleLocalTextChange(change: FileChange): Promise<void> {
    try {
      // Read file content
      const content = await this.osWriter.readFile(this.vaultPath, change.relativePath);
      const contentStr = content.toString("utf-8");
      const fileSize = content.byteLength;

      // Check if CRDT is suitable
      const docId = generateDocId(change.relativePath);
      if (this.crdtEngine.shouldUseCrdt(FileCategory.TEXT, fileSize)) {
        // Initialize or get CRDT doc
        const doc = this.crdtEngine.initDoc(docId, change.relativePath, contentStr);

        // Generate incremental update
        const update = this.crdtEngine.generateUpdate(doc);

        // Send via binary frame
        this.connectionManager!.sendBinary(update);

        syncLogger.log(
          LogLevel.DEBUG,
          `CRDT update sent: ${change.relativePath}`,
          change.relativePath,
          SyncEventType.FILE_PUSHED,
        );
      } else {
        // CRDT not suitable — fall back to full file sync
        const msg = createMessage(
          MessageType.FILE_CHANGE,
          {
            relativePath: change.relativePath,
            fileCategory: FileCategory.TEXT,
            content: contentStr,
            hash: change.hash,
            mtime: change.mtime,
            size: fileSize,
          },
          this.deviceId,
          this.deviceName,
        );
        this.connectionManager!.sendMessage(msg);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      syncLogger.log(
        LogLevel.ERROR,
        `Failed to handle local TEXT change: ${errorMessage}`,
        change.relativePath,
        SyncEventType.ERROR,
      );
      this.stats.failedFiles++;
    }
  }

  /**
   * Handle a local BINARY file change via full-file transfer.
   */
  private async handleLocalBinaryChange(change: FileChange): Promise<void> {
    try {
      const content = await this.osWriter.readFile(this.vaultPath, change.relativePath);
      const fileSize = content.byteLength;

      // For binary files, send the full content as a message
      const msg = createMessage(
        MessageType.FILE_CHANGE,
        {
          relativePath: change.relativePath,
          fileCategory: FileCategory.BINARY,
          content: content.toString("base64"),
          hash: change.hash,
          mtime: change.mtime,
          size: fileSize,
        },
        this.deviceId,
        this.deviceName,
      );

      this.connectionManager!.sendMessage(msg);

      this.stats.transferredBytes += fileSize;

      syncLogger.log(
        LogLevel.DEBUG,
        `Binary file sent: ${change.relativePath} (${fileSize} bytes)`,
        change.relativePath,
        SyncEventType.FILE_PUSHED,
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      syncLogger.log(
        LogLevel.ERROR,
        `Failed to handle local BINARY change: ${errorMessage}`,
        change.relativePath,
        SyncEventType.ERROR,
      );
      this.stats.failedFiles++;
    }
  }

  // ============================================================
  // Remote Message Handling
  // ============================================================

  /**
   * Handle a message received from a remote peer.
   * Dispatches based on message type.
   */
  async handleRemoteMessage(msg: SyncMessage): Promise<void> {
    switch (msg.type) {
      case MessageType.FILE_CHANGE:
        await this.handleRemoteFileChange(msg);
        break;

      case MessageType.CRDT_UPDATE:
        await this.handleRemoteCrdtUpdate(msg);
        break;

      case MessageType.CRDT_SYNC_FULL:
        await this.handleRemoteCrdtSyncFull(msg);
        break;

      case MessageType.CONFLICT_NOTIFY:
        this.handleRemoteConflictNotify(msg);
        break;

      case MessageType.CONFLICT_RESOLVE:
        this.handleRemoteConflictResolve(msg);
        break;

      case MessageType.FILE_CHANGE_ACK:
        // Acknowledgment — nothing to do
        break;

      case MessageType.SYNC_STATUS:
        // Status update — nothing to do
        break;

      default:
        syncLogger.log(
          LogLevel.DEBUG,
          `Unhandled message type: ${msg.type}`,
          undefined,
          SyncEventType.ERROR,
        );
    }
  }

  /**
   * Handle a remote FILE_CHANGE message.
   */
  private async handleRemoteFileChange(msg: SyncMessage): Promise<void> {
    const payload = msg.payload;
    if (!payload || !payload.relativePath) {
      return;
    }

    const relativePath: string = payload.relativePath;
    const fileCategory: FileCategory = payload.fileCategory || FileCategory.TEXT;

    try {
      if (fileCategory === FileCategory.TEXT) {
        // TEXT file
        const content: string = payload.content || "";

        // Check CRDT suitability
        const docId = generateDocId(relativePath);
        if (payload.crdtUpdate) {
          // Apply CRDT update
          const update = new Uint8Array(Buffer.from(payload.crdtUpdate, "base64"));
          const doc = this.crdtEngine.initDoc(docId, relativePath);
          this.crdtEngine.applyUpdate(doc, update);
          const mergedContent = this.crdtEngine.getTextContent(doc);

          // Write merged content to disk
          await this.osWriter.writeFile(this.vaultPath, relativePath, mergedContent);
        } else {
          // Full content replacement
          const doc = this.crdtEngine.initDoc(docId, relativePath, content);
          await this.osWriter.writeFile(this.vaultPath, relativePath, content);
        }

        syncLogger.log(
          LogLevel.SUCCESS,
          `File received (TEXT): ${relativePath}`,
          relativePath,
          SyncEventType.FILE_RECEIVED,
        );
      } else {
        // BINARY file
        const contentBase64: string = payload.content || "";
        const content = Buffer.from(contentBase64, "base64");

        // Conflict detection
        const localHash = await computeFileHash(
          path.join(this.vaultPath, relativePath),
        );
        const hasConflict = this.conflictDetector.detect(
          FileCategory.BINARY,
          localHash,
          payload.hash || "",
          0, // local mtime
          payload.mtime || 0,
          "MODIFY_VS_MODIFY" as ConflictType,
        );

        if (hasConflict) {
          // Register conflict and notify
          this.conflictDetector.registerConflict({
            relativePath,
            localVersion: {
              type: ChangeType.MODIFY,
              relativePath,
              mtime: 0,
              hash: localHash,
              originDeviceId: this.deviceId,
              version: 1,
              fileCategory: FileCategory.BINARY,
              size: 0,
            },
            remoteVersion: {
              type: ChangeType.MODIFY,
              relativePath,
              mtime: payload.mtime || 0,
              hash: payload.hash || "",
              originDeviceId: msg.deviceId,
              version: 1,
              fileCategory: FileCategory.BINARY,
              size: content.byteLength,
            },
            status: ConflictStatus.UNRESOLVED,
            detectedAt: Date.now(),
            conflictType: "MODIFY_VS_MODIFY",
          });

          this.emit(EVENTS.CONFLICT_DETECTED, relativePath);
          this.stats.conflictedFiles++;
        } else {
          // No conflict — write directly
          await this.osWriter.writeFile(this.vaultPath, relativePath, content);
          syncLogger.log(
            LogLevel.SUCCESS,
            `File received (BINARY): ${relativePath}`,
            relativePath,
            SyncEventType.FILE_RECEIVED,
          );
        }
      }

      this.stats.syncedFiles++;
      this.stats.lastSyncTime = new Date().toISOString();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      syncLogger.log(
        LogLevel.ERROR,
        `Failed to handle remote file change: ${errorMessage}`,
        relativePath,
        SyncEventType.ERROR,
      );
      this.stats.failedFiles++;
    }
  }

  /**
   * Handle a remote CRDT_UPDATE message.
   */
  private async handleRemoteCrdtUpdate(msg: SyncMessage): Promise<void> {
    const payload = msg.payload;
    if (!payload || !payload.docId || !payload.update) {
      return;
    }

    const docId: string = payload.docId;
    const updateBase64: string = payload.update;

    try {
      const update = new Uint8Array(Buffer.from(updateBase64, "base64"));

      // Get or create the doc
      let doc = this.crdtEngine.getDoc(docId);
      if (!doc) {
        doc = this.crdtEngine.initDoc(docId, payload.relativePath || docId);
      }

      // Apply the update
      this.crdtEngine.applyUpdate(doc, update);

      // Write merged content to disk
      const mergedContent = this.crdtEngine.getTextContent(doc);

      // Determine relative path
      const state = this.crdtEngine.getState(docId);
      const relativePath = (state && state.relativePath) || payload.relativePath || docId;

      await this.osWriter.writeFile(this.vaultPath, relativePath, mergedContent);

      syncLogger.log(
        LogLevel.DEBUG,
        `CRDT update applied: ${relativePath}`,
        relativePath,
        SyncEventType.CRDT_MERGED,
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      syncLogger.log(
        LogLevel.ERROR,
        `Failed to apply CRDT update: ${errorMessage}`,
        docId,
        SyncEventType.ERROR,
      );
    }
  }

  /**
   * Handle a remote CRDT_SYNC_FULL message (full document snapshot).
   */
  private async handleRemoteCrdtSyncFull(msg: SyncMessage): Promise<void> {
    const payload = msg.payload;
    if (!payload || !payload.docId) {
      return;
    }

    const docId: string = payload.docId;
    const snapshotBase64: string = payload.snapshot || "";

    try {
      if (snapshotBase64) {
        // Restore from snapshot data in message
        const snapshot = new Uint8Array(Buffer.from(snapshotBase64, "base64"));
        let doc = this.crdtEngine.getDoc(docId);
        if (!doc) {
          doc = this.crdtEngine.initDoc(docId, payload.relativePath || docId);
        }
        this.crdtEngine.applyUpdate(doc, snapshot);

        const mergedContent = this.crdtEngine.getTextContent(doc);
        const relativePath = payload.relativePath || docId;
        await this.osWriter.writeFile(this.vaultPath, relativePath, mergedContent);
      } else {
        // Try restoring from local snapshot
        await this.crdtEngine.restoreFromSnapshot(docId);
      }

      syncLogger.log(
        LogLevel.SUCCESS,
        `Full CRDT sync applied: ${docId}`,
        docId,
        SyncEventType.CRDT_MERGED,
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      syncLogger.log(
        LogLevel.ERROR,
        `Failed to apply full CRDT sync: ${errorMessage}`,
        docId,
        SyncEventType.ERROR,
      );
    }
  }

  /**
   * Handle a remote CONFLICT_NOTIFY message.
   */
  private handleRemoteConflictNotify(msg: SyncMessage): void {
    const payload = msg.payload;
    if (!payload || !payload.relativePath) {
      return;
    }

    syncLogger.log(
      LogLevel.WARN,
      `Conflict notified by peer: ${payload.relativePath}`,
      payload.relativePath,
      SyncEventType.CONFLICT_DETECTED,
    );

    this.emit(EVENTS.CONFLICT_DETECTED, payload.relativePath);
  }

  /**
   * Handle a remote CONFLICT_RESOLVE message.
   */
  private handleRemoteConflictResolve(msg: SyncMessage): void {
    const payload = msg.payload;
    if (!payload || !payload.relativePath || !payload.resolution) {
      return;
    }

    this.conflictDetector.resolveConflict(
      payload.relativePath,
      payload.resolution,
    );

    syncLogger.log(
      LogLevel.INFO,
      `Conflict resolved by peer: ${payload.relativePath} (${payload.resolution})`,
      payload.relativePath,
      SyncEventType.CONFLICT_RESOLVED,
    );
  }

  // ============================================================
  // Full Sync
  // ============================================================

  /**
   * Request a full sync from the connected peer.
   * Used on initial connection or after reconnection.
   */
  async requestFullSync(): Promise<void> {
    if (!this.connectionManager || !this.connectionManager.getIsConnected()) {
      return;
    }

    const msg = createMessage(
      MessageType.SYNC_STATUS,
      { fullSyncRequest: true },
      this.deviceId,
      this.deviceName,
    );

    this.connectionManager.sendMessage(msg);

    syncLogger.log(LogLevel.INFO, "Full sync requested", undefined, SyncEventType.SYNC_STARTED);
  }

  // ============================================================
  // Pending Queue
  // ============================================================

  /**
   * Flush all pending changes from the queue (called on reconnection).
   */
  async flushPendingQueue(): Promise<void> {
    if (this.pendingQueue.size() === 0) {
      return;
    }

    syncLogger.log(
      LogLevel.INFO,
      `Flushing ${this.pendingQueue.size()} pending changes`,
      undefined,
      SyncEventType.SYNC_STARTED,
    );

    const changes = this.pendingQueue.getAll();
    this.pendingQueue.clear();
    this.stats.pendingFiles = 0;

    for (const change of changes) {
      await this.handleLocalChange(change);
    }
  }

  // ============================================================
  // File State Management
  // ============================================================

  /**
   * Update the file state for a given change.
   */
  private updateFileState(change: FileChange): void {
    const existing = this.fileStates.get(change.relativePath);
    if (existing) {
      existing.localMtime = change.mtime;
      existing.localHash = change.hash;
      existing.status = SyncStatus.PENDING;
      existing.version++;
      existing.lastPushedAt = Date.now();
      existing.fileCategory = change.fileCategory;
    } else {
      this.fileStates.set(change.relativePath, {
        relativePath: change.relativePath,
        localMtime: change.mtime,
        localHash: change.hash,
        remoteMtime: 0,
        remoteHash: "",
        status: SyncStatus.PENDING,
        version: 1,
        lastPushedAt: Date.now(),
        fileCategory: change.fileCategory,
        crdtDocId:
          change.fileCategory === FileCategory.TEXT
            ? generateDocId(change.relativePath)
            : undefined,
      });
    }
  }

  /**
   * Get the sync state for a specific file.
   */
  getFileState(relativePath: string): SyncFileState | undefined {
    return this.fileStates.get(relativePath);
  }

  /**
   * Get all file sync states.
   */
  getSyncFileStates(): Map<string, SyncFileState> {
    return new Map(this.fileStates);
  }

  // ============================================================
  // Conflict Resolution
  // ============================================================

  /**
   * Resolve a conflict for the given path.
   */
  async resolveConflict(
    path: string,
    resolution: "keep_local" | "keep_remote" | "keep_both",
  ): Promise<void> {
    const conflictInfo = this.conflictDetector.resolveConflict(path, resolution);

    // If resolution is keep_remote, fetch the remote version
    if (resolution === "keep_remote" && this.connectionManager?.getIsConnected()) {
      const msg = createMessage(
        MessageType.FILE_REQUEST,
        { relativePath: path },
        this.deviceId,
        this.deviceName,
      );
      this.connectionManager.sendMessage(msg);
    }

    // Notify remote peer of the resolution
    if (this.connectionManager?.getIsConnected()) {
      const notifyMsg = createMessage(
        MessageType.CONFLICT_RESOLVE,
        { relativePath: path, resolution },
        this.deviceId,
        this.deviceName,
      );
      this.connectionManager.sendMessage(notifyMsg);
    }

    this.emit(EVENTS.CONFLICT_DETECTED, { path, resolution });
  }

  // ============================================================
  // Statistics
  // ============================================================

  /**
   * Get current sync statistics.
   */
  getSyncStats(): SyncStats {
    this.stats.pendingFiles = this.pendingQueue.size();

    // Count synced files
    let syncedCount = 0;
    let conflictedCount = 0;
    let failedCount = 0;
    for (const state of this.fileStates.values()) {
      if (state.status === SyncStatus.SYNCED) {
        syncedCount++;
      } else if (state.status === SyncStatus.CONFLICTED) {
        conflictedCount++;
      } else if (state.status === SyncStatus.FAILED) {
        failedCount++;
      }
    }

    return {
      ...this.stats,
      syncedFiles: syncedCount,
      conflictedFiles: conflictedCount,
      failedFiles: failedCount,
    };
  }

  /**
   * Whether the engine is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }
}
