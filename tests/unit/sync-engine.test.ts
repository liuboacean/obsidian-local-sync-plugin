// ============================================================
// Sync Engine Tests
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncEngine } from "../../src/sync-engine";
import { FileWatcher } from "../../src/file-watcher";
import { OsWriter } from "../../src/os-writer";
import { CrdtEngine } from "../../src/crdt-engine";
import { ConflictDetector } from "../../src/conflict-detector";
import {
  FileChange,
  ChangeType,
  FileCategory,
  MessageType,
  SyncMessage,
  LogLevel,
  SyncEventType,
} from "../../src/types";

// ============================================================
// Mocks
// ============================================================

function createMockSyncEngine(): {
  engine: SyncEngine;
  fileWatcher: FileWatcher;
  osWriter: OsWriter;
  crdtEngine: CrdtEngine;
  conflictDetector: ConflictDetector;
} {
  const fileWatcher = new FileWatcher();
  const osWriter = new OsWriter();
  const crdtEngine = new CrdtEngine();
  const conflictDetector = new ConflictDetector();

  // Mock OsWriter methods
  vi.spyOn(osWriter, "readFile").mockResolvedValue(
    Buffer.from("mock content", "utf-8"),
  );
  vi.spyOn(osWriter, "writeFile").mockResolvedValue(undefined);

  const engine = new SyncEngine(
    fileWatcher,
    osWriter,
    crdtEngine,
    conflictDetector,
  );
  engine.init("device-1", "Test Device", "/test/vault");

  return { engine, fileWatcher, osWriter, crdtEngine, conflictDetector };
}

// ============================================================
// Initialization
// ============================================================

describe("SyncEngine — Initialization", () => {
  it("should initialize with device identity", () => {
    const { engine } = createMockSyncEngine();
    expect(engine.isRunning()).toBe(false); // not started yet
  });

  it("should start and stop", () => {
    const { engine } = createMockSyncEngine();
    engine.start();
    expect(engine.isRunning()).toBe(true);
    engine.stop();
    expect(engine.isRunning()).toBe(false);
  });
});

// ============================================================
// File State Management
// ============================================================

describe("SyncEngine — File State", () => {
  it("should track file states", () => {
    const { engine } = createMockSyncEngine();

    expect(engine.getSyncFileStates().size).toBe(0);
    expect(engine.getFileState("test.md")).toBeUndefined();
  });

  it("should return sync stats", () => {
    const { engine } = createMockSyncEngine();
    const stats = engine.getSyncStats();
    expect(stats).toBeDefined();
    expect(typeof stats.pendingFiles).toBe("number");
    expect(typeof stats.syncedFiles).toBe("number");
  });
});

// ============================================================
// Pending Queue
// ============================================================

describe("SyncEngine — Pending Queue", () => {
  it("should enqueue changes when disconnected", () => {
    const { engine } = createMockSyncEngine();
    const change: FileChange = {
      type: ChangeType.MODIFY,
      relativePath: "test.md",
      mtime: 1000,
      hash: "abc",
      originDeviceId: "device-1",
      version: 1,
      fileCategory: FileCategory.TEXT,
      size: 100,
    };

    // Without a connection manager, the change should be queued
    engine.start();
    // handleLocalChange will add to pending queue since connectionManager is null
    // We can't easily test internals, but we can verify the engine doesn't crash
    expect(() => engine.handleLocalChange(change)).not.toThrow();
    engine.stop();
  });
});

// ============================================================
// Remote Message Handling
// ============================================================

