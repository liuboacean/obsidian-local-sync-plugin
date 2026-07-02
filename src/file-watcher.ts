// ============================================================
// File Change Watcher
// ============================================================
// Wraps chokidar to watch an Obsidian vault for file changes.
// Provides debounce, recently-pushed dedup to prevent sync loops,
// and configurable ignore patterns.

import { EventEmitter } from "events";
import * as chokidar from "chokidar";
import * as path from "path";
import { FileChange, ChangeType, FileCategory } from "./types";
import { DEBOUNCE_MS, RECENTLY_PUSHED_TTL_MS, EVENTS } from "./constants";
import { classifyFile, computeFileHash, normalizePath } from "./utils";

// ============================================================
// Ignore Pattern Helpers
// ============================================================

/**
 * Build a chokidar-compatible ignore pattern from the given list.
 */
function buildIgnorePatterns(
  ignoreFolders: string[],
  ignoreExtensions: string[],
): (string | RegExp)[] {
  const patterns: (string | RegExp)[] = [];

  // Ignore hidden files/directories (starting with .)
  patterns.push(/(^|[/\\])\../);

  // Ignore node_modules and similar
  patterns.push("**/node_modules/**");

  // User-specified folders
  for (const folder of ignoreFolders) {
    const trimmed = folder.trim();
    if (trimmed) {
      patterns.push(`**/${trimmed}/**`);
    }
  }

  // User-specified extensions
  for (const ext of ignoreExtensions) {
    const trimmed = ext.trim();
    if (trimmed) {
      const dotExt = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
      patterns.push(`**/*${dotExt}`);
    }
  }

  return patterns;
}

// ============================================================
// File Watcher Class
// ============================================================

