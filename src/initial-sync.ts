// ============================================================
// Initial Sync Manager
// ============================================================
// Handles the initial synchronization between two devices.
//
// Phase 1 — Metadata Exchange:
//   Send file manifest in batches (FILE_LIST_BATCH, 100 files per batch),
//   peer responds with FILE_LIST_ACK containing missing + different files.
//
// Phase 2 — Incremental Transfer:
//   Missing TEXT files: full content + CRDT init (syncFullDoc)
//   Missing BINARY files: full file transfer
//   Sorted by file size ascending (small files first), 10 concurrent transfers.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  FileCategory,
  MessageType,
  SyncMessage,
} from "./types";
import {
  FILE_LIST_BATCH_SIZE,
  EVENTS,
} from "./constants";
import {
  computeFileHash,
  classifyFile,
  generateDocId,
  normalizePath,
} from "./utils";
import { createMessage } from "./protocol";
import { ConnectionManager } from "./connection-manager";
import { CrdtEngine } from "./crdt-engine";
import { OsWriter } from "./os-writer";
import { debugLog, syncLogger } from "./sync-logger";
import { LogLevel, SyncEventType } from "./types";

// ============================================================
// Types
// ============================================================

export interface SyncProgress {
  total: number;
  completed: number;
  current: string;
}

export interface ManifestEntry {
  relativePath: string;
  mtime: number;
  hash: string;
  fileCategory: FileCategory;
  size: number;
}

interface FullSyncOptions {
  vaultPath: string;
  deviceId: string;
  deviceName: string;
  connectionManager: ConnectionManager;
  crdtEngine: CrdtEngine;
  osWriter: OsWriter;
  onProgress?: (progress: SyncProgress) => void;
  /** Called when full initial sync completes (all file transfers done).
   * @param totalTransferred - Number of 个文件已传输 this sync
   * @param vaultFileCount - Total number of files in local vault manifest */
  onFullSyncComplete?: (totalTransferred: number, vaultFileCount: number) => void;
  /** Called as soon as the local vault manifest is scanned, independent of
   * whether the full-sync protocol completes. Keeps the "vault 文件总数"
   * stat meaningful even on incremental reconnects where the peer doesn't
   * finish the ACK handshake (allComplete never fires). */
  onVaultScanned?: (vaultFileCount: number) => void;
}

// ============================================================
// Constants
// ============================================================

const MANIFEST_DIR_NAME = ".obsidian-sync";
const MANIFEST_FILE_NAME = "manifest.json";
const CONCURRENT_TRANSFERS = 10;
/** Max time (ms) to spend computing hash for a single file during batch comparison.
 *  If exceeded, the file is treated as "different" and re-synced. */
const HASH_TIMEOUT_MS = 5000;

// ============================================================
// Helpers
// ============================================================

/**
 * Race a promise against a timeout.
 * Resolves to the promise's value, or rejects with "timeout" if the
 * timeout expires first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: number | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = window.setTimeout(() => resolve("timeout"), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) window.clearTimeout(timer);
  });
}

/**
 * Check whether a local file matches the remote hash.
 * Returns "same" | "different" | "missing".
 */
async function compareLocalFile(
  localPath: string,
  remoteHash: string,
): Promise<"same" | "different" | "missing"> {
  try {
    await fs.promises.access(localPath, fs.constants.R_OK);
    const localHash = await computeFileHash(localPath);
    if (localHash !== "" && localHash === remoteHash) {
      return "same";
    }
    return "different";
  } catch {
    return "missing";
  }
}

// ============================================================
// Initial Sync Manager Class
// ============================================================

export class InitialSyncManager {
  private options: FullSyncOptions;
  private cancelled = false;
  private progress: SyncProgress = { total: 0, completed: 0, current: "" };

  /** Local file manifest — used by handleFileListAck to find files to transfer. */
  private localManifest: ManifestEntry[] = [];

  /** Total 个文件已传输 during this sync session. */
  private transferredCount = 0;

  /** Batch index tracking for multi-batch file list exchange. */
  private receivedBatches: Set<number> = new Set();
  private totalBatches = 0;

  constructor(options: FullSyncOptions) {
    this.options = options;
  }

  // ============================================================
  // Main Entry Point
  // ============================================================