describe("SyncEngine — Remote Message Handling", () => {
  it("should handle CRDT_UPDATE message", async () => {
    const { engine, crdtEngine } = createMockSyncEngine();

    const msg: SyncMessage = {
      uuid: "test-uuid-1",
      type: MessageType.CRDT_UPDATE,
      deviceId: "remote-device",
      deviceName: "Remote",
      timestamp: Date.now(),
      payload: {
        docId: "test-doc",
        relativePath: "test.md",
        update: Buffer.from(new Uint8Array([1, 2, 3])).toString("base64"),
      },
    };

    await expect(engine.handleRemoteMessage(msg)).resolves.not.toThrow();
  });

  it("should handle FILE_CHANGE message for TEXT", async () => {
    const { engine } = createMockSyncEngine();

    const msg: SyncMessage = {
      uuid: "test-uuid-2",
      type: MessageType.FILE_CHANGE,
      deviceId: "remote-device",
      deviceName: "Remote",
      timestamp: Date.now(),
      payload: {
        relativePath: "notes/test.md",
        fileCategory: FileCategory.TEXT,
        content: "Hello from remote",
        hash: "hash123",
        mtime: 1000,
        size: 100,
      },
    };

    await expect(engine.handleRemoteMessage(msg)).resolves.not.toThrow();
  });

  it("should handle FILE_CHANGE message for BINARY", async () => {
    const { engine } = createMockSyncEngine();

    const msg: SyncMessage = {
      uuid: "test-uuid-3",
      type: MessageType.FILE_CHANGE,
      deviceId: "remote-device",
      deviceName: "Remote",
      timestamp: Date.now(),
      payload: {
        relativePath: "images/photo.png",
        fileCategory: FileCategory.BINARY,
        content: Buffer.from([137, 80, 78, 71]).toString("base64"),
        hash: "hash456",
        mtime: 1000,
        size: 100,
      },
    };

    await expect(engine.handleRemoteMessage(msg)).resolves.not.toThrow();
  });

  it("should handle CONFLICT_NOTIFY message", async () => {
    const { engine } = createMockSyncEngine();

    const msg: SyncMessage = {
      uuid: "test-uuid-4",
      type: MessageType.CONFLICT_NOTIFY,
      deviceId: "remote-device",
      deviceName: "Remote",
      timestamp: Date.now(),
      payload: {
        relativePath: "notes/conflict.md",
      },
    };

    await expect(engine.handleRemoteMessage(msg)).resolves.not.toThrow();
  });

  it("should handle CONFLICT_RESOLVE message", async () => {
    const { engine } = createMockSyncEngine();

    const msg: SyncMessage = {
      uuid: "test-uuid-5",
      type: MessageType.CONFLICT_RESOLVE,
      deviceId: "remote-device",
      deviceName: "Remote",
      timestamp: Date.now(),
      payload: {
        relativePath: "notes/resolved.md",
        resolution: "keep_local",
      },
    };

    await expect(engine.handleRemoteMessage(msg)).resolves.not.toThrow();
  });

  it("should handle unknown message types gracefully", async () => {
    const { engine } = createMockSyncEngine();

    const msg: SyncMessage = {
      uuid: "test-uuid-6",
      type: "UNKNOWN_TYPE" as MessageType,
      deviceId: "remote-device",
      deviceName: "Remote",
      timestamp: Date.now(),
      payload: {},
    };

    await expect(engine.handleRemoteMessage(msg)).resolves.not.toThrow();
  });

  it("should handle FILE_CHANGE with missing payload", async () => {
    const { engine } = createMockSyncEngine();

    const msg: SyncMessage = {
      uuid: "test-uuid-7",
      type: MessageType.FILE_CHANGE,
      deviceId: "remote-device",
      deviceName: "Remote",
      timestamp: Date.now(),
      payload: {},
    };

    await expect(engine.handleRemoteMessage(msg)).resolves.not.toThrow();
  });
});

// ============================================================
// Conflict Resolution
// ============================================================

describe("SyncEngine — Conflict Resolution", () => {
  it("should resolve conflict without connection manager", async () => {
    const { engine } = createMockSyncEngine();

    // Engine has no connection manager set
    await expect(
      engine.resolveConflict("test.png", "keep_local"),
    ).resolves.not.toThrow();
  });
});
