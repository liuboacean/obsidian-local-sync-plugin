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
  ConflictStatus,
  BeforeSendHook,
} from "./types";
import { EVENTS } from "./constants";
import { computeFileHash, generateDocId } from "./utils";
import { createMessage } from "./protocol";
import { FileWatcher } from "./file-watcher";
import { OsWriter } from "./os-writer";
import { CrdtEngine } from "./crdt-engine";
import { ConflictDetector } from "./conflict-detector";
import { ConnectionManager } from "./connection-manager";
import { syncLogger } from "./sync-logger";
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
    vaultFileCount: 0,
    conflictedFiles: 0,
    failedFiles: 0,
    totalBytes: 0,
    transferredBytes: 0,
    lastSyncTime: undefined,
  };
  /** Counter for files synced during initial full sync (not tracked in fileStates). */
  private initialSyncFileCount = 0;
  /** Total files in the vault (set after initial sync). Used for synced count display. */
  private vaultFileCount = 0;

  /** Whether the engine is running. */
  private running = false;

  /**
   * Optional hook invoked before a local change is transmitted.
   * Registered by DiffPreviewService. When set, the handler decides
   * whether the send proceeds (true) or is skipped (false).
   */
  beforeSendHook: BeforeSendHook | null = null;

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
   * Register the before-send hook (e.g. Diff Preview).
   * Passing null clears any previously registered hook.
   */
  setBeforeSendHook(hook: BeforeSendHook | null): void {
    this.beforeSendHook = hook;
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
        syncLogger.log(LogLevel.ERROR, `本地变更处理（创建）出错：${err}`, change.relativePath, SyncEventType.ERROR);
      });
    });

    this.fileWatcher.on(EVENTS.FILE_MODIFIED, (change: FileChange) => {
      this.handleLocalChange(change).catch((err) => {
        syncLogger.log(LogLevel.ERROR, `本地变更处理（修改）出错：${err}`, change.relativePath, SyncEventType.ERROR);
      });
    });

    this.fileWatcher.on(EVENTS.FILE_DELETED, (change: FileChange) => {
      this.handleLocalChange(change).catch((err) => {
        syncLogger.log(LogLevel.ERROR, `本地变更处理（删除）出错：${err}`, change.relativePath, SyncEventType.ERROR);
      });
    });

    syncLogger.log(LogLevel.INFO, "同步引擎已启动", undefined, SyncEventType.SYNC_STARTED);
  }

  /**
   * Stop the sync engine.
   */
  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    syncLogger.log(LogLevel.INFO, "同步引擎已停止", undefined, SyncEventType.DISCONNECTED);
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
        `已排队本地变更（离线）：${change.relativePath}`,
        change.relativePath,
        SyncEventType.SYNC_STARTED,
      );
      return;
    }

    // Set origin device ID
    change.originDeviceId = this.deviceId;

    // Diff Preview hook — only reached while connected (offline changes
    // are enqueued and returned above). The hook may pause the send to
    // ask the user for confirmation before transmitting.
    if (this.beforeSendHook) {
      const proceed = await this.beforeSendHook.handler(
        change,
        this.vaultPath,
      );
      if (!proceed) {
        syncLogger.log(
          LogLevel.INFO,
          `变更被差异预览跳过：${change.relativePath}`,
        );
        return;
      }
    }

    if (change.type === ChangeType.DELETE) {
      await this.handleLocalDeleteChange(change);
      return;
    }

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
          `CRDT 更新已发送：${change.relativePath}`,
          change.relativePath,
          SyncEventType.FILE_PUSHED,
        );
      }

      // Always send full FILE_CHANGE as well — CRDT binary updates are not
      // processed by the receiver (the binary frame lacks document metadata),
      // so the FILE_CHANGE text message guarantees the file content arrives.
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
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      syncLogger.log(
        LogLevel.ERROR,
        `处理本地文本变更失败：${errorMessage}`,
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
        `二进制文件已发送：${change.relativePath} (${fileSize} bytes)`,
        change.relativePath,
        SyncEventType.FILE_PUSHED,
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      syncLogger.log(
        LogLevel.ERROR,
        `处理本地二进制变更失败：${errorMessage}`,
        change.relativePath,
        SyncEventType.ERROR,
      );
      this.stats.failedFiles++;
    }
  }

  /**
   * Handle a local file deletion.
   *
   * The deleted file no longer exists on disk, so we MUST NOT read it
   * (that would throw ENOENT and silently drop the deletion). Instead we
   * emit a FILE_DELETE control message so the remote peer can delete its
   * copy and destroy the corresponding CRDT document.
   *
   * For TEXT files we additionally send a CRDT "delete to empty" update
   * (initDoc → setTextContent("") → generateUpdate → sendBinary) so the
   * remote doc converges to empty before it is destroyed.
   */
  private async handleLocalDeleteChange(change: FileChange): Promise<void> {
    try {
      const relativePath: string = change.relativePath;

      if (change.fileCategory === FileCategory.TEXT) {
        // Send a CRDT update that empties the document on the remote side.
        const docId: string = generateDocId(relativePath);
        const doc = this.crdtEngine.initDoc(docId, relativePath);
        this.crdtEngine.setTextContent(doc, "");
        const update = this.crdtEngine.generateUpdate(doc);
        this.connectionManager!.sendBinary(update);
      }

      // Control message instructing the peer to delete the file.
      const msg = createMessage(
        MessageType.FILE_DELETE,
        {
          relativePath,
          fileCategory: change.fileCategory,
        },
        this.deviceId,
        this.deviceName,
      );
      this.connectionManager!.sendMessage(msg);

      this.stats.syncedFiles++;
      this.stats.lastSyncTime = new Date().toISOString();

      syncLogger.log(
        LogLevel.SUCCESS,
        `文件删除已发送：${relativePath}`,
        relativePath,
        SyncEventType.FILE_PUSHED,
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      syncLogger.log(
        LogLevel.ERROR,
        `处理本地删除变更失败：${errorMessage}`,
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

      case MessageType.FILE_DELETE:
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
          `未处理的消息类型：${msg.type}`,
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

    const relativePath: string = payload.relativePath as string;
    const fileCategory: FileCategory = (payload.fileCategory as FileCategory) || FileCategory.TEXT;

    // Consume a remote deletion (FILE_DELETE control message). The peer
    // already removed its file, so we delete locally and destroy the CRDT
    // document to avoid an orphaned/empty doc.
    if (msg.type === MessageType.FILE_DELETE) {
      await this.osWriter.deleteFile(this.vaultPath, relativePath);
      this.crdtEngine.destroyDoc(generateDocId(relativePath));
      syncLogger.log(
        LogLevel.SUCCESS,
        `已删除远程文件：${relativePath}`,
        relativePath,
        SyncEventType.FILE_RECEIVED,
      );
      this.stats.syncedFiles++;
      return;
    }

    try {
      if (fileCategory === FileCategory.TEXT) {
        // TEXT file
        const content: string = (payload.content as string) || "";

        // Check CRDT suitability
        const docId = generateDocId(relativePath);
        if (payload.crdtUpdate) {
          // Apply CRDT update
          const update = new Uint8Array(Buffer.from(payload.crdtUpdate as string, "base64"));
          const doc = this.crdtEngine.initDoc(docId, relativePath);
          this.crdtEngine.applyUpdate(doc, update);
          const mergedContent = this.crdtEngine.getTextContent(doc);

          // Write merged content to disk
          await this.osWriter.writeFile(this.vaultPath, relativePath, mergedContent);
        } else {
          // Full content replacement
          this.crdtEngine.initDoc(docId, relativePath, content);
          await this.osWriter.writeFile(this.vaultPath, relativePath, content);
        }

        syncLogger.log(
          LogLevel.SUCCESS,
          `已接收文本文件：${relativePath}`,
          relativePath,
          SyncEventType.FILE_RECEIVED,
        );
      } else {
        // BINARY file
        const contentBase64: string = (payload.content as string) || "";
        const content = Buffer.from(contentBase64, "base64");

        // Conflict detection
        const localHash = await computeFileHash(
          path.join(this.vaultPath, relativePath),
        );
        const hasConflict = this.conflictDetector.detect(
          FileCategory.BINARY,
          localHash,
          (payload.hash as string) || "",
          0, // local mtime
          (payload.mtime as number) || 0,
          "MODIFY_VS_MODIFY",
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
              mtime: (payload.mtime as number) || 0,
              hash: (payload.hash as string) || "",
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
            `已接收二进制文件：${relativePath}`,
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
        `处理远端文件变更失败：${errorMessage}`,
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

    const docId: string = payload.docId as string;
    const updateBase64: string = payload.update as string;

    try {
      const update = new Uint8Array(Buffer.from(updateBase64, "base64"));

      // Get or create the doc
      let doc = this.crdtEngine.getDoc(docId);
      if (!doc) {
        doc = this.crdtEngine.initDoc(docId, (payload.relativePath as string) || docId);
      }

      // Apply the update
      this.crdtEngine.applyUpdate(doc, update);

      // Write merged content to disk
      const mergedContent = this.crdtEngine.getTextContent(doc);

      // Determine relative path
      const state = this.crdtEngine.getState(docId);
      const relativePath = (state && state.relativePath) || (payload.relativePath as string) || docId;

      await this.osWriter.writeFile(this.vaultPath, relativePath, mergedContent);

      syncLogger.log(
        LogLevel.DEBUG,
        `CRDT 更新已应用: ${relativePath}`,
        relativePath,
        SyncEventType.CRDT_MERGED,
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      syncLogger.log(
        LogLevel.ERROR,
        `应用 CRDT 更新失败：${errorMessage}`,
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

    const docId: string = payload.docId as string;
    const snapshotBase64: string = (payload.snapshot as string) || "";

    try {
      if (snapshotBase64) {
        // Restore from snapshot data in message
        const snapshot = new Uint8Array(Buffer.from(snapshotBase64, "base64"));
        let doc = this.crdtEngine.getDoc(docId);
        if (!doc) {
          doc = this.crdtEngine.initDoc(docId, (payload.relativePath as string) || docId);
        }
        this.crdtEngine.applyUpdate(doc, snapshot);

        const mergedContent = this.crdtEngine.getTextContent(doc);
        const relativePath = (payload.relativePath as string) || docId;
        await this.osWriter.writeFile(this.vaultPath, relativePath, mergedContent);
      } else {
        // Try restoring from local snapshot
        await this.crdtEngine.restoreFromSnapshot(docId);
      }

      syncLogger.log(
        LogLevel.SUCCESS,
        `完整 CRDT 同步已应用：${docId}`,
        docId,
        SyncEventType.CRDT_MERGED,
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      syncLogger.log(
        LogLevel.ERROR,
        `应用完整 CRDT 同步失败：${errorMessage}`,
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
      `对端通知冲突：${payload.relativePath as string}`,
      payload.relativePath as string,
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
      payload.relativePath as string,
      payload.resolution as "keep_local" | "keep_remote" | "keep_both",
    );

    syncLogger.log(
      LogLevel.INFO,
      `对端已解决冲突：${payload.relativePath as string} (${payload.resolution as string})`,
      payload.relativePath as string,
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

    syncLogger.log(LogLevel.INFO, "已请求全量同步", undefined, SyncEventType.SYNC_STARTED);
  }

  // ============================================================
  // Pending Queue
  // ============================================================

  /**
   * Flush all 待发变更 from the queue (called on reconnection).
   */
  async flushPendingQueue(): Promise<void> {
    if (this.pendingQueue.size() === 0) {
      return;
    }

    syncLogger.log(
      LogLevel.INFO,
      `正在刷新 ${this.pendingQueue.size()} 待发变更`,
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
    this.conflictDetector.resolveConflict(path, resolution);

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

    // Count conflicted/failed files from the live file-state map.
    //
    // NOTE on `syncedFiles`: it is sourced from the cumulative
    // `this.stats.syncedFiles` counter, which is incremented on every
    // successful push (handleLocalChange) and pull (handleRemoteFileChange)
    // and seeded with the full-sync baseline in setInitialSyncCount().
    // We deliberately do NOT recompute it from `vaultFileCount` /
    // `initialSyncFileCount` / fileStates here — that would discard the
    // runtime increments and make the settings panel ("已同步文件") show 0
    // whenever a full sync has not completed in the current session.
    let conflictedCount = 0;
    let failedCount = 0;
    for (const state of this.fileStates.values()) {
      if (state.status === SyncStatus.CONFLICTED) {
        conflictedCount++;
      } else if (state.status === SyncStatus.FAILED) {
        failedCount++;
      }
    }

    return {
      ...this.stats,
      syncedFiles: this.stats.syncedFiles,
      vaultFileCount: this.vaultFileCount,
      conflictedFiles: conflictedCount,
      failedFiles: failedCount,
    };
  }

  /**
   * Set total vault file count (from initial sync manifest).
   * This gives a meaningful "已同步文件" number to the user.
   */
  setVaultFileCount(count: number): void {
    this.vaultFileCount = count;
  }

  /**
   * Whether the engine is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Update the last sync time. Called when initial sync completes.
   */
  setLastSyncTime(time: string): void {
    this.stats.lastSyncTime = time;
  }

  /**
   * Set the count of 个文件已传输 during the initial full sync.
   *
   * As a side effect this seeds the cumulative "synced files" counter
   * (`this.stats.syncedFiles`) with the full-sync baseline, so the settings
   * panel ("已同步文件") reflects a meaningful total (the number of files the
   * full sync actually moved) even before any incremental push/pull occurs,
   * and the value survives restarts (the full sync re-runs on each load).
   * Math.max keeps any increments already accumulated through live syncs.
   */
  setInitialSyncCount(count: number): void {
    this.initialSyncFileCount = count;
    this.stats.syncedFiles = Math.max(this.stats.syncedFiles, count);
  }
}
