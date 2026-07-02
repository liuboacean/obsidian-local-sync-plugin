// ============================================================
// Yjs CRDT Engine
// ============================================================
// Manages Yjs CRDT document instances for conflict-free text sync.
// Each tracked file gets a Y.Doc with a Y.Text type for character-level
// merging. Binary files and files > 50MB skip CRDT and fall back to
// full-file transfer.
//
// Snapshot directory: ~/.obsidian-sync/crdt/

import * as Y from "yjs";
import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { CrdtSyncState, FileCategory } from "./types";
import {
  CRDT_SNAPSHOT_INTERVAL_MS,
  CRDT_MAX_DOC_SIZE_BYTES,
} from "./constants";

// ============================================================
// Constants
// ============================================================

const CRDT_DIR_NAME = ".obsidian-sync";
const CRDT_SUBDIR_NAME = "crdt";
const SNAPSHOT_FILE_EXT = ".yjs";
const GC_EDIT_INTERVAL = 1000; // Trigger GC every 1000 edits

// ============================================================
// CRDT Engine Class
// ============================================================

export class CrdtEngine extends EventEmitter {
  /** Map of docId -> Y.Doc instance. */
  private docs: Map<string, Y.Doc> = new Map();

  /** Map of docId -> CrdtSyncState metadata. */
  private states: Map<string, CrdtSyncState> = new Map();

  /** Map of docId -> edit counter (for GC scheduling). */
  private editCounters: Map<string, number> = new Map();

  /** Map of docId -> save threshold timer. */
  private dirtyTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** Dirty-flag snapshot interval timer. */
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;

  /** Snapshot directory path (resolved on init). */
  private snapshotDir: string = "";

  /** Whether the engine has been initialized. */
  private initialized = false;

  constructor() {
    super();
    this.setMaxListeners(20);
  }

  // ============================================================
  // Initialization
  // ============================================================

