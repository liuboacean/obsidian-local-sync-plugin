// ============================================================
// Sync Engine — 删除传播 (FILE_DELETE) 专项测试
// ============================================================
// 覆盖 BugFix：删除文件时，对端收不到删除 → 孤儿文件。
// 根因：handleLocalChange 收到 DELETE 事件后仍当 TEXT 走
// handleLocalTextChange 去 readFile 已删文件 → ENOENT → 删除从未发出。
//
// 行为契约（待验证）：
//   发送端 handleLocalChange(DELETE)
//     1. 不再 readFile（不抛 ENOENT），stats.failedFiles 不增。
//     2. 在 TEXT/BINARY 分发前早返回到 handleLocalDeleteChange。
//     3. 发送 MessageType.FILE_DELETE 控制消息（payload.relativePath 正确）。
//     4. TEXT 删除额外发一条 CRDT "删空" 更新（initDoc→setTextContent("")→
//        generateUpdate→sendBinary）；BINARY 不发 CRDT、不读盘。
//     5. stats.syncedFiles 递增。
//   接收端 handleRemoteFileChange(FILE_DELETE)
//     6. osWriter.deleteFile 被调用。
//     7. crdtEngine.destroyDoc(generateDocId(relativePath)) 被调用。
//     8. stats.syncedFiles 递增。
//   协议可达性
//     9. deserializeMessage 能识别 FILE_DELETE（Object.values(MessageType) 含它）。
//   回归护栏
//    10. 正常 CREATE/MODIFY 仍走 handleLocalTextChange / handleLocalBinaryChange，
//        DELETE 早返回分支未误伤正常路径。
//
// 复用既有 mock 底座（tests/mocks/obsidian.ts、tests/setup.ts），
// 参考 sync-engine-synced-files.test.ts 的轻量构造模式（真实协作者 + spy 磁盘 I/O）。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncEngine } from "../../src/sync-engine";
import { FileWatcher } from "../../src/file-watcher";
import { OsWriter } from "../../src/os-writer";
import { CrdtEngine } from "../../src/crdt-engine";
import { ConflictDetector } from "../../src/conflict-detector";
import { deserializeMessage, serializeMessage, createMessage } from "../../src/protocol";
import { generateDocId } from "../../src/utils";
import {
  FileChange,
  ChangeType,
  FileCategory,
  MessageType,
  SyncMessage,
} from "../../src/types";

// ============================================================
// 构造底座
// ============================================================

