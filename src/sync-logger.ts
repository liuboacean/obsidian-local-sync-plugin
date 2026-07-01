// ============================================================
// Sync Logger
// ============================================================
// In-memory ring buffer with optional file persistence.
// Logs are stored in a circular buffer (max MAX_LOG_ENTRIES entries)
// and optionally persisted to ~/.obsidian-sync/logs/ with rotation.

import * as path from "path";
import * as fs from "fs";
import { LogLevel, LogEntry, SyncEventType } from "./types";
import {
  MAX_LOG_ENTRIES,
  LOG_MAX_SIZE_BYTES,
  LOG_MAX_FILES,
} from "./constants";
import { formatTime } from "./utils";

// ============================================================
// Helpers
// ============================================================

const LOG_DIR_NAME = ".obsidian-sync";
const LOG_SUBDIR_NAME = "logs";
const LOG_FILE_PREFIX = "sync";
const LOG_FILE_EXT = ".log";

/**
 * Resolve the log directory path under the user's home directory.
 */
function getLogDirPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(homeDir, LOG_DIR_NAME, LOG_SUBDIR_NAME);
}

/**
 * Get the path for the log file at the given index (0 = newest).
 */
function getLogFilePath(index: number): string {
  const suffix = index === 0 ? "" : `.${index}`;
  return path.join(getLogDirPath(), `${LOG_FILE_PREFIX}${suffix}${LOG_FILE_EXT}`);
}

/**
 * Format a single log entry as a plain text line.
 * Format: [2026-06-30 14:30:00] [INFO] message (filePath) [EVENT_TYPE]
 */
function formatLogEntry(entry: LogEntry): string {
  const timestamp = formatTime(entry.timestamp);
  const fileInfo = entry.filePath ? ` (${entry.filePath})` : "";
  const eventInfo = entry.eventType ? ` [${entry.eventType}]` : "";
  return `[${timestamp}] [${entry.level}] ${entry.message}${fileInfo}${eventInfo}`;
}

// ============================================================
// Logger Class
// ============================================================

export class SyncLogger {
  private buffer: LogEntry[] = [];
  private nextIndex = 0;
  private count = 0;
  private dirInitialized = false;

  // ============================================================
  // Logging
  // ============================================================

  /**
   * Append a log entry to the ring buffer.
   * If the buffer is full, the oldest entry is overwritten.
   */
  log(
    level: LogLevel,
    message: string,
    filePath?: string,
    eventType?: SyncEventType,
  ): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      message,
      filePath,
      eventType: eventType || SyncEventType.ERROR,
    };

    this.buffer[this.nextIndex] = entry;
    this.nextIndex = (this.nextIndex + 1) % MAX_LOG_ENTRIES;
    if (this.count < MAX_LOG_ENTRIES) {
      this.count++;
    }

    // Persist to file asynchronously (fire-and-forget)
    this.persistEntry(entry).catch(() => {
      // Silently ignore persistence errors
    });
  }

  // ============================================================
  // Query Methods
  // ============================================================

  /**
   * Return the most recent `count` log entries, newest first.
   */
  getRecent(count: number): LogEntry[] {
    const actualCount = Math.min(count, this.count);
    const result: LogEntry[] = [];
    let idx = (this.nextIndex - 1 + MAX_LOG_ENTRIES) % MAX_LOG_ENTRIES;
    for (let i = 0; i < actualCount; i++) {
      if (this.buffer[idx]) {
        result.push(this.buffer[idx]);
      }
      idx = (idx - 1 + MAX_LOG_ENTRIES) % MAX_LOG_ENTRIES;
    }
    return result;
  }

  /**
   * Return all entries at the given log level.
   */
  getByLevel(level: LogLevel): LogEntry[] {
    const result: LogEntry[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.nextIndex - 1 - i + MAX_LOG_ENTRIES) % MAX_LOG_ENTRIES;
      const entry = this.buffer[idx];
      if (entry && entry.level === level) {
        result.push(entry);
      }
    }
    return result;
  }

  /**
   * Clear all in-memory log entries.
   */
  clear(): void {
    this.buffer = [];
    this.nextIndex = 0;
    this.count = 0;
  }

  /**
   * Export all in-memory log entries as a plain text string.
   */
  export(): string {
    const lines: string[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.nextIndex - this.count + i + MAX_LOG_ENTRIES) % MAX_LOG_ENTRIES;
      const entry = this.buffer[idx];
      if (entry) {
        lines.push(formatLogEntry(entry));
      }
    }
    return lines.join("\n");
  }

  // ============================================================
  // File Persistence
  // ============================================================

  /**
   * Initialize the log directory structure.
   * Creates ~/.obsidian-sync/logs/ if it does not exist.
   */
  async initLogDir(): Promise<void> {
    if (this.dirInitialized) {
      return;
    }
    const dirPath = getLogDirPath();
    try {
      await fs.promises.mkdir(dirPath, { recursive: true });
      this.dirInitialized = true;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== "EEXIST") {
        console.error("SyncLogger: failed to create log directory", error);
      } else {
        this.dirInitialized = true;
      }
    }
  }

  /**
   * Persist a single log entry to the current log file.
   * Performs rotation if the file exceeds LOG_MAX_SIZE_BYTES.
   */
  private async persistEntry(entry: LogEntry): Promise<void> {
    if (!this.dirInitialized) {
      return;
    }

    const logFilePath = getLogFilePath(0);
    const line = formatLogEntry(entry) + "\n";

    try {
      // Check current log file size and rotate if needed
      await this.rotateIfNeeded(logFilePath);

      // Append the log entry
      await fs.promises.appendFile(logFilePath, line, "utf-8");
    } catch {
      // Silently ignore persistence errors (noisy disk should not crash sync)
    }
  }

  /**
   * Rotate log files if the current log file exceeds LOG_MAX_SIZE_BYTES.
   */
  private async rotateIfNeeded(logFilePath: string): Promise<void> {
    try {
      const stat = await fs.promises.stat(logFilePath);
      if (stat.size >= LOG_MAX_SIZE_BYTES) {
        // Shift existing rotated files down
        for (let i = LOG_MAX_FILES - 1; i > 0; i--) {
          const srcPath = getLogFilePath(i - 1);
          const dstPath = getLogFilePath(i);
          try {
            await fs.promises.rename(srcPath, dstPath);
          } catch {
            // Source file may not exist
          }
        }
        // Remove the old file (already rotated) and create a new one
        // Actually, the rename above moved file.0 -> file.1, so we just
        // need the next write to create a fresh file.0
        // But rename won't work if destination exists on some systems.
        // Safer approach: unlink the oldest, shift with copy + unlink, then write new.
        // Simplest: use writeFile (truncates) for the new log.
        // We already created file.0 -> file.1 above, but file.0 still exists.
        // So let's truncate file.0:
        await fs.promises.writeFile(logFilePath, "", "utf-8");
      }
    } catch {
      // File does not exist yet — first write will create it
    }
  }
}

// ============================================================
// Singleton Export
// ============================================================

/**
 * Application-wide logger instance.
 * Import this singleton for consistent logging across modules.
 */
export const syncLogger = new SyncLogger();
