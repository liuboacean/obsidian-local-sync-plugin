// ============================================================
// Conflict Detector Tests
// ============================================================

import { describe, it, expect } from "vitest";
import { ConflictDetector } from "../../src/conflict-detector";
import { FileCategory, ConflictStatus, ChangeType } from "../../src/types";

// ============================================================
// Detection
// ============================================================

describe("ConflictDetector.detect", () => {
  const detector = new ConflictDetector();

  it("should NOT detect conflict for TEXT files (CRDT handles them)", () => {
    const result = detector.detect(
      FileCategory.TEXT,
      "hash-a",
      "hash-b",
      1000,
      2000,
      "MODIFY_VS_MODIFY",
    );
    expect(result).toBe(false);
  });

  it("should NOT detect conflict when hashes match", () => {
    const result = detector.detect(
      FileCategory.BINARY,
      "same-hash",
      "same-hash",
      1000,
      2000,
      "MODIFY_VS_MODIFY",
    );
    expect(result).toBe(false);
  });

  it("should detect conflict when hashes differ and mtime delta < 30s", () => {
    const result = detector.detect(
      FileCategory.BINARY,
      "hash-a",
      "hash-b",
      1000,
      2000, // within 30s window
      "MODIFY_VS_MODIFY",
    );
    expect(result).toBe(true);
  });

  it("should NOT detect conflict when hashes differ but mtime delta >= 30s", () => {
    const result = detector.detect(
      FileCategory.BINARY,
      "hash-a",
      "hash-b",
      1000,
      100000, // far beyond 30s
      "MODIFY_VS_MODIFY",
    );
    expect(result).toBe(false);
  });

  it("should NOT detect conflict when either hash is empty", () => {
    const result1 = detector.detect(
      FileCategory.BINARY,
      "",
      "hash-b",
      1000,
      2000,
      "MODIFY_VS_MODIFY",
    );
    expect(result1).toBe(false);

    const result2 = detector.detect(
      FileCategory.BINARY,
      "hash-a",
      "",
      1000,
      2000,
      "MODIFY_VS_MODIFY",
    );
    expect(result2).toBe(false);
  });

  it("should detect DELETE_VS_MODIFY as conflict", () => {
    const result = detector.detect(
      FileCategory.BINARY,
      "hash-a",
      "hash-b",
      1000,
      2000,
      "DELETE_VS_MODIFY",
    );
    expect(result).toBe(true);
  });
});

// ============================================================
// Registration & Query
// ============================================================

describe("ConflictDetector registration and queries", () => {
  const detector = new ConflictDetector();
  const testConflict = {
    relativePath: "test/file.png",
    localVersion: {
      type: ChangeType.MODIFY as const,
      relativePath: "test/file.png",
      mtime: 1000,
      hash: "hash-local",
      originDeviceId: "device-a",
      version: 1,
      fileCategory: FileCategory.BINARY as const,
      size: 1024,
    },
    remoteVersion: {
      type: ChangeType.MODIFY as const,
      relativePath: "test/file.png",
      mtime: 2000,
      hash: "hash-remote",
      originDeviceId: "device-b",
      version: 1,
      fileCategory: FileCategory.BINARY as const,
      size: 2048,
    },
    status: ConflictStatus.UNRESOLVED as const,
    detectedAt: 3000,
    conflictType: "MODIFY_VS_MODIFY" as const,
  };

  it("should register a conflict", () => {
    detector.registerConflict(testConflict);
    expect(detector.hasConflict("test/file.png")).toBe(true);
    expect(detector.getConflictCount()).toBe(1);
  });

  it("should retrieve registered conflict", () => {
    const retrieved = detector.getConflict("test/file.png");
    expect(retrieved).toBeDefined();
    expect(retrieved!.relativePath).toBe("test/file.png");
    expect(retrieved!.localVersion.hash).toBe("hash-local");
    expect(retrieved!.remoteVersion.hash).toBe("hash-remote");
  });

  it("should list active conflicts", () => {
    const conflicts = detector.getActiveConflicts();
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
  });

  it("should check path without conflict", () => {
    expect(detector.hasConflict("nonexistent/file.txt")).toBe(false);
  });
});

// ============================================================
// Resolution
// ============================================================