  /**
   * Initialize the CRDT engine.
   * Creates the snapshot directory and starts the dirty-flag snapshot timer.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Resolve snapshot directory
    const homeDir = process.env.HOME || process.env.USERPROFILE || ".";
    this.snapshotDir = path.join(homeDir, CRDT_DIR_NAME, CRDT_SUBDIR_NAME);

    try {
      await fs.promises.mkdir(this.snapshotDir, { recursive: true });
    } catch {
      // Directory may already exist
    }

    // Start periodic snapshot timer
    this.snapshotTimer = window.setInterval(() => {
      this.snapshotAllDirty().catch(() => {
        // Silently ignore snapshot errors
      });
    }, CRDT_SNAPSHOT_INTERVAL_MS);

    this.initialized = true;
  }

  /**
   * Destroy the CRDT engine.
   * Destroys all documents and clears all timers.
   */
  destroy(): void {
    if (this.snapshotTimer) {
      window.clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    for (const timer of this.dirtyTimers.values()) {
      window.clearTimeout(timer);
    }
    this.dirtyTimers.clear();

    for (const doc of this.docs.values()) {
      doc.destroy();
    }
    this.docs.clear();
    this.states.clear();
    this.editCounters.clear();

    this.initialized = false;
  }

  // ============================================================
  // Document Management
  // ============================================================

  /**
   * Initialize a Y.Doc for the given docId.
   * If the document already exists, returns it.
   *
   * @param docId - The document identifier (CRDT document ID).
   * @param relativePath - The relative file path (for metadata).
   * @param initialContent - Optional initial text content.
   * @returns The Y.Doc instance.
   */
  initDoc(docId: string, relativePath: string, initialContent?: string): Y.Doc {
    const existing = this.docs.get(docId);
    if (existing) {
      return existing;
    }

    const doc = new Y.Doc();

    // Attach Y.Text type
    const ytext = doc.getText("content");

    if (initialContent !== undefined && initialContent !== null) {
      ytext.insert(0, initialContent);
    }

    // Set up "observe" to mark as dirty on changes
    ytext.observe(() => {
      const state = this.states.get(docId);
      if (state) {
        state.isDirty = true;
        state.lastUpdateTime = Date.now();
      }

      // Increment edit counter and trigger GC if needed
      const counter = (this.editCounters.get(docId) || 0) + 1;
      this.editCounters.set(docId, counter);
      if (counter >= GC_EDIT_INTERVAL) {
        this.editCounters.set(docId, 0);
        this.gc(doc);
      }
    });

    // Register the document
    this.docs.set(docId, doc);

    const state: CrdtSyncState = {
      docId,
      relativePath,
      lastSnapshotTime: 0,
      lastUpdateTime: Date.now(),
      isDirty: false,
      docSize: this.getDocSize(doc),
    };
    this.states.set(docId, state);

    return doc;
  }

  /**
   * Get an existing Y.Doc by docId.
   */
  getDoc(docId: string): Y.Doc | undefined {
    return this.docs.get(docId);
  }

  /**
   * Destroy a specific document and release its memory.
   */
  destroyDoc(docId: string): void {
    const doc = this.docs.get(docId);
    if (doc) {
      doc.destroy();
      this.docs.delete(docId);
    }

    this.states.delete(docId);
    this.editCounters.delete(docId);

    const timer = this.dirtyTimers.get(docId);
    if (timer) {
      window.clearTimeout(timer);
      this.dirtyTimers.delete(docId);
    }
  }

  // ============================================================
  // Text Content Operations
  // ============================================================

  /**
   * Set the text content of a Y.Doc's Y.Text type.
   * Replaces all existing content.
   */
  setTextContent(doc: Y.Doc, content: string): void {
    doc.transact(() => {
      const ytext = doc.getText("content");
      ytext.delete(0, ytext.length);
      ytext.insert(0, content);
    });
  }

  /**
   * Get the current text content from a Y.Doc's Y.Text type.
   */
  getTextContent(doc: Y.Doc): string {
    const ytext = doc.getText("content");
    return ytext.toString();
  }

  // ============================================================
  // CRDT Update Operations
  // ============================================================

  /**
   * Generate an incremental update (operation-based diff) from a Y.Doc.
   * Used to send only the changes since the last sync.
   */
  generateUpdate(doc: Y.Doc): Uint8Array {
    return Y.encodeStateAsUpdate(doc);
  }

  /**
   * Apply an incremental update (operation-based diff) to a Y.Doc.
   * Used to merge changes received from a remote peer.
   */
  applyUpdate(doc: Y.Doc, update: Uint8Array): void {
    Y.applyUpdate(doc, update);
  }

  /**
   * Generate a full document snapshot (complete state vector).
   * Used for initial sync and full re-sync after reconnection.
   */
  syncFullDoc(doc: Y.Doc): Uint8Array {
    return Y.encodeStateAsUpdate(doc);
  }

  // ============================================================
  // Snapshot Operations
  // ============================================================

  /**
   * Snapshot all dirty documents to disk.
   * Only runs if CRDT_SNAPSHOT_INTERVAL_MS has elapsed since the last snapshot.
   */
  async snapshotAllDirty(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    const now = Date.now();

    for (const [docId, state] of this.states.entries()) {
      if (
        !state.isDirty ||
        now - state.lastSnapshotTime < CRDT_SNAPSHOT_INTERVAL_MS
      ) {
        continue;
      }

      const doc = this.docs.get(docId);
      if (!doc) {
        continue;
      }

      try {
        const snapshot = Y.encodeStateAsUpdate(doc);
        const snapshotPath = path.join(this.snapshotDir, `${docId}${SNAPSHOT_FILE_EXT}`);
        await fs.promises.writeFile(snapshotPath, Buffer.from(snapshot));
        state.lastSnapshotTime = now;
        state.isDirty = false;
      } catch {
        // Silently ignore snapshot write errors
      }
    }
  }

  /**
   * Restore a document from its last snapshot on disk.
   *
   * @param docId - The document identifier.
   * @returns true if the snapshot was found and applied successfully.
   */
  async restoreFromSnapshot(docId: string): Promise<boolean> {
    const snapshotPath = path.join(this.snapshotDir, `${docId}${SNAPSHOT_FILE_EXT}`);

    try {
      const data = await fs.promises.readFile(snapshotPath);
      const snapshot = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

      // Create or get the doc
      let doc = this.docs.get(docId);
      if (!doc) {
        doc = new Y.Doc();
        this.docs.set(docId, doc);
      }

      // Apply snapshot
      Y.applyUpdate(doc, snapshot);

      // Update state
      const state = this.states.get(docId);
      if (state) {
        state.lastSnapshotTime = Date.now();
        state.lastUpdateTime = Date.now();
        state.isDirty = false;
        state.docSize = this.getDocSize(doc);
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete the snapshot file for a given docId.
   */
  async deleteSnapshot(docId: string): Promise<void> {
    const snapshotPath = path.join(this.snapshotDir, `${docId}${SNAPSHOT_FILE_EXT}`);
    try {
      await fs.promises.unlink(snapshotPath);
    } catch {
      // File may not exist
    }
  }

  // ============================================================
  // Utility Methods
  // ============================================================

  /**
   * Get the approximate size of a Y.Doc in bytes.
   */
  getDocSize(doc: Y.Doc): number {
    try {
      const update = Y.encodeStateAsUpdate(doc);
      return update.byteLength;
    } catch {
      return 0;
    }
  }

  /**
   * Check whether the CRDT engine is available and supported.
   * Always returns true in Electron/Obsidian environments.
   */
  isCrdtSupported(): boolean {
    try {
      // Ensure Yjs is properly loaded
      if (typeof Y.Doc !== "function") {
        return false;
      }
      // Quick instantiation test
      const testDoc = new Y.Doc();
      const ytext = testDoc.getText("test");
      ytext.insert(0, "test");
      const update = Y.encodeStateAsUpdate(testDoc);
      testDoc.destroy();
      return update.byteLength > 0;
    } catch {
      return false;
    }
  }

  /**
   * Determine if a file should use CRDT or fall back to binary sync.
   *
   * @returns true if CRDT is suitable for this file.
   */
  shouldUseCrdt(fileCategory: FileCategory, fileSize: number): boolean {
    if (fileCategory !== FileCategory.TEXT) {
      return false;
    }
    if (fileSize > CRDT_MAX_DOC_SIZE_BYTES) {
      return false;
    }
    return this.isCrdtSupported();
  }

  /**
   * Trigger garbage collection on a Y.Doc.
   * Should be called periodically to free up memory.
   */
  gc(doc: Y.Doc): void {
    // Yjs GC is automatic and runs during transaction commit.
    // Calling gc() is a hint to the engine; Y.Doc does not expose
    // a direct gc() method — memory is managed internally.
    try {
      // Force a no-op transaction to trigger internal GC heuristics
      doc.transact(() => {
        // No-op transaction helps Yjs run internal cleanup
      });
    } catch {
      // Silently ignore GC errors
    }
  }

  /**
   * Get the sync state for a given docId.
   */
  getState(docId: string): CrdtSyncState | undefined {
    return this.states.get(docId);
  }

  /**
   * Get all CRDT sync states.
   */
  getAllStates(): CrdtSyncState[] {
    return Array.from(this.states.values());
  }

  /**
   * Check if a document with the given docId exists.
   */
  hasDoc(docId: string): boolean {
    return this.docs.has(docId);
  }

  /**
   * Get the number of active documents.
   */
  getDocCount(): number {
    return this.docs.size;
  }

  /**
   * Get list of all currently tracked doc IDs.
   */
  getDocIds(): string[] {
    return Array.from(this.docs.keys());
  }

  /**
   * Get the snapshot directory path.
   */
  getSnapshotDir(): string {
    return this.snapshotDir;
  }
}
