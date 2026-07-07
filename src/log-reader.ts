// ============================================================
// Log Reader — Sync History Viewer (Feature 1)
// ============================================================
// Asynchronously reads sync log files from ~/.obsidian-sync/logs/
// (including rotated files), parses each line into a structured
// SyncHistoryEntry, and computes aggregate statistics.
//
// All disk access uses top-level static imports of `fs/promises`
// (never dynamic import) to stay compatible with the esbuild /
// Electron bundling environment.

import * as os from "os";
import * as path from "path";
import { readFile } from "fs/promises";
import {
  SyncHistoryEntry,
  SyncHistoryFilters,
  SyncHistoryStats,
  LogLevel,
  SyncEventType,
} from "./types";
import { LOG_MAX_FILES } from "./constants";

// ============================================================
// Constants
// ============================================================

const LOG_DIR_NAME = ".obsidian-sync";
const LOG_SUBDIR_NAME = "logs";
const LOG_FILE_PREFIX = "sync";
const LOG_FILE_EXT = ".log";

/**
 * Regex matching a single log line written by sync-logger.ts:
 *   [2026-06-30 14:30:00] [INFO] message (filePath) [EVENT_TYPE]
 * Capture groups:
 *   1. timestamp  "YYYY-MM-DD HH:mm:ss"
 *   2. level      LogLevel enum value
 *   3. message    free text
 *   4. filePath   optional, inside parentheses
 *   5. eventType  optional, inside brackets
 */
const LOG_LINE_REGEX =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[(\w+)\] (.+?)(?: \(([^)]*)\))?(?: \[(\w+)\])?$/;

// ============================================================
// Icon Derivation
// ============================================================

/**
 * Derive a glyph for a history row from its level + event type.
 * Precedence: error → success → warning → info → fallback.
 */
function deriveIcon(level: LogLevel, eventType: SyncEventType): string {
  if (
    level === LogLevel.ERROR ||
    eventType === SyncEventType.ERROR ||
    eventType === SyncEventType.DISCONNECTED
  ) {
    return "❌";
  }

  if (
    level === LogLevel.SUCCESS ||
    eventType === SyncEventType.FILE_PUSHED ||
    eventType === SyncEventType.FILE_RECEIVED ||
    eventType === SyncEventType.CONNECTED ||
    eventType === SyncEventType.SYNC_COMPLETED ||
    eventType === SyncEventType.CONFLICT_RESOLVED
  ) {
    return "✅";
  }

  if (
    level === LogLevel.WARN ||
    eventType === SyncEventType.CONFLICT_DETECTED ||
    eventType === SyncEventType.DEVICE_LOST
  ) {
    return "⚠️";
  }

  if (
    level === LogLevel.INFO ||
    eventType === SyncEventType.SYNC_STARTED ||
    eventType === SyncEventType.CRDT_MERGED ||
    eventType === SyncEventType.DEVICE_DISCOVERED
  ) {
    return "⏭";
  }

  return "ℹ️";
}

// ============================================================
// Log Reader Class
// ============================================================

export class LogReader {
  // ============================================================
  // Path resolution
  // ============================================================

  /**
   * Resolve the base log directory under the user's home directory.
   * `~` is expanded via os.homedir().
   */
  private getLogDirPath(): string {
    return path.join(os.homedir(), LOG_DIR_NAME, LOG_SUBDIR_NAME);
  }

  /**
   * Return the ordered list of log file paths to read.
   * Order: sync.log (newest) → sync.log.1 → sync.log.2 → sync.log.3.
   */
  getLogFilePaths(): string[] {
    const dir = this.getLogDirPath();
    const paths: string[] = [];
    for (let i = 0; i <= LOG_MAX_FILES; i++) {
      const suffix = i === 0 ? "" : `.${i}`;
      paths.push(
        path.join(dir, `${LOG_FILE_PREFIX}${suffix}${LOG_FILE_EXT}`),
      );
    }
    return paths;
  }

  // ============================================================
  // Read
  // ============================================================

  /**
   * Read and parse every available log file.
   * Files that do not exist or cannot be read are silently skipped.
   * The returned array is sorted by timestamp descending (newest first).
   */
  async readAll(): Promise<SyncHistoryEntry[]> {
    const allEntries: SyncHistoryEntry[] = [];

    for (const filePath of this.getLogFilePaths()) {
      try {
        const content = await readFile(filePath, "utf-8");
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
          if (line.trim().length === 0) {
            continue;
          }
          const entry = this.parseLine(line);
          if (entry) {
            allEntries.push(entry);
          }
        }
      } catch {
        // File missing or unreadable — skip silently.
        continue;
      }
    }

    // Assign stable ids and sort newest-first.
    allEntries.sort((a, b) => b.timestamp - a.timestamp);
    allEntries.forEach((entry, index) => {
      entry.id = index + 1;
    });

