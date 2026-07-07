// ============================================================
// Sync Engine × Diff Preview Integration Tests
// ============================================================
// Covers ARCH §7 T05 integration requirements:
//   - beforeSendHook is NOT triggered while offline (change is queued)
//   - beforeSendHook IS triggered while connected, and its decision
//     (true = proceed / false = skip) is honored by handleLocalChange.
//
// Uses the same lightweight engine construction pattern as the existing
// unit/sync-engine.test.ts (real collaborators, spied fs writers).

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
  BeforeSendHook,
} from "../../src/types";

function makeEngine() {
  const fileWatcher = new FileWatcher();
  const osWriter = new OsWriter();
  const crdtEngine = new CrdtEngine();
  const conflictDetector = new ConflictDetector();

  // Avoid real disk I/O.
  vi.spyOn(osWriter, "readFile").mockResolvedValue(Buffer.from("content"));
  vi.spyOn(osWriter, "writeFile").mockResolvedValue(undefined);

  const engine = new SyncEngine(fileWatcher, osWriter, crdtEngine, conflictDetector);
  engine.init("device-1", "Test Device", "/test/vault");
  return { engine };
}

function makeChange(over: Partial<FileChange> = {}): FileChange {
  return {
    type: ChangeType.MODIFY,
    relativePath: "notes/diary.md",
    mtime: 1000,
    hash: "abc",
    originDeviceId: "device-1",
    version: 1,
    fileCategory: FileCategory.TEXT,
    size: 100,
    ...over,
  };
}

describe("SyncEngine — beforeSendHook integration", () => {
  let engine: SyncEngine;

  beforeEach(() => {
    ({ engine } = makeEngine());
  });

  it("offline: beforeSendHook is NOT triggered (change is enqueued)", async () => {
    const handler = vi.fn().mockResolvedValue(true);
    const hook: BeforeSendHook = { name: "diff-preview", handler };
    engine.setBeforeSendHook(hook);

    // No connection manager → treated as offline.
    await engine.handleLocalChange(makeChange());

    expect(handler).not.toHaveBeenCalled();
  });

  it("online + hook returns false → change skipped, not transmitted", async () => {
    const handler = vi.fn().mockResolvedValue(false);
    engine.setBeforeSendHook({ name: "diff-preview", handler });

    const connectionManager = {
      getIsConnected: () => true,
      sendMessage: vi.fn(),
      sendBinary: vi.fn(),
    } as any;
    engine.setConnectionManager(connectionManager);

    await engine.handleLocalChange(makeChange());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(connectionManager.sendMessage).not.toHaveBeenCalled();
    expect(connectionManager.sendBinary).not.toHaveBeenCalled();
  });

  it("online + hook returns true → change proceeds to transmission", async () => {
    const handler = vi.fn().mockResolvedValue(true);
    engine.setBeforeSendHook({ name: "diff-preview", handler });

    const connectionManager = {
      getIsConnected: () => true,
      sendMessage: vi.fn(),
      sendBinary: vi.fn(),
    } as any;
    engine.setConnectionManager(connectionManager);

    await engine.handleLocalChange(makeChange());

    expect(handler).toHaveBeenCalledTimes(1);
    // With the hook allowing the send, the engine transmits the change.
    expect(connectionManager.sendMessage).toHaveBeenCalled();
  });
});