describe("ConflictDetector.resolveConflict", () => {
  const detector = new ConflictDetector();

  beforeEach(() => {
    // Register a conflict
    detector.registerConflict({
      relativePath: "test/file.png",
      localVersion: {
        type: ChangeType.MODIFY,
        relativePath: "test/file.png",
        mtime: 1000,
        hash: "hash-local",
        originDeviceId: "device-a",
        version: 1,
        fileCategory: FileCategory.BINARY,
        size: 1024,
      },
      remoteVersion: {
        type: ChangeType.MODIFY,
        relativePath: "test/file.png",
        mtime: 2000,
        hash: "hash-remote",
        originDeviceId: "device-b",
        version: 1,
        fileCategory: FileCategory.BINARY,
        size: 2048,
      },
      status: ConflictStatus.UNRESOLVED,
      detectedAt: 3000,
      conflictType: "MODIFY_VS_MODIFY",
    });
  });

  it("should resolve with keep_local", () => {
    const resolved = detector.resolveConflict("test/file.png", "keep_local");
    expect(resolved.status).toBe(ConflictStatus.KEEP_LOCAL);
    expect(detector.hasConflict("test/file.png")).toBe(false);
  });

  it("should resolve with keep_remote", () => {
    const detector2 = new ConflictDetector();
    detector2.registerConflict({
      relativePath: "test/file.png",
      localVersion: {
        type: ChangeType.MODIFY,
        relativePath: "test/file.png",
        mtime: 1000,
        hash: "hash-local",
        originDeviceId: "device-a",
        version: 1,
        fileCategory: FileCategory.BINARY,
        size: 1024,
      },
      remoteVersion: {
        type: ChangeType.MODIFY,
        relativePath: "test/file.png",
        mtime: 2000,
        hash: "hash-remote",
        originDeviceId: "device-b",
        version: 1,
        fileCategory: FileCategory.BINARY,
        size: 2048,
      },
      status: ConflictStatus.UNRESOLVED,
      detectedAt: 3000,
      conflictType: "MODIFY_VS_MODIFY",
    });
    const resolved = detector2.resolveConflict("test/file.png", "keep_remote");
    expect(resolved.status).toBe(ConflictStatus.KEEP_REMOTE);
  });

  it("should resolve with keep_both", () => {
    const detector2 = new ConflictDetector();
    detector2.registerConflict({
      relativePath: "test/file.png",
      localVersion: {
        type: ChangeType.MODIFY,
        relativePath: "test/file.png",
        mtime: 1000,
        hash: "hash-local",
        originDeviceId: "device-a",
        version: 1,
        fileCategory: FileCategory.BINARY,
        size: 1024,
      },
      remoteVersion: {
        type: ChangeType.MODIFY,
        relativePath: "test/file.png",
        mtime: 2000,
        hash: "hash-remote",
        originDeviceId: "device-b",
        version: 1,
        fileCategory: FileCategory.BINARY,
        size: 2048,
      },
      status: ConflictStatus.UNRESOLVED,
      detectedAt: 3000,
      conflictType: "MODIFY_VS_MODIFY",
    });
    const resolved = detector2.resolveConflict("test/file.png", "keep_both");
    expect(resolved.status).toBe(ConflictStatus.KEEP_BOTH);
  });

  it("should handle resolution for non-existent path gracefully", () => {
    const result = detector.resolveConflict("nonexistent.png", "keep_local");
    expect(result).toBeDefined();
    expect(result.relativePath).toBe("nonexistent.png");
  });
});

// ============================================================
// Clear
// ============================================================

describe("ConflictDetector.clear", () => {
  it("should clear all conflicts", () => {
    const detector = new ConflictDetector();
    detector.registerConflict({
      relativePath: "a.png",
      localVersion: {
        type: ChangeType.MODIFY,
        relativePath: "a.png",
        mtime: 0,
        hash: "a",
        originDeviceId: "d1",
        version: 1,
        fileCategory: FileCategory.BINARY,
        size: 0,
      },
      remoteVersion: {
        type: ChangeType.MODIFY,
        relativePath: "a.png",
        mtime: 0,
        hash: "b",
        originDeviceId: "d2",
        version: 1,
        fileCategory: FileCategory.BINARY,
        size: 0,
      },
      status: ConflictStatus.UNRESOLVED,
      detectedAt: 0,
      conflictType: "MODIFY_VS_MODIFY",
    });
    detector.registerConflict({
      relativePath: "b.png",
      localVersion: {
        type: ChangeType.MODIFY,
        relativePath: "b.png",
        mtime: 0,
        hash: "c",
        originDeviceId: "d1",
        version: 1,
        fileCategory: FileCategory.BINARY,
        size: 0,
      },
      remoteVersion: {
        type: ChangeType.MODIFY,
        relativePath: "b.png",
        mtime: 0,
        hash: "d",
        originDeviceId: "d2",
        version: 1,
        fileCategory: FileCategory.BINARY,
        size: 0,
      },
      status: ConflictStatus.UNRESOLVED,
      detectedAt: 0,
      conflictType: "MODIFY_VS_MODIFY",
    });

    expect(detector.getConflictCount()).toBe(2);
    detector.clearConflicts();
    expect(detector.getConflictCount()).toBe(0);
  });
});
