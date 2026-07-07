// ============================================================
// InitialSyncManager — "vault 文件总数" 连接即填充回归测试
// ============================================================
// 覆盖 software-bugfix-synccount-c 的「vault 文件数连接即填充」补丁
// （v1.2.0 收尾，工程师交付 IS_PASS: YES）：
//
//   改动 1：FullSyncOptions 新增回调
//     onVaultScanned?: (vaultFileCount: number) => void;
//
//   改动 2：startFullSync() 在 manifest 构建完成后立即上报
//     const manifest = await this.buildManifest();
//     this.localManifest = manifest;
//     this.options.onVaultScanned?.(this.localManifest.length);   // ← 新增
//
//   改动 3：main.ts InitialSyncManager options 实现（与 onFullSyncComplete 并列）
//     onVaultScanned: (count: number) => {
//       this.engine.setVaultFileCount(count);
//     },
//
// 行为契约（本次回归目标）：
//   A. startFullSync() 在 manifest 扫描完成后，至少调用一次 onVaultScanned，
//      且传入参数 === localManifest.length（或 > 0 当 manifest 非空）。
//   B. onVaultScanned 上报的 count 会经由 main.ts 回调实现体流入
//      engine.setVaultFileCount(count)（用真实 SyncEngine + spy 验证调用链）。
//   C. 当 vault 真为空（manifest.length === 0）时，onVaultScanned 仍以 0 上报
//      （与「重启后 vault 文件总数立即有值，除非 vault 真为空」语义一致）。
//   D. 当 options 未提供 onVaultScanned 时，startFullSync() 不抛错
//      （可选回调的 ?. 短路语义）。
//
// 构造策略：轻量 mock connectionManager / crdtEngine / osWriter 最小依赖，
// 通过 vi.spyOn 截获私有方法 buildManifest（仅替换「怎么拿到 manifest」，
// 被测的仍是 startFullSync 内 this.options.onVaultScanned?.(...) 这行真实代码）
// 与 saveManifest（避免向 HOME 写 .obsidian-sync/manifest.json 污染磁盘）。
// 整体参考 tests/unit 既有的轻量构造 + spy 磁盘 I/O 模式。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InitialSyncManager } from "../../src/initial-sync";
import { SyncEngine } from "../../src/sync-engine";
import { FileWatcher } from "../../src/file-watcher";
import { OsWriter } from "../../src/os-writer";
import { CrdtEngine } from "../../src/crdt-engine";
import { ConflictDetector } from "../../src/conflict-detector";
import { ConnectionManager } from "../../src/connection-manager";
import type { ManifestEntry } from "../../src/initial-sync";

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function makeMockConnectionManager(): ConnectionManager {
  return {
    sendMessage: vi.fn(),
    emit: vi.fn(),
  } as unknown as ConnectionManager;
}

function makeRealEngine() {
  const fileWatcher = new FileWatcher();
  const osWriter = new OsWriter();
  const crdtEngine = new CrdtEngine();
  const conflictDetector = new ConflictDetector();

  // 避免真实磁盘 I/O（参考 sync-engine-* 测试）
  vi.spyOn(osWriter, "readFile").mockResolvedValue(Buffer.from("content"));
  vi.spyOn(osWriter, "writeFile").mockResolvedValue(undefined);

  const engine = new SyncEngine(fileWatcher, osWriter, crdtEngine, conflictDetector);
  engine.init("device-1", "Test Device", "/test/vault");
  return engine;
}

function makeManifest(n: number): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (let i = 0; i < n; i++) {
    entries.push({
      relativePath: `notes/note-${i}.md`,
      mtime: 1000 + i,
      hash: `hash-${i}`,
      fileCategory: ("text" as unknown) as ManifestEntry["fileCategory"],
      size: 100 + i,
    });
  }
  return entries;
}

// 构造一个 InitialSyncManager，最少依赖；buildManifest / saveManifest 可在用例中按需 spy
function buildManager(overrides: Partial<{
  onVaultScanned: (count: number) => void;
  onFullSyncComplete: (c: number, v: number) => void;
  onProgress: (p: { total: number; completed: number; current: string }) => void;
}> = {}) {
  const manager = new InitialSyncManager({
    vaultPath: "/test/vault",
    deviceId: "device-1",
    deviceName: "Test Device",
    connectionManager: makeMockConnectionManager(),
    crdtEngine: ({ initDoc: vi.fn(), syncFullDoc: vi.fn() } as unknown) as CrdtEngine,
    osWriter: ({} as unknown) as OsWriter,
    onVaultScanned: overrides.onVaultScanned,
    onFullSyncComplete: overrides.onFullSyncComplete,
    onProgress: overrides.onProgress,
  });
  return manager;
}

// ------------------------------------------------------------
// Test Suites
// ------------------------------------------------------------

