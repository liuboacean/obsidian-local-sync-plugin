// ============================================================
// Conflict Detector
// ============================================================
// Detects sync conflicts for BINARY files.
// TEXT files are handled by Yjs CRDT auto-merge and never trigger conflicts.
//
// Conflict detection logic for BINARY files:
//   - If hashes match → no conflict
//   - If hashes differ AND mtime delta < CONFLICT_WINDOW_MS (30s) → conflict
//   - If hashes differ AND mtime delta >= CONFLICT_WINDOW_MS → no conflict
//     (sufficient time gap means the edit is clearly sequential)

import {
  FileCategory,
  ConflictInfo,
  ConflictStatus,
  ChangeType,
} from "./types";
import { CONFLICT_WINDOW_MS } from "./constants";

// ============================================================
// Type Re-export
// ============================================================

export type { ConflictType } from "./types";

// ============================================================
// Conflict Detector Class
// ============================================================

export class ConflictDetector {
  /** Active unresolved conflicts: relativePath -> ConflictInfo */
  private conflicts: Map<string, ConflictInfo> = new Map();

  // ============================================================
  // Detection
  // ============================================================

  /**
   * Detect whether a sync operation would produce a conflict.
   *
   * @param fileCategory - TEXT or BINARY. TEXT files always return false.
   * @param localHash - SHA-256 hash of the local file.
   * @param remoteHash - SHA-256 hash of the remote file.
   * @param localMtime - Last modification time of the local file (ms).
   * @param remoteMtime - Last modification time of the remote file (ms).
   * @param conflictType - The type of conflict (for registration).
   * @returns true if a conflict should be declared.
   */
  detect(
    fileCategory: FileCategory,
    localHash: string,
    remoteHash: string,
    localMtime: number,
    remoteMtime: number,
    conflictType: string,
  ): boolean {
    // TEXT files use CRDT auto-merge — never conflict
    if (fileCategory === FileCategory.TEXT) {
      return false;
    }

    // If hashes are the same, files are identical — no conflict
    if (localHash === remoteHash) {
      return false;
    }

    // If either hash is empty, we can't determine — no conflict
    if (!localHash || !remoteHash) {
      return false;
    }

    // Check the time window
    const mtimeDelta = Math.abs(localMtime - remoteMtime);

    // If the edits are within the conflict window, declare a conflict
    if (mtimeDelta < CONFLICT_WINDOW_MS) {
      return true;
    }

    // If the edits are far apart, the later one wins — no conflict
    // (This assumes sequential editing, not concurrent)
    return false;
  }

  // ============================================================
  // Conflict Registration
  // ============================================================

  /**
   * Register a detected conflict.
   *
   * @param info - The conflict information to register.
   */
  registerConflict(info: ConflictInfo): void {
    this.conflicts.set(info.relativePath, info);
  }

  // ============================================================
  // Conflict Resolution
  // ============================================================

  /**
   * Resolve an active conflict.
   *
   * @param path - The relative file path of the conflict.
   * @param resolution - How to resolve: 'keep_local', 'keep_remote', 'keep_both'.
   * @returns The resolved ConflictInfo (or a placeholder if not found).
   */
  resolveConflict(
    path: string,
    resolution: "keep_local" | "keep_remote" | "keep_both",
  ): ConflictInfo {
    const existing = this.conflicts.get(path);

    if (!existing) {
      // Return a dummy conflict info if none exists
      return {
        relativePath: path,
        localVersion: {
          type: ChangeType.MODIFY,
          relativePath: path,
          mtime: 0,
          hash: "",
          originDeviceId: "",
          version: 1,
          fileCategory: FileCategory.BINARY,
          size: 0,
        },
        remoteVersion: {
          type: ChangeType.MODIFY,
          relativePath: path,
          mtime: 0,
          hash: "",
          originDeviceId: "",
          version: 1,
          fileCategory: FileCategory.BINARY,
          size: 0,
        },
        status:
          resolution === "keep_local"
            ? ConflictStatus.KEEP_LOCAL
            : resolution === "keep_remote"
              ? ConflictStatus.KEEP_REMOTE
              : ConflictStatus.KEEP_BOTH,
        detectedAt: Date.now(),
        conflictType: "MODIFY_VS_MODIFY",
      };
    }

    // Update the conflict status based on resolution
    switch (resolution) {
      case "keep_local":
        existing.status = ConflictStatus.KEEP_LOCAL;
        break;
      case "keep_remote":
        existing.status = ConflictStatus.KEEP_REMOTE;
        break;
      case "keep_both":
        existing.status = ConflictStatus.KEEP_BOTH;
        break;
    }

    // Remove from active conflicts (resolution is final)
    this.conflicts.delete(path);

    return existing;
  }

  // ============================================================
  // Query Methods
  // ============================================================

  /**
   * Get all currently active (unresolved) conflicts.
   */
  getActiveConflicts(): ConflictInfo[] {
    return Array.from(this.conflicts.values());
  }

  /**
   * Check if a specific path has an active conflict.
   */
  hasConflict(path: string): boolean {
    return this.conflicts.has(path);
  }

  /**
   * Get a specific conflict by path.
   */
  getConflict(path: string): ConflictInfo | undefined {
    return this.conflicts.get(path);
  }

  /**
   * Get the number of active conflicts.
   */
  getConflictCount(): number {
    return this.conflicts.size;
  }

  /**
   * Remove a conflict record (e.g., after the file is deleted).
   */
  removeConflict(path: string): void {
    this.conflicts.delete(path);
  }

  /**
   * Clear all conflicts.
   */
  clearConflicts(): void {
    this.conflicts.clear();
  }
}
