// ============================================================
// Sync Engine — "vault 文件总数" (vaultFileCount) Regression Tests
// ============================================================
// Covers C 方案补丁（v1.2.0 收尾）：
//   - SyncStats 接口新增必填字段 vaultFileCount
//   - SyncEngine.stats 初始化补 vaultFileCount: 0（类型完整性）
//   - getSyncStats() 返回体携带 vaultFileCount: this.vaultFileCount
//   - 新增 setVaultFileCount(count) 直接写字段，无 Math.max 之类掩码
//
// 行为契约：
//   1. getSyncStats().vaultFileCount 默认 === 0
//      （stats 初始化补的 vaultFileCount: 0 生效，证明类型完整性修复正确）
//   2. setVaultFileCount(n) 后 getSyncStats().vaultFileCount === n
//      （返回值正确携带字段，且等于私有字段 this.vaultFileCount）
//   3. setVaultFileCount 直接写字段、无掩码：
//      setVaultFileCount(0) → 0；setVaultFileCount(500) → 500
//      （与 syncedFiles 的 Math.max 基线逻辑严格区分）
//   4. syncedFiles 与 vaultFileCount 相互独立：
//      同时操作两者，互不串味。
//
// 复用 integration/sync-engine-diff-preview.test.ts 的轻量构造模式
// （真实协作者 + spy 掉磁盘 I/O），仅注入最小依赖。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncEngine } from "../../src/sync-engine";
import { FileWatcher } from "../../src/file-watcher";
import { OsWriter } from "../../src/os-writer";
import { CrdtEngine } from "../../src/crdt-engine";
import { ConflictDetector } from "../../src/conflict-detector";
import { FileChange, ChangeType, FileCategory } from "../../src/types";

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

function connectedManager() {
  return {
    getIsConnected: () => true,
    sendMessage: vi.fn(),
    sendBinary: vi.fn(),
  } as any;
}

describe("SyncEngine — vaultFileCount 行为契约 (C 方案)", () => {
  let engine: SyncEngine;

  beforeEach(() => {
    ({ engine } = makeEngine());
  });

  // ---- 契约 1：默认值为 0，证明类型完整性修复正确 ----
  it("默认 vaultFileCount 为 0（stats 初始化补字段生效）", () => {
    // Arrange / Act
    const stats = engine.getSyncStats();

    // Assert
    expect(stats.vaultFileCount).toBe(0);
  });

  it("getSyncStats 直接返回私有字段 this.vaultFileCount（默认 0）", () => {
    // Assert 行为契约：返回体字段 === 私有字段
    expect(engine.getSyncStats().vaultFileCount).toBe(
      (engine as any).vaultFileCount,
    );
  });

  // ---- 契约 2：setter 正确携带字段 ----
  it("setVaultFileCount(226) 后 getSyncStats().vaultFileCount === 226", () => {
    // Act
    engine.setVaultFileCount(226);

    // Assert
    expect(engine.getSyncStats().vaultFileCount).toBe(226);
    expect(engine.getSyncStats().vaultFileCount).toBe(
      (engine as any).vaultFileCount,
    );
  });

  // ---- 契约 3：setter 直接写字段、无 Math.max 掩码 ----
  it("setVaultFileCount(0) 后归零为 0（无掩码下探）", () => {
    // Arrange：先设一个非 0 值
    engine.setVaultFileCount(500);
    expect(engine.getSyncStats().vaultFileCount).toBe(500);

    // Act
    engine.setVaultFileCount(0);

    // Assert：必须能回到 0，证明没有 Math.max(_, 0) 之类掩码
    expect(engine.getSyncStats().vaultFileCount).toBe(0);
  });

  it("setVaultFileCount(500) 后保持 500（无上限/掩码）", () => {
    // Act
    engine.setVaultFileCount(500);

    // Assert
    expect(engine.getSyncStats().vaultFileCount).toBe(500);
  });

  it("多次 setter 顺序写入：最终值等于最后一次写入（直接赋值语义）", () => {
    engine.setVaultFileCount(10);
    engine.setVaultFileCount(20);
    engine.setVaultFileCount(15);

    expect(engine.getSyncStats().vaultFileCount).toBe(15);
  });

  // ---- 契约 4：syncedFiles 与 vaultFileCount 相互独立 ----
  it("两者不串味：setVaultFileCount(300) 不影响 syncedFiles（仍 0）", () => {
    engine.setVaultFileCount(300);

    const stats = engine.getSyncStats();
    expect(stats.vaultFileCount).toBe(300);
    expect(stats.syncedFiles).toBe(0);
  });

  it("两者不串味：运行时推送使 syncedFiles +1，vaultFileCount 保持 300", async () => {
    // Arrange
    engine.setVaultFileCount(300);
    engine.setConnectionManager(connectedManager());

    // Act：一次本地推送
    await engine.handleLocalChange(makeLocalChange());

    // Assert
    const stats = engine.getSyncStats();
    expect(stats.vaultFileCount).toBe(300); // 不被触碰
    expect(stats.syncedFiles).toBe(1); // 累积计数器 +1
  });

  it("两者不串味：setInitialSyncCount 播种 syncedFiles 基线，不动 vaultFileCount", () => {
    // Arrange
    engine.setVaultFileCount(300);

    // Act
    engine.setInitialSyncCount(100);

    // Assert：syncedFiles 播种为 100，vaultFileCount 保持 300
    const stats = engine.getSyncStats();
    expect(stats.syncedFiles).toBe(100);
    expect(stats.vaultFileCount).toBe(300);
  });
});