function makeEngine() {
  const fileWatcher = new FileWatcher();
  const osWriter = new OsWriter();
  const crdtEngine = new CrdtEngine();
  const conflictDetector = new ConflictDetector();

  // 避免真实磁盘 I/O
  vi.spyOn(osWriter, "readFile").mockResolvedValue(Buffer.from("content"));
  vi.spyOn(osWriter, "writeFile").mockResolvedValue(undefined);
  vi.spyOn(osWriter, "deleteFile").mockResolvedValue(undefined);

  const engine = new SyncEngine(fileWatcher, osWriter, crdtEngine, conflictDetector);
  engine.init("device-1", "Test Device", "/test/vault");
  return { engine, osWriter, crdtEngine };
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

function makeDeleteChange(over: Partial<FileChange> = {}): FileChange {
  return makeLocalChange({
    type: ChangeType.DELETE,
    ...over,
  });
}

function makeFileDeleteMsg(over: Partial<SyncMessage> = {}): SyncMessage {
  return {
    uuid: "remote-delete-uuid-1",
    type: MessageType.FILE_DELETE,
    deviceId: "remote-device",
    deviceName: "Remote",
    timestamp: Date.now(),
    payload: {
      relativePath: "notes/diary.md",
      fileCategory: FileCategory.TEXT,
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

const TEST_PATH = "notes/diary.md";

// ============================================================
// 发送端：handleLocalChange(DELETE)
// ============================================================

describe("SyncEngine — 删除传播 发送端 (handleLocalChange DELETE)", () => {
  let engine: SyncEngine;
  let osWriter: OsWriter;
  let crdtEngine: CrdtEngine;

  beforeEach(() => {
    ({ engine, osWriter, crdtEngine } = makeEngine());
    engine.setConnectionManager(connectedManager());
  });

  it("TEXT 删除：不抛 ENOENT，stats.failedFiles 不增", async () => {
    const before = engine.getSyncStats().failedFiles;
    await expect(
      engine.handleLocalChange(makeDeleteChange({ fileCategory: FileCategory.TEXT, relativePath: TEST_PATH })),
    ).resolves.not.toThrow();
    expect(engine.getSyncStats().failedFiles).toBe(before);
  });

  it("TEXT 删除：发送 MessageType.FILE_DELETE 且 payload.relativePath 正确", async () => {
    const cm = connectedManager();
    engine.setConnectionManager(cm);

    await engine.handleLocalChange(makeDeleteChange({ fileCategory: FileCategory.TEXT, relativePath: TEST_PATH }));

    expect(cm.sendMessage).toHaveBeenCalledTimes(1);
    const sent = cm.sendMessage.mock.calls[0][0] as SyncMessage;
    expect(sent.type).toBe(MessageType.FILE_DELETE);
    expect((sent.payload as Record<string, unknown>).relativePath).toBe(TEST_PATH);
    expect((sent.payload as Record<string, unknown>).fileCategory).toBe(FileCategory.TEXT);
  });

  it("TEXT 删除：发送 CRDT 删空更新（setTextContent(\"\")→generateUpdate→sendBinary）", async () => {
    const cm = connectedManager();
    engine.setConnectionManager(cm);

    const setTextSpy = vi.spyOn(crdtEngine, "setTextContent");
    const genSpy = vi.spyOn(crdtEngine, "generateUpdate");

    await engine.handleLocalChange(makeDeleteChange({ fileCategory: FileCategory.TEXT, relativePath: TEST_PATH }));

    // 必须调用 setTextContent 并把文档置空
    expect(setTextSpy).toHaveBeenCalledWith(expect.anything(), "");
    // 必须基于空文档生成更新并通过二进制帧发出
    expect(genSpy).toHaveBeenCalledTimes(1);
    const doc = genSpy.mock.calls[0][0];
    expect(crdtEngine.getTextContent(doc)).toBe("");
    expect(cm.sendBinary).toHaveBeenCalled();
  });

  it("TEXT 删除：stats.syncedFiles 递增", async () => {
    engine.setInitialSyncCount(100);
    await engine.handleLocalChange(makeDeleteChange({ fileCategory: FileCategory.TEXT, relativePath: TEST_PATH }));
    expect(engine.getSyncStats().syncedFiles).toBe(101);
  });

  it("BINARY 删除：发送 FILE_DELETE，不读盘、不发 CRDT，failedFiles 不增", async () => {
    const cm = connectedManager();
    engine.setConnectionManager(cm);
    const before = engine.getSyncStats().failedFiles;

    const readSpy = vi.spyOn(osWriter, "readFile");
    const genSpy = vi.spyOn(crdtEngine, "generateUpdate");

    await expect(
      engine.handleLocalChange(makeDeleteChange({ fileCategory: FileCategory.BINARY, relativePath: "images/photo.png" })),
    ).resolves.not.toThrow();

    // 关键：删除已不存在的文件，绝不该去 readFile
    expect(readSpy).not.toHaveBeenCalled();
    // BINARY 删除走控制消息，不发 CRDT 更新
    expect(genSpy).not.toHaveBeenCalled();
    expect(cm.sendBinary).not.toHaveBeenCalled();

    expect(cm.sendMessage).toHaveBeenCalledTimes(1);
    const sent = cm.sendMessage.mock.calls[0][0] as SyncMessage;
    expect(sent.type).toBe(MessageType.FILE_DELETE);
    expect((sent.payload as Record<string, unknown>).fileCategory).toBe(FileCategory.BINARY);
    expect(engine.getSyncStats().failedFiles).toBe(before);
  });

  it("BINARY 删除：stats.syncedFiles 递增", async () => {
    engine.setInitialSyncCount(100);
    await engine.handleLocalChange(makeDeleteChange({ fileCategory: FileCategory.BINARY, relativePath: "images/photo.png" }));
    expect(engine.getSyncStats().syncedFiles).toBe(101);
  });

  it("DELETE 早返回：仅调用 handleLocalDeleteChange，未误入 text/binary 分支", async () => {
    const deleteSpy = vi.spyOn(engine as any, "handleLocalDeleteChange");
    const textSpy = vi.spyOn(engine as any, "handleLocalTextChange");
    const binarySpy = vi.spyOn(engine as any, "handleLocalBinaryChange");

    await engine.handleLocalChange(makeDeleteChange({ fileCategory: FileCategory.TEXT, relativePath: TEST_PATH }));

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(textSpy).not.toHaveBeenCalled();
    expect(binarySpy).not.toHaveBeenCalled();
  });
});

// ============================================================
// 接收端：handleRemoteFileChange(FILE_DELETE)
// ============================================================

describe("SyncEngine — 删除传播 接收端 (handleRemoteFileChange FILE_DELETE)", () => {
  let engine: SyncEngine;
  let osWriter: OsWriter;
  let crdtEngine: CrdtEngine;

  beforeEach(() => {
    ({ engine, osWriter, crdtEngine } = makeEngine());
  });

  it("FILE_DELETE：调用 osWriter.deleteFile 与 crdtEngine.destroyDoc(generateDocId(relativePath))", async () => {
    const deleteSpy = vi.spyOn(osWriter, "deleteFile");
    const destroySpy = vi.spyOn(crdtEngine, "destroyDoc");

    await engine.handleRemoteMessage(makeFileDeleteMsg({ payload: { relativePath: TEST_PATH, fileCategory: FileCategory.TEXT } }));

    expect(deleteSpy).toHaveBeenCalledWith("/test/vault", TEST_PATH);
    expect(destroySpy).toHaveBeenCalledWith(generateDocId(TEST_PATH));
  });

  it("FILE_DELETE（BINARY）：同样删除本地文件并销毁 CRDT 文档", async () => {
    const deleteSpy = vi.spyOn(osWriter, "deleteFile");
    const destroySpy = vi.spyOn(crdtEngine, "destroyDoc");

    await engine.handleRemoteMessage(
      makeFileDeleteMsg({ payload: { relativePath: "images/photo.png", fileCategory: FileCategory.BINARY } }),
    );

    expect(deleteSpy).toHaveBeenCalledWith("/test/vault", "images/photo.png");
    expect(destroySpy).toHaveBeenCalledWith(generateDocId("images/photo.png"));
  });

  it("FILE_DELETE：stats.syncedFiles 递增", async () => {
    engine.setInitialSyncCount(100);
    await engine.handleRemoteMessage(makeFileDeleteMsg({ payload: { relativePath: TEST_PATH, fileCategory: FileCategory.TEXT } }));
    expect(engine.getSyncStats().syncedFiles).toBe(101);
  });

  it("FILE_DELETE：遍历 dispatch 命中（handleRemoteMessage case FILE_DELETE → handleRemoteFileChange）", async () => {
    const fileChangeSpy = vi.spyOn(engine as any, "handleRemoteFileChange");
    await engine.handleRemoteMessage(makeFileDeleteMsg());
    expect(fileChangeSpy).toHaveBeenCalledTimes(1);
    expect((fileChangeSpy.mock.calls[0][0] as SyncMessage).type).toBe(MessageType.FILE_DELETE);
  });
});

// ============================================================
// 协议可达性：FILE_DELETE 能被反序列化识别
// ============================================================

describe("协议可达性 — FILE_DELETE 可通过反序列化校验", () => {
  it("Object.values(MessageType) 包含 FILE_DELETE（deserializeMessage 校验通过）", () => {
    expect(Object.values(MessageType).includes(MessageType.FILE_DELETE)).toBe(true);
  });

  it("serialize→deserialize 往返保留 FILE_DELETE 且 payload.relativePath 正确", () => {
    const msg = createMessage(
      MessageType.FILE_DELETE,
      { relativePath: TEST_PATH, fileCategory: FileCategory.TEXT },
      "device-1",
      "Test Device",
    );
    const json = serializeMessage(msg);
    const parsed = deserializeMessage(json);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe(MessageType.FILE_DELETE);
    expect((parsed!.payload as Record<string, unknown>).relativePath).toBe(TEST_PATH);
  });
});

// ============================================================
// 回归护栏：正常 CREATE/MODIFY 仍走原路径（DELETE 早返回未误伤）
// ============================================================

describe("回归护栏 — 正常 CREATE/MODIFY 仍走 text/binary 分支", () => {
  let engine: SyncEngine;

  beforeEach(() => {
    ({ engine } = makeEngine());
    engine.setConnectionManager(connectedManager());
  });

  it("MODIFY(TEXT)：走 handleLocalTextChange，发 FILE_CHANGE，不误入删除分支", async () => {
    const deleteSpy = vi.spyOn(engine as any, "handleLocalDeleteChange");
    const cm = engine["connectionManager"] as any;

    await engine.handleLocalChange(makeLocalChange({ type: ChangeType.MODIFY, fileCategory: FileCategory.TEXT, relativePath: TEST_PATH }));

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(cm.sendMessage).toHaveBeenCalled();
    const sent = cm.sendMessage.mock.calls[0][0] as SyncMessage;
    expect(sent.type).toBe(MessageType.FILE_CHANGE);
    expect((sent.payload as Record<string, unknown>).content).toBeDefined();
  });

  it("CREATE(BINARY)：走 handleLocalBinaryChange，发 FILE_CHANGE(BINARY)，不误入删除分支", async () => {
    const deleteSpy = vi.spyOn(engine as any, "handleLocalDeleteChange");
    const cm = engine["connectionManager"] as any;

    await engine.handleLocalChange(makeLocalChange({ type: ChangeType.CREATE, fileCategory: FileCategory.BINARY, relativePath: "images/new.png" }));

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(cm.sendMessage).toHaveBeenCalled();
    const sent = cm.sendMessage.mock.calls[0][0] as SyncMessage;
    expect(sent.type).toBe(MessageType.FILE_CHANGE);
    expect((sent.payload as Record<string, unknown>).fileCategory).toBe(FileCategory.BINARY);
  });
});
