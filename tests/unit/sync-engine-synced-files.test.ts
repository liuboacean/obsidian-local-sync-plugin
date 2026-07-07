// ============================================================
// Sync Engine — "已同步文件" (syncedFiles) Regression Tests
// ============================================================
// Covers BugFix T06 问题 1: getSyncStats() 必须直接返回运行时累积
// 计数器 this.stats.syncedFiles，而不得用 vaultFileCount /
// initialSyncFileCount / fileStates 重算（旧代码导致"已同步文件"恒显 0）。
//
// 行为契约：
//   1. getSyncStats().syncedFiles === this.stats.syncedFiles（直接返回，
//      不被 vaultFileCount / initialSyncFileCount 重算覆盖）。
//   2. setInitialSyncCount(n) 播种基线：this.stats.syncedFiles = max(prev, n)。
//   3. 运行时推送 (handleLocalChange) / 拉取 (handleRemoteFileChange) 每次
//      this.stats.syncedFiles++ 都生效。
//
// 复用 integration/sync-engine-diff-preview.test.ts 的轻量构造模式
// （真实协作者 + spy 掉磁盘 I/O），仅注入最小依赖。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncEngine } from "../../src/sync-engine";
import { FileWatcher } from "../../src/file-watcher";
import { OsWriter } from "../../src/os-writer";
import { CrdtEngine } from "../../src/crdt-engine";
import { ConflictDetector } from "../../src/conflict-detector";
import { FileChange, ChangeType, FileCategory, MessageType, SyncMessage } from "../../src/types";

function makeEngine() {
  const fileWatcher = new FileWatcher();
  const osWriter = new OsWriter();
  const crdtEngine = new CrdtEngine();
  const conflictDetector = new ConflictDetector();

  // 避免真实磁盘 I/O
  vi.spyOn(osWriter, "readFile").mockResolvedValue(Buffer.from("content"));
  vi.spyOn(osWriter, "writeFile").mockResolvedValue(undefined);

  const engine = new SyncEngine(fileWatcher, osWriter, crdtEngine, conflictDetector);
  engine.init("device-1", "Test Device", "/test/vault");
  return { engine, osWriter };
}

function makeLocalChange(over: Partial<FileChange> = {}): FileChange {
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

function makeRemoteFileChangeMsg(over: Partial<SyncMessage> = {}): SyncMessage {
  return {
    uuid: "remote-uuid-1",
    type: MessageType.FILE_CHANGE,
    deviceId: "remote-device",
    deviceName: "Remote",
    timestamp: Date.now(),
    payload: {
      relativePath: "notes/remote.md",
      fileCategory: FileCategory.TEXT,
      content: "Hello from remote",
      hash: "hash123",
      mtime: 1000,
      size: 100,
    },
    ...over,
  };
}

function connectedManager() {
  return {
    getIsConnected: () => true,
    sendMessage: vi.fn(),
    sendBinary: vi.fn(),
  } as any;
}

describe("SyncEngine — syncedFiles 行为契约 (BugFix 问题1)", () => {
  let engine: SyncEngine;

  beforeEach(() => {
    ({ engine } = makeEngine());
  });

  it("未同步任何文件时 syncedFiles 为 0（正确基线）", () => {
    expect(engine.getSyncStats().syncedFiles).toBe(0);
  });

  it("getSyncStats 直接返回累积计数器，不被 vaultFileCount/initialSyncFileCount 重算覆盖", () => {
    // 模拟旧代码会读取的输入为非 0（旧 bug 下会算出错误值）
    (engine as any).vaultFileCount = 999;
    (engine as any).initialSyncFileCount = 888;

    // 运行时累积计数器被设为 42
    (engine as any).stats.syncedFiles = 42;

    // 关键断言：必须原样返回 42，而非被重算成 999 或 888+0
    expect(engine.getSyncStats().syncedFiles).toBe(42);
  });

  it("setInitialSyncCount(100) 播种基线为完整同步文件数", () => {
    engine.setInitialSyncCount(100);
    expect(engine.getSyncStats().syncedFiles).toBe(100);
  });

  it("setInitialSyncCount 使用 Math.max：更小值不回退", () => {
    engine.setInitialSyncCount(100);
    engine.setInitialSyncCount(50); // 更小，不应回退
    expect(engine.getSyncStats().syncedFiles).toBe(100);
  });

  it("setInitialSyncCount 使用 Math.max：更大值抬升基线", () => {
    engine.setInitialSyncCount(100);
    engine.setInitialSyncCount(150); // 更大，应抬升
    expect(engine.getSyncStats().syncedFiles).toBe(150);
  });

  it("基线播种后叠加运行时推送增量 (handleLocalChange) 生效 → 101", async () => {
    engine.setInitialSyncCount(100);
    engine.setConnectionManager(connectedManager());

    await engine.handleLocalChange(makeLocalChange());

    expect(engine.getSyncStats().syncedFiles).toBe(101);
  });

  it("基线播种后叠加远程拉取增量 (handleRemoteFileChange) 生效 → 101", async () => {
    engine.setInitialSyncCount(100);

    await engine.handleRemoteMessage(makeRemoteFileChangeMsg());

    expect(engine.getSyncStats().syncedFiles).toBe(101);
  });

  it("多次运行时增量正确累加（基线 100 + 3 次推送 = 103）", async () => {
    engine.setInitialSyncCount(100);
    engine.setConnectionManager(connectedManager());

    await engine.handleLocalChange(makeLocalChange({ relativePath: "a.md" }));
    await engine.handleLocalChange(makeLocalChange({ relativePath: "b.md" }));
    await engine.handleLocalChange(makeLocalChange({ relativePath: "c.md" }));

    expect(engine.getSyncStats().syncedFiles).toBe(103);
  });
});