    return allEntries;
  }

  /**
   * Read all entries and apply the given filters.
   */
  async readWithFilter(
    filters: SyncHistoryFilters,
  ): Promise<SyncHistoryEntry[]> {
    const all = await this.readAll();
    return this.applyFilters(all, filters);
  }

  /**
   * Apply filter criteria to an already-loaded entry list.
   */
  applyFilters(
    entries: SyncHistoryEntry[],
    filters: SyncHistoryFilters,
  ): SyncHistoryEntry[] {
    return entries.filter((entry) => {
      if (filters.filePathFilter && filters.filePathFilter.trim().length > 0) {
        const f = filters.filePathFilter.trim().toLowerCase();
        // When a path keyword is active, keep only entries whose filePath
        // exists and contains the keyword. Entries without a filePath
        // (e.g. SYNC_STARTED, DISCONNECTED) are excluded.
        if (!entry.filePath || !entry.filePath.toLowerCase().includes(f)) {
          return false;
        }
      }

      if (
        filters.fromTimestamp !== undefined &&
        entry.timestamp < filters.fromTimestamp
      ) {
        return false;
      }

      if (
        filters.toTimestamp !== undefined &&
        entry.timestamp > filters.toTimestamp
      ) {
        return false;
      }

      if (
        filters.levels &&
        filters.levels.length > 0 &&
        !filters.levels.includes(entry.level)
      ) {
        return false;
      }

      if (
        filters.eventTypes &&
        filters.eventTypes.length > 0 &&
        !filters.eventTypes.includes(entry.eventType)
      ) {
        return false;
      }

      return true;
    });
  }

  // ============================================================
  // Single-line parsing
  // ============================================================

  /**
   * Parse a single log line into a SyncHistoryEntry.
   * Returns null if the line does not match the expected format.
   * The `id` field is left as 0 here and assigned by the caller.
   */
  parseLine(line: string): SyncHistoryEntry | null {
    const match = LOG_LINE_REGEX.exec(line);
    if (!match) {
      return null;
    }

    const [, timestampStr, levelStr, message, filePath, eventTypeStr] = match;

    // Parse timestamp manually for robustness (space separator is not
    // strictly ISO-8601 and may yield Invalid Date on some engines).
    const timestamp = this.parseTimestamp(timestampStr);
    if (timestamp === 0 && timestampStr) {
      // Recognised format but failed to parse → treat as epoch 0.
    }

    const level = this.coerceLogLevel(levelStr);
    const eventType = this.coerceEventType(eventTypeStr);
    const icon = deriveIcon(level, eventType);

    return {
      id: 0,
      timestamp,
      level,
      message: message ?? "",
      filePath: filePath || undefined,
      eventType,
      icon,
      expanded: false,
    };
  }

  /**
   * Parse "YYYY-MM-DD HH:mm:ss" into Unix ms. Returns 0 on failure.
   */
  private parseTimestamp(value: string | undefined): number {
    if (!value) {
      return 0;
    }
    const parts = value.split(/[- :]/);
    if (parts.length < 6) {
      return 0;
    }
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    const hour = Number(parts[3]);
    const minute = Number(parts[4]);
    const second = Number(parts[5]);
    if (
      [year, month, day, hour, minute, second].some((n) => Number.isNaN(n))
    ) {
      return 0;
    }
    const date = new Date(year, month - 1, day, hour, minute, second);
    if (Number.isNaN(date.getTime())) {
      return 0;
    }
    return date.getTime();
  }

  /**
   * Coerce a raw string into a known LogLevel, falling back to INFO.
   */
  private coerceLogLevel(value: string | undefined): LogLevel {
    if (!value) {
      return LogLevel.INFO;
    }
    const found = (Object.values(LogLevel) as string[]).includes(value);
    return found ? (value as LogLevel) : LogLevel.INFO;
  }

  /**
   * Coerce a raw string into a known SyncEventType, falling back to INFO.
   */
  private coerceEventType(value: string | undefined): SyncEventType {
    if (!value) {
      return SyncEventType.INFO;
    }
    const found = (Object.values(SyncEventType) as string[]).includes(value);
    return found ? (value as SyncEventType) : SyncEventType.INFO;
  }

  // ============================================================
  // Statistics
  // ============================================================

  /**
   * Compute aggregate statistics for the given entries.
   */
  getStats(entries: SyncHistoryEntry[]): SyncHistoryStats {
    const stats: SyncHistoryStats = {
      totalEntries: entries.length,
      successCount: 0,
      warnCount: 0,
      skipCount: 0,
      errorCount: 0,
      filePushCount: 0,
      fileReceiveCount: 0,
      conflictCount: 0,
    };

    for (const entry of entries) {
      switch (entry.icon) {
        case "✅":
          stats.successCount++;
          break;
        case "⚠️":
          stats.warnCount++;
          break;
        case "⏭":
          stats.skipCount++;
          break;
        case "❌":
          stats.errorCount++;
          break;
        default:
          break;
      }

      if (entry.eventType === SyncEventType.FILE_PUSHED) {
        stats.filePushCount++;
      }
      if (entry.eventType === SyncEventType.FILE_RECEIVED) {
        stats.fileReceiveCount++;
      }
      if (entry.eventType === SyncEventType.CONFLICT_DETECTED) {
        stats.conflictCount++;
      }
    }

    return stats;
  }
}