export class FileWatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher | null = null;
  private rootPath: string = "";
  private ignoreFolders: string[] = [];
  private ignoreExtensions: string[] = [];
  private ignorePatterns: (string | RegExp)[] = [];

  /** Debounce timers: path -> setTimeout handle */
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map();

  /** Recently-pushed dedup map: path -> timestamp */
  private recentlyPushed: Map<string, number> = new Map();

  /** Periodic cleanup timer for recently-pushed map */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether the watcher is currently started */
  private watching = false;

  constructor() {
    super();
    this.setMaxListeners(20);
  }

  // ============================================================
  // Public API
  // ============================================================

  /**
   * Start watching the given root path for file changes.
   *
   * @param rootPath - Absolute path to the Obsidian vault.
   * @param ignoreFolders - Folder names to ignore.
   * @param ignoreExtensions - File extensions to ignore.
   */
  start(
    rootPath: string,
    ignoreFolders: string[] = [],
    ignoreExtensions: string[] = [],
  ): void {
    if (this.watching) {
      return;
    }

    this.rootPath = rootPath;
    this.ignoreFolders = ignoreFolders;
    this.ignoreExtensions = ignoreExtensions;
    this.ignorePatterns = buildIgnorePatterns(ignoreFolders, ignoreExtensions);

    this.watcher = chokidar.watch(rootPath, {
      ignored: this.ignorePatterns,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    // Bind chokidar events
    this.watcher.on("add", (filePath: string) => {
      this.handleChangeDebounced(filePath, ChangeType.CREATE);
    });

    this.watcher.on("change", (filePath: string) => {
      this.handleChangeDebounced(filePath, ChangeType.MODIFY);
    });

    this.watcher.on("unlink", (filePath: string) => {
      this.handleChangeNow(filePath, ChangeType.DELETE);
    });

    this.watcher.on("error", (err: unknown) => {
      this.emit("error", err);
    });

    this.watching = true;

    // Start periodic cleanup of recently-pushed map
    this.cleanupTimer = window.setInterval(() => {
      this.cleanupRecentlyPushed();
    }, RECENTLY_PUSHED_TTL_MS);
  }

  /**
   * Stop watching and release resources.
   */
  stop(): void {
    if (!this.watching) {
      return;
    }

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      window.clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Clear cleanup timer
    if (this.cleanupTimer) {
      window.clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Close chokidar
    if (this.watcher) {
      this.watcher.close().catch(() => {
        // Silently ignore close errors
      });
      this.watcher = null;
    }

    this.recentlyPushed.clear();
    this.watching = false;
  }

  /**
   * Update ignore patterns at runtime.
   */
  updateIgnorePatterns(
    ignoreFolders: string[],
    ignoreExtensions: string[],
  ): void {
    this.ignoreFolders = ignoreFolders;
    this.ignoreExtensions = ignoreExtensions;
    this.ignorePatterns = buildIgnorePatterns(ignoreFolders, ignoreExtensions);

    if (this.watcher) {
      // chokidar does not support hot-updating `ignored`; close and restart
      this.stop();
      this.start(this.rootPath, ignoreFolders, ignoreExtensions);
    }
  }

  /**
   * Check if a relative path matches the ignore patterns.
   */
  isIgnored(relativePath: string): boolean {
    const normalized = normalizePath(relativePath);
    for (const pattern of this.ignorePatterns) {
      if (typeof pattern === "string") {
        // Simple glob matching
        const regex = new RegExp(
          pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, "."),
        );
        if (regex.test(normalized)) {
          return true;
        }
      } else if (pattern instanceof RegExp) {
        if (pattern.test(normalized)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Mark a path as recently pushed (by the sync engine or OS writer)
   * so that subsequent chokidar events for it are ignored.
   */
  markAsPushed(filePath: string): void {
    this.recentlyPushed.set(filePath, Date.now());
  }

  /**
   * Check if a path was recently pushed by us (within TTL).
   */
  isRecentlyPushed(filePath: string): boolean {
    const pushedAt = this.recentlyPushed.get(filePath);
    if (pushedAt === undefined) {
      return false;
    }
    if (Date.now() - pushedAt > RECENTLY_PUSHED_TTL_MS) {
      this.recentlyPushed.delete(filePath);
      return false;
    }
    return true;
  }

  /**
   * Whether the watcher is currently active.
   */
  isWatching(): boolean {
    return this.watching;
  }

  // ============================================================
  // Debounced Change Handling
  // ============================================================

  /**
   * Handle a file change with debounce (CREATE/MODIFY).
   * Cancels any pending timer for the same path and re-schedules.
   */
  private handleChangeDebounced(filePath: string, changeType: ChangeType): void {
    // Skip if recently pushed by us
    if (this.isRecentlyPushed(filePath)) {
      return;
    }

    // Cancel existing debounce timer for this path
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      window.clearTimeout(existing);
    }

    // Schedule new debounce timer
    const timer = window.setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.emitChange(filePath, changeType).catch(err => console.error(err));
    }, DEBOUNCE_MS);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * Handle a file change immediately (DELETE) without debounce.
   */
  private handleChangeNow(filePath: string, changeType: ChangeType): void {
    // Skip if recently pushed by us
    if (this.isRecentlyPushed(filePath)) {
      return;
    }

    // Cancel any pending debounce timer for this path
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      window.clearTimeout(existing);
      this.debounceTimers.delete(filePath);
    }

    this.emitChange(filePath, changeType).catch(err => console.error(err));
  }

  /**
   * Build a FileChange object and emit the appropriate event.
   */
  private async emitChange(filePath: string, changeType: ChangeType): Promise<void> {
    const relativePath = normalizePath(path.relative(this.rootPath, filePath));
    const category = classifyFile(filePath);

    let mtime = Date.now();
    let hash = "";
    let size = 0;

    if (changeType !== ChangeType.DELETE) {
      try {
        const { stat } = await import("fs/promises");
        const stats = await stat(filePath);
        mtime = stats.mtimeMs;
        size = stats.size;

        if (category === FileCategory.TEXT) {
          try {
            await computeFileHash(filePath);
          } catch {
            // If we can't read the file, skip it
            return;
          }
        } else {
          hash = await computeFileHash(filePath);
        }
      } catch {
        // File may have been deleted before we could stat it
        return;
      }
    }

    const change: FileChange = {
      type: changeType,
      relativePath,
      mtime,
      hash,
      originDeviceId: "",
      version: 1,
      fileCategory: category,
      size,
    };

    switch (changeType) {
      case ChangeType.CREATE:
        this.emit(EVENTS.FILE_CREATED, change);
        break;
      case ChangeType.MODIFY:
        this.emit(EVENTS.FILE_MODIFIED, change);
        break;
      case ChangeType.DELETE:
        this.emit(EVENTS.FILE_DELETED, change);
        break;
    }
  }

  /**
   * Clean up stale entries from the recently-pushed map.
   */
  private cleanupRecentlyPushed(): void {
    const now = Date.now();
    for (const [path, timestamp] of this.recentlyPushed.entries()) {
      if (now - timestamp > RECENTLY_PUSHED_TTL_MS) {
        this.recentlyPushed.delete(path);
      }
    }
  }
}