describe("InitialSyncManager.startFullSync — onVaultScanned 上报 (补丁核心)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("A: 非空的 manifest 扫描后，onVaultScanned 至少调用一次且 count === localManifest.length", async () => {
    // Arrange
    const onVaultScanned = vi.fn();
    const manager = buildManager({ onVaultScanned });
    const manifest = makeManifest(3);

    // 仅替换「如何拿到 manifest」，被测行仍是 startFullSync 内的真实调用
    const buildSpy = vi
      .spyOn(InitialSyncManager.prototype as any, "buildManifest")
      .mockResolvedValue(manifest);
    vi.spyOn(InitialSyncManager.prototype as any, "saveManifest").mockResolvedValue(undefined);

    // Act
    await manager.startFullSync();

    // Assert
    expect(buildSpy).toHaveBeenCalled();
    expect(onVaultScanned).toHaveBeenCalledTimes(1);
    expect(onVaultScanned).toHaveBeenCalledWith(3);

    // 进一步证明传入的是真实 localManifest.length（非写死常量）
    expect(onVaultScanned).toHaveBeenCalledWith(manifest.length);
  });

  it("C: vault 真为空时，onVaultScanned 以 0 上报（不依赖远端协议是否走完）", async () => {
    // Arrange
    const onVaultScanned = vi.fn();
    const manager = buildManager({ onVaultScanned });

    vi.spyOn(InitialSyncManager.prototype as any, "buildManifest").mockResolvedValue([]);
    vi.spyOn(InitialSyncManager.prototype as any, "saveManifest").mockResolvedValue(undefined);

    // Act
    await manager.startFullSync();

    // Assert：空 vault → 立即上报 0，重启后界面显示 0（符合语义）
    expect(onVaultScanned).toHaveBeenCalledTimes(1);
    expect(onVaultScanned).toHaveBeenCalledWith(0);
  });

  it("A: 较大 manifest（226 个文件）上报 count === 226，证明非写死、取自 length", async () => {
    // Arrange
    const onVaultScanned = vi.fn();
    const manager = buildManager({ onVaultScanned });
    const manifest = makeManifest(226);

    vi.spyOn(InitialSyncManager.prototype as any, "buildManifest").mockResolvedValue(manifest);
    vi.spyOn(InitialSyncManager.prototype as any, "saveManifest").mockResolvedValue(undefined);

    // Act
    await manager.startFullSync();

    // Assert
    expect(onVaultScanned).toHaveBeenCalledWith(226);
    expect(onVaultScanned).toHaveBeenCalledWith(manifest.length);
  });

  it("D: options 未提供 onVaultScanned 时，startFullSync 不抛错（?. 短路语义）", async () => {
    // Arrange
    const manager = buildManager(); // 不传 onVaultScanned

    vi.spyOn(InitialSyncManager.prototype as any, "buildManifest").mockResolvedValue(makeManifest(5));
    vi.spyOn(InitialSyncManager.prototype as any, "saveManifest").mockResolvedValue(undefined);

    // Act / Assert：不应抛错
    await expect(manager.startFullSync()).resolves.toBeUndefined();
  });

  it("A: onVaultScanned 在 manifest 构建后立即上报（早于远端 ACK / allComplete）", async () => {
    // Arrange
    const onVaultScanned = vi.fn();
    const onFullSyncComplete = vi.fn();
    const manager = buildManager({ onVaultScanned, onFullSyncComplete });
    const manifest = makeManifest(4);

    vi.spyOn(InitialSyncManager.prototype as any, "buildManifest").mockResolvedValue(manifest);
    vi.spyOn(InitialSyncManager.prototype as any, "saveManifest").mockResolvedValue(undefined);

    // Act
    await manager.startFullSync();

    // Assert：onVaultScanned 已触发，而 onFullSyncComplete 尚未触发
    // （后者依赖 handleFileListAck 收到 allComplete，本流程未走）
    expect(onVaultScanned).toHaveBeenCalledWith(4);
    expect(onFullSyncComplete).not.toHaveBeenCalled();
  });
});

describe("main.ts 接线 — onVaultScanned → engine.setVaultFileCount 调用链", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("B: onVaultScanned(count) 实现体能将 count 写入 engine.setVaultFileCount（复刻 main.ts 实现）", async () => {
    // Arrange：复刻 main.ts 的 onVaultScanned 闭包实现
    const engine = makeRealEngine();
    const setVaultFileCountSpy = vi.spyOn(engine, "setVaultFileCount");

    // 与 main.ts 完全一致的实现体；用 vi.fn 包裹既是 spy 又可断言调用
    const onVaultScanned = vi.fn((count: number) => {
      engine.setVaultFileCount(count);
    });

    const manager = buildManager({ onVaultScanned });
    const manifest = makeManifest(7);

    vi.spyOn(InitialSyncManager.prototype as any, "buildManifest").mockResolvedValue(manifest);
    vi.spyOn(InitialSyncManager.prototype as any, "saveManifest").mockResolvedValue(undefined);

    // Act
    await manager.startFullSync();

    // Assert：count 经 onVaultScanned 流入 setVaultFileCount
    expect(setVaultFileCountSpy).toHaveBeenCalledTimes(1);
    expect(setVaultFileCountSpy).toHaveBeenCalledWith(7);
    // 且 engine 内部状态确实被更新（与 sync-engine-vault-count 测试呼应）
    expect(engine.getSyncStats().vaultFileCount).toBe(7);
  });

  it("B: 空 vault（count=0）时，setVaultFileCount(0) 仍被调用（无下探掩码，可归零）", async () => {
    // Arrange
    const engine = makeRealEngine();
    const setVaultFileCountSpy = vi.spyOn(engine, "setVaultFileCount");
    const onVaultScanned = vi.fn((count: number) => {
      engine.setVaultFileCount(count);
    });

    const manager = buildManager({ onVaultScanned });

    vi.spyOn(InitialSyncManager.prototype as any, "buildManifest").mockResolvedValue([]);
    vi.spyOn(InitialSyncManager.prototype as any, "saveManifest").mockResolvedValue(undefined);

    // Act
    await manager.startFullSync();

    // Assert：即使 count=0，回调与 setVaultFileCount 都执行（证明无 Math.max 掩码）
    expect(onVaultScanned).toHaveBeenCalledWith(0);
    expect(setVaultFileCountSpy).toHaveBeenCalledWith(0);
    expect(engine.getSyncStats().vaultFileCount).toBe(0);
  });
});
