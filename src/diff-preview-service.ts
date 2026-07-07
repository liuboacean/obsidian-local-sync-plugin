// ============================================================
// Diff Preview Service — Diff Preview Before Sync (Feature 2)
// ============================================================
// Intercepts SyncEngine.handleLocalChange via a BeforeSendHook.
// When enabled and the change matches the whitelist, it reads the
// current file content/meta, opens a DiffPreviewModal, and resolves
// the user's decision (CONFIRM / SKIP / CONFIRM_ALL).
//
// Multiple concurrent changes are serialized through a promise chain
// so that only one modal is visible at a time. Selecting CONFIRM_ALL
// engages a session-wide "confirm all" mode that lets subsequent
// changes pass through without a dialog.
//
// Disk access uses top-level static imports of `fs/promises` (never
// dynamic import) for compatibility with the esbuild / Electron bundle.

import * as path from "path";
import * as crypto from "crypto";
import { readFile, stat } from "fs/promises";
import type { App } from "obsidian";
import {
  FileChange,
  FileCategory,
  ChangeType,
  SyncSettings,
  DiffPreviewAction,
  DiffPreviewRequest,
  DiffPreviewResult,
  BeforeSendHook,
  BinaryMeta,
} from "./types";
import { HASH_SIZE_LIMIT_BYTES } from "./constants";
import { normalizePath } from "./utils";
import { DiffPreviewModal } from "./diff-preview-modal";

// ============================================================
// Service Class
// ============================================================

export class DiffPreviewService {
  /** Whether the feature is enabled (mirrors SyncSettings.enableDiffPreview). */
  private enabled = false;
  /** Whitelisted folders; empty = all folders. */
  private whitelistFolders: string[] = [];
  /** Active requests keyed by requestId (for external cancellation). */
  private pendingRequests: Map<string, DiffPreviewRequest> = new Map();
  /** Session-wide "confirm all" latch. */
  private confirmAllMode = false;
  /** The currently open modal, if any. */
  private activeModal: DiffPreviewModal | null = null;
  /** Serializes modal display so only one shows at a time. */
  private queueChain: Promise<DiffPreviewResult> = Promise.resolve({
    requestId: "",
    action: DiffPreviewAction.CONFIRM,
  });
  /** Last synced TEXT content per path (enables meaningful diffs). */
  private lastSyncedContent: Map<string, string> = new Map();
  /** Last synced BINARY meta per path. */
  private lastSyncedMeta: Map<string, BinaryMeta> = new Map();

  constructor(private app: App) {}

  // ============================================================
  // Hook factory
  // ============================================================

  /**
   * Build the BeforeSendHook consumed by SyncEngine.
   */
  createHook(): BeforeSendHook {
    return {
      name: "diff-preview",
      handler: async (
        change: FileChange,
        vaultPath: string,
      ): Promise<boolean> => {
        return this.handleHook(change, vaultPath);
      },
    };
  }

  // ============================================================
  // Configuration
  // ============================================================

  /**
   * Sync runtime configuration from SyncSettings.
   * Called on init and whenever the relevant settings change.
   */
  updateConfig(settings: SyncSettings): void {
    this.enabled = settings.enableDiffPreview ?? false;
    this.whitelistFolders = settings.diffPreviewWhitelistFolders ?? [];

    if (!this.enabled) {
      // Disable → reset latch and drop pending tracking.
      this.confirmAllMode = false;
      this.pendingRequests.clear();
    }
  }

  // ============================================================
  // Hook entry point
  // ============================================================

  /**
   * Invoked by SyncEngine before transmitting a local change.
   * Returns true to proceed with the send, false to skip it.
   */
  private async handleHook(
    change: FileChange,
    vaultPath: string,
  ): Promise<boolean> {
    if (!this.shouldPreview(change)) {
      return true;
    }

    const result = await this.enqueue(() =>
      this.createRequest(change, vaultPath),
    );

    switch (result.action) {
      case DiffPreviewAction.SKIP:
        return false;
      case DiffPreviewAction.CONFIRM_ALL:
        this.confirmAllMode = true;
        return true;
      case DiffPreviewAction.CONFIRM:
      default:
        return true;
    }
  }

  // ============================================================
  // Queue serialization
  // ============================================================

  /**
   * Append a request builder to the serial chain. Only one chain link
   * runs at a time, guaranteeing a single open modal.
   */
  private enqueue(
    builder: () => Promise<DiffPreviewResult>,
  ): Promise<DiffPreviewResult> {
    const run = this.queueChain.then(
      () => builder(),
      () => builder(),
    );
    // Keep the chain alive even if a builder rejects.
    this.queueChain = run.catch(() => ({
      requestId: "",
      action: DiffPreviewAction.CONFIRM,
    }));
    return run;
  }

  // ============================================================
  // Preview decision
  // ============================================================