  /**
   * Start the full initial synchronization process.
   */
  async startFullSync(): Promise<void> {
    this.cancelled = false;
    this.progress = { total: 0, completed: 0, current: "" };

    syncLogger.log(
      LogLevel.INFO,
      "正在开始全量初始同步",
      undefined,
      SyncEventType.SYNC_STARTED,
    );

    try {
      // Phase 1: Build and exchange manifest
      const manifest = await this.buildManifest();
      this.localManifest = manifest;
      this.progress.total = manifest.length;
      this.progress.completed = 0;

      // Report vault file count as soon as the local manifest is scanned,
      // independent of whether the full-sync protocol completes (allComplete).
      // This keeps the "vault 文件总数" stat meaningful even on incremental
      // reconnects where the peer doesn't finish the ACK handshake.
      this.options.onVaultScanned?.(this.localManifest.length);

      // Save manifest to disk for resume capability
      await this.saveManifest(manifest);

      // Send manifest in batches
      await this.sendManifestBatches(manifest);

      // Phase 2: Receive and process peer's ACK (handled by sync engine)
      // Phase 2 transfers are triggered by FILE_LIST_ACK responses
      // This is handled externally via handleFileListAck()

      syncLogger.log(
        LogLevel.SUCCESS,
        `全量同步开始: ${manifest.length} 个文件在清单中`,
        undefined,
        SyncEventType.SYNC_STARTED,
      );

      this.emitProgress();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      syncLogger.log(
        LogLevel.ERROR,
        `全量同步出错：${errorMessage}`,
        undefined,
        SyncEventType.ERROR,
      );
      throw err;
    }
  }

  /**
   * Get current sync progress.
   */
  getSyncProgress(): SyncProgress {
    return { ...this.progress };
  }

  /**
   * Cancel the current sync operation.
   */
  cancelSync(): void {
    this.cancelled = true;
    syncLogger.log(
      LogLevel.INFO,
      "全量同步已被用户取消",
      undefined,
      SyncEventType.DISCONNECTED,
    );
  }

  // ============================================================
  // Phase 1 — Manifest Building
  // ============================================================

  /**
   * Build a file manifest by scanning the vault directory.
   * Excludes hidden files and common ignore patterns.
   */
  private async buildManifest(): Promise<ManifestEntry[]> {
    const manifest: ManifestEntry[] = [];
    const vaultPath = this.options.vaultPath;

    try {
      const entries = await this.scanDirectory(vaultPath, vaultPath);
      manifest.push(...entries);
    } catch (err: unknown) {
      syncLogger.log(
        LogLevel.ERROR,
        `构建清单失败：${err}`,
        undefined,
        SyncEventType.ERROR,
      );
    }

    // Sort by size ascending (small files first)
    manifest.sort((a, b) => a.size - b.size);

    return manifest;
  }