  /**
   * Decide whether a change should trigger the diff preview.
   */
  private shouldPreview(change: FileChange): boolean {
    if (!this.enabled) {
      return false;
    }
    // Deletions have no meaningful diff → pass through.
    if (change.type === ChangeType.DELETE) {
      return false;
    }
    // Once "confirm all" is engaged, skip further dialogs.
    if (this.confirmAllMode) {
      return false;
    }
    // Empty whitelist → all folders.
    if (this.whitelistFolders.length === 0) {
      return true;
    }
    const rel = normalizePath(change.relativePath);
    return this.whitelistFolders.some((folder) => {
      const f = normalizePath(folder).replace(/\/+$/, "");
      if (f.length === 0) {
        return true;
      }
      return rel === f || rel.startsWith(f + "/");
    });
  }

  /**
   * Build and open the diff-preview modal, returning the user's decision.
   * Large text files degrade to binary (meta-only) comparison.
   * Never rejects — on any failure it resolves CONFIRM so sync proceeds.
   */
  private async createRequest(
    change: FileChange,
    vaultPath: string,
  ): Promise<DiffPreviewResult> {
    // If "confirm all" was engaged while this request waited in the chain,
    // skip the dialog and proceed.
    if (this.confirmAllMode) {
      return { requestId: "", action: DiffPreviewAction.CONFIRM };
    }

    try {
      const requestId = crypto.randomUUID();
      const isLargeText =
        change.fileCategory === FileCategory.TEXT &&
        change.size > HASH_SIZE_LIMIT_BYTES;

      let currentContent: string | undefined;
      let newContent: string | undefined;
      let currentMeta: BinaryMeta | undefined;
      let newMeta: BinaryMeta | undefined;

      if (!isLargeText && change.fileCategory === FileCategory.TEXT) {
        newContent = await this.readTextContent(vaultPath, change.relativePath);
        // Baseline = last synced content for this path (empty on first edit).
        currentContent = this.lastSyncedContent.get(change.relativePath) ?? "";
      } else {
        newMeta = await this.readBinaryMeta(vaultPath, change);
        currentMeta = this.lastSyncedMeta.get(change.relativePath);
      }

      const requestIdFinal = requestId;
      let settle!: (result: DiffPreviewResult) => void;
      const promise = new Promise<DiffPreviewResult>((resolve) => {
        settle = resolve;
      });

      const request: DiffPreviewRequest = {
        requestId,
        change,
        currentContent,
        newContent,
        currentMeta,
        newMeta,
        createdAt: new Date(),
        resolve: (result: DiffPreviewResult) => {
          this.pendingRequests.delete(requestIdFinal);
          this.recordSynced(change, result, newContent, newMeta);
          if (result.action === DiffPreviewAction.CONFIRM_ALL) {
            this.confirmAllMode = true;
          }
          this.activeModal = null;
          settle(result);
        },
        reject: () => {
          this.pendingRequests.delete(requestIdFinal);
          this.activeModal = null;
          // A rejected request should not block sync — proceed.
          settle({ requestId, action: DiffPreviewAction.CONFIRM });
        },
      };

      this.pendingRequests.set(requestId, request);

      const modal = new DiffPreviewModal(this.app, request, {
        showConfirmAll: this.pendingRequests.size > 1,
      });
      this.activeModal = modal;
      modal.open();

      return promise;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[DiffPreview] request failed, proceeding with sync: ${message}`,
      );
      return { requestId: "", action: DiffPreviewAction.CONFIRM };
    }
  }

  /**
   * Record the synced content/meta so the next edit can be diffed against it.
   */
  private recordSynced(
    change: FileChange,
    result: DiffPreviewResult,
    newContent: string | undefined,
    newMeta: BinaryMeta | undefined,
  ): void {
    if (result.action === DiffPreviewAction.SKIP) {
      return;
    }
    if (change.fileCategory === FileCategory.TEXT) {
      if (newContent !== undefined) {
        this.lastSyncedContent.set(change.relativePath, newContent);
      }
    } else if (newMeta) {
      this.lastSyncedMeta.set(change.relativePath, newMeta);
    }
  }

  // ============================================================
  // File readers (static imports only)
  // ============================================================

  /**
   * Read a TEXT file's content as a UTF-8 string.
   * Returns "" on any error (empty baseline).
   */
  private async readTextContent(
    vaultPath: string,
    relativePath: string,
  ): Promise<string> {
    const fullPath = path.join(vaultPath, relativePath);
    try {
      return await readFile(fullPath, "utf-8");
    } catch {
      return "";
    }
  }

  /**
   * Read BINARY file metadata (size / hash / mtime).
   * Falls back to the FileChange-provided values when the file is missing.
   */
  private async readBinaryMeta(
    vaultPath: string,
    change: FileChange,
  ): Promise<BinaryMeta> {
    const fullPath = path.join(vaultPath, change.relativePath);
    let size = change.size;
    let mtime = change.mtime;
    const hash = change.hash;
    try {
      const st = await stat(fullPath);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      // File may have been deleted — fall back to change metadata.
    }
    return { size, hash, mtime };
  }
}