  /**
   * Recursively scan a directory for files.
   */
  private async scanDirectory(
    rootPath: string,
    currentPath: string,
  ): Promise<ManifestEntry[]> {
    const entries: ManifestEntry[] = [];

    try {
      const dirEntries = await fs.promises.readdir(currentPath, {
        withFileTypes: true,
      });

      for (const entry of dirEntries) {
        if (this.cancelled) {
          return entries;
        }

        const fullPath = path.join(currentPath, entry.name);
        const relativePath = normalizePath(path.relative(rootPath, fullPath));

        // Skip hidden files/directories and node_modules
        if (entry.name.startsWith(".") || entry.name === "node_modules") {
          continue;
        }

        if (entry.isDirectory()) {
          const subEntries = await this.scanDirectory(rootPath, fullPath);
          entries.push(...subEntries);
        } else if (entry.isFile()) {
          try {
            const stats = await fs.promises.stat(fullPath);
            const fileCategory = classifyFile(fullPath);
            const hash = await computeFileHash(fullPath);

            entries.push({
              relativePath,
              mtime: stats.mtimeMs,
              hash,
              fileCategory,
              size: stats.size,
            });
          } catch {
            // Skip files we can't read
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }

    return entries;
  }

  // ============================================================
  // Manifest Persistence (for resume)
  // ============================================================

  /**
   * Get the manifest file path.
   */
  private getManifestPath(): string {
    const homeDir = os.homedir();
    return path.join(homeDir, MANIFEST_DIR_NAME, MANIFEST_FILE_NAME);
  }

  /**
   * Save the manifest to disk (for resume capability).
   */
  private async saveManifest(manifest: ManifestEntry[]): Promise<void> {
    const manifestPath = this.getManifestPath();
    const manifestDir = path.dirname(manifestPath);

    try {
      await fs.promises.mkdir(manifestDir, { recursive: true });
      await fs.promises.writeFile(
        manifestPath,
        JSON.stringify(manifest, null, 2),
        "utf-8",
      );
    } catch {
      // Non-critical; skip
    }
  }

  /**
   * Load a cached manifest from disk.
   */
  async loadCachedManifest(): Promise<ManifestEntry[] | null> {
    try {
      const manifestPath = this.getManifestPath();
      const data = await fs.promises.readFile(manifestPath, "utf-8");
      return JSON.parse(data) as ManifestEntry[];
    } catch {
      return null;
    }
  }

  // ============================================================
  // Phase 1 — Manifest Batches
  // ============================================================

  /**
   * Send the file manifest to the remote peer in batches.
   */
  private async sendManifestBatches(
    manifest: ManifestEntry[],
  ): Promise<void> {
    const totalFiles = manifest.length;
    this.totalBatches = Math.ceil(totalFiles / FILE_LIST_BATCH_SIZE);

    for (let batchIndex = 0; batchIndex < this.totalBatches; batchIndex++) {
      if (this.cancelled) {
        return;
      }

      const start = batchIndex * FILE_LIST_BATCH_SIZE;
      const end = Math.min(start + FILE_LIST_BATCH_SIZE, totalFiles);
      const batch = manifest.slice(start, end);

      const msg = createMessage(
        MessageType.FILE_LIST_BATCH,
        {
          batchIndex,
          totalBatches: this.totalBatches,
          totalFiles,
          files: batch.map((entry) => ({
            relativePath: entry.relativePath,
            mtime: entry.mtime,
            hash: entry.hash,
            fileCategory: entry.fileCategory,
            size: entry.size,
          })),
        },
        this.options.deviceId,
        this.options.deviceName,
      );

      this.options.connectionManager.sendMessage(msg);

      this.progress.current = `Sending batch ${batchIndex + 1}/${this.totalBatches}`;
      this.emitProgress();
    }
  }

  // ============================================================
  // Phase 1 — Handle Remote Batch
  // ============================================================

  /**
   * Handle an incoming FILE_LIST_BATCH message from the remote peer.
   *
   * @param msg - The FILE_LIST_BATCH message.
   * @returns An array of missing/different files to request.
   */
  async handleRemoteBatch(
    msg: SyncMessage,
  ): Promise<{ missing: ManifestEntry[]; different: ManifestEntry[] }> {
    const payload = msg.payload;
    if (!payload || !payload.files) {
      debugLog("[ObsSync] handleRemoteBatch: 负载中无文件");
      return { missing: [], different: [] };
    }

    const batchIndex: number = payload.batchIndex as number;
    const remoteFiles: ManifestEntry[] = payload.files as ManifestEntry[];
    debugLog("[ObsSync] handleRemoteBatch batch=" + batchIndex + " files=" + remoteFiles.length);

    if (this.receivedBatches.has(batchIndex)) {
      return { missing: [], different: [] };
    }
    this.receivedBatches.add(batchIndex);

    const missing: ManifestEntry[] = [];
    const different: ManifestEntry[] = [];

    for (const remoteEntry of remoteFiles) {
      if (this.cancelled) {
        return { missing: [], different: [] };
      }

      const localPath = path.join(
        this.options.vaultPath,
        remoteEntry.relativePath,
      );

      // Compare file with timeout — if hashing takes too long, treat as
      // "different" so the file gets re-synced rather than hanging forever.
      const result = await withTimeout(
        compareLocalFile(localPath, remoteEntry.hash),
        HASH_TIMEOUT_MS,
      );

      if (result === "missing") {
        missing.push(remoteEntry);
      } else if (result === "different") {
        different.push(remoteEntry);
        syncLogger.log(
          LogLevel.DEBUG,
          `处理远端批次：哈希超时 "${remoteEntry.relativePath}" — 标记为不同`,
          remoteEntry.relativePath,
          SyncEventType.FILE_PUSHED,
        );
      }
      // "same" → skip, file is already in sync
    }

    // Send ACK with missing/different lists
    debugLog("[ObsSync] handleRemoteBatch 完成 batch=" + batchIndex + " missing=" + missing.length + " different=" + different.length);
    const ackMsg = createMessage(
      MessageType.FILE_LIST_ACK,
      {
        batchIndex,
        missing: missing.map((e) => e.relativePath),
        different: different.map((e) => e.relativePath),
        allComplete:
          this.receivedBatches.size >= ((payload.totalBatches as number) || Infinity),
      },
      this.options.deviceId,
      this.options.deviceName,
    );
    this.options.connectionManager.sendMessage(ackMsg);

    this.progress.total += missing.length + different.length;
    this.emitProgress();

    return { missing, different };
  }

  // ============================================================
  // Phase 2 — Handle File List ACK
  // ============================================================

  /**
   * Handle an incoming FILE_LIST_ACK message.
   * Initiates file transfers for missing/different files.
   *
   * @param msg - The FILE_LIST_ACK message.
   * @param localManifest - The local file manifest.
   */
  async handleFileListAck(msg: SyncMessage): Promise<void> {
    const payload = msg.payload;
    if (!payload) {
      return;
    }

    const missingPaths: string[] = (payload.missing as string[]) || [];
    const differentPaths: string[] = (payload.different as string[]) || [];

    // Build map for quick lookup
    const manifestMap = new Map<string, ManifestEntry>();
    for (const entry of this.localManifest) {
      manifestMap.set(entry.relativePath, entry);
    }

    // Collect all files to transfer
    const toTransfer: ManifestEntry[] = [];
    for (const relativePath of missingPaths) {
      const entry = manifestMap.get(relativePath);
      if (entry) {
        toTransfer.push(entry);
      }
    }
    for (const relativePath of differentPaths) {
      const entry = manifestMap.get(relativePath);
      if (entry) {
        toTransfer.push(entry);
      }
    }

    if (toTransfer.length === 0) {
      syncLogger.log(
        LogLevel.SUCCESS,
        "所有文件已同步（无需传输）",
        undefined,
        SyncEventType.SYNC_COMPLETED,
      );
      this.emitProgress();
      if (payload.allComplete) {
        this.options.onFullSyncComplete?.(this.transferredCount, this.localManifest.length);
      }
      return;
    }

    // Sort by size ascending (small files first)
    toTransfer.sort((a, b) => a.size - b.size);

    this.progress.total = toTransfer.length;
    this.progress.completed = 0;

    // Transfer in concurrent batches
    await this.transferFiles(toTransfer);

    if (!this.cancelled) {
      syncLogger.log(
        LogLevel.SUCCESS,
        `全量同步完成: ${toTransfer.length} 个文件已传输`,
        undefined,
        SyncEventType.SYNC_COMPLETED,
      );
      this.emitProgress();
      // Notify the host that full sync is complete.
      // If allComplete is set, this is the last ACK batch.
      if (payload.allComplete) {
        this.options.onFullSyncComplete?.(this.transferredCount, this.localManifest.length);
      }
    }
  }

  // ============================================================
  // Phase 2 — File Transfer
  // ============================================================

  /**
   * Transfer a list of files with concurrency control.
   */
  private async transferFiles(files: ManifestEntry[]): Promise<void> {
    const queue = [...files];

    async function worker(manager: InitialSyncManager): Promise<void> {
      while (!manager.cancelled) {
        const entry = queue.shift();
        if (!entry) {
          return;
        }
        await manager.transferSingleFile(entry);
      }
    }

    const workers: Promise<void>[] = [];
    const workerCount = Math.min(CONCURRENT_TRANSFERS, files.length);

    for (let i = 0; i < workerCount; i++) {
      workers.push(worker(this));
    }

    await Promise.all(workers);
  }

  /**
   * Transfer a single file to the remote peer.
   */
  private async transferSingleFile(entry: ManifestEntry): Promise<void> {
    try {
      this.progress.current = entry.relativePath;

      const fullPath = path.join(this.options.vaultPath, entry.relativePath);
      const content = await fs.promises.readFile(fullPath);

      if (entry.fileCategory === FileCategory.TEXT) {
        // TEXT: Send as CRDT full sync
        const contentStr = content.toString("utf-8");
        const docId = generateDocId(entry.relativePath);

        // Create CRDT doc and send full snapshot
        const doc = this.options.crdtEngine.initDoc(
          docId,
          entry.relativePath,
          contentStr,
        );
        const snapshot = this.options.crdtEngine.syncFullDoc(doc);

        const msg = createMessage(
          MessageType.CRDT_SYNC_FULL,
          {
            docId,
            relativePath: entry.relativePath,
            snapshot: Buffer.from(snapshot).toString("base64"),
            mtime: entry.mtime,
            size: entry.size,
          },
          this.options.deviceId,
          this.options.deviceName,
        );
        this.options.connectionManager.sendMessage(msg);
      } else {
        // BINARY: Send as full file
        const msg = createMessage(
          MessageType.FILE_CHANGE,
          {
            relativePath: entry.relativePath,
            fileCategory: FileCategory.BINARY,
            content: content.toString("base64"),
            hash: entry.hash,
            mtime: entry.mtime,
            size: entry.size,
          },
          this.options.deviceId,
          this.options.deviceName,
        );
        this.options.connectionManager.sendMessage(msg);
      }

      this.progress.completed++;
      this.transferredCount++;
      this.emitProgress();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      syncLogger.log(
        LogLevel.WARN,
        `传输文件失败：${errorMessage}`,
        entry.relativePath,
        SyncEventType.ERROR,
      );
      // Continue with other files
    }
  }

  // ============================================================
  // Progress Events
  // ============================================================

  /**
   * Emit the sync progress event.
   */
  private emitProgress(): void {
    const progress = this.getSyncProgress();
    this.options.connectionManager.emit(EVENTS.SYNC_PROGRESS, progress);

    if (this.options.onProgress) {
      this.options.onProgress(progress);
    }
  }

  /**
   * Get the number of 个文件已传输 in the current sync session.
   */
  getTransferredCount(): number {
    return this.transferredCount;
  }

  /**
   * Reset state for a new sync session.
   */
  reset(): void {
    this.cancelled = false;
    this.receivedBatches.clear();
    this.totalBatches = 0;
    this.progress = { total: 0, completed: 0, current: "" };
  }
}
