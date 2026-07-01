// ============================================================
// E2E Sync Integration Test
// ============================================================
// Simulates two devices (A and B) syncing files via WebSocket.
// Tests the complete sync flow: text sync, binary sync, conflict detection.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CrdtEngine } from "../../src/crdt-engine";
import { ConflictDetector } from "../../src/conflict-detector";
import { FileCategory, ChangeType, MessageType, SyncMessage } from "../../src/types";
import { createMessage } from "../../src/protocol";
import { generateDocId } from "../../src/utils";

// ============================================================
// Integration Test Helpers
// ============================================================

interface SyncEndpoint {
  crdt: CrdtEngine;
  conflictDetector: ConflictDetector;
  deviceId: string;
  receivedMessages: SyncMessage[];
  receivedBinaryUpdates: Map<string, Uint8Array[]>;
}

function createEndpoint(deviceId: string): SyncEndpoint {
  return {
    crdt: new CrdtEngine(),
    conflictDetector: new ConflictDetector(),
    deviceId,
    receivedMessages: [],
    receivedBinaryUpdates: new Map(),
  };
}

function sendTextUpdate(
  sender: SyncEndpoint,
  receiver: SyncEndpoint,
  relativePath: string,
  content: string,
): void {
  const docId = generateDocId(relativePath);
  const doc = sender.crdt.initDoc(docId, relativePath, content);
  const update = sender.crdt.generateUpdate(doc);

  // Apply to receiver's CRDT
  let receiverDoc = receiver.crdt.getDoc(docId);
  if (!receiverDoc) {
    receiverDoc = receiver.crdt.initDoc(docId, relativePath);
  }
  receiver.crdt.applyUpdate(receiverDoc, update);

  // Track
  if (!receiver.receivedBinaryUpdates.has(docId)) {
    receiver.receivedBinaryUpdates.set(docId, []);
  }
  receiver.receivedBinaryUpdates.get(docId)!.push(update);
}

function sendFullFile(
  sender: SyncEndpoint,
  receiver: SyncEndpoint,
  relativePath: string,
  fileCategory: FileCategory,
  content: string,
): void {
  const msg = createMessage(
    MessageType.FILE_CHANGE,
    {
      relativePath,
      fileCategory,
      content: Buffer.from(content).toString("base64"),
      hash: "mock-hash",
      mtime: Date.now(),
      size: content.length,
    },
    sender.deviceId,
    sender.deviceId,
  );
  receiver.receivedMessages.push(msg);
}

// ============================================================
// E2E Tests
// ============================================================

describe("E2E Sync — Two Devices", () => {
  let deviceA: SyncEndpoint;
  let deviceB: SyncEndpoint;

  beforeEach(() => {
    deviceA = createEndpoint("device-a");
    deviceB = createEndpoint("device-b");
  });

  afterEach(() => {
    deviceA.crdt.destroy();
    deviceB.crdt.destroy();
  });

  it("should sync a text file from A to B", () => {
    sendTextUpdate(deviceA, deviceB, "notes/hello.md", "# Hello from A");

    const docId = generateDocId("notes/hello.md");
    const docB = deviceB.crdt.getDoc(docId);
    expect(docB).toBeDefined();
    expect(deviceB.crdt.getTextContent(docB!)).toBe("# Hello from A");
  });

  it("should converge after concurrent edits on both sides", () => {
    const relativePath = "notes/collab.md";
    const baseContent = "Line 1\nLine 2\nLine 3";

    // Both start with the same base
    sendTextUpdate(deviceA, deviceB, relativePath, baseContent);
    sendTextUpdate(deviceB, deviceA, relativePath, baseContent);

    const docId = generateDocId(relativePath);

    // A edits line 1
    const docA = deviceA.crdt.getDoc(docId)!;
    docA.transact(() => {
      const ytext = docA.getText("content");
      ytext.delete(0, 6);
      ytext.insert(0, "Line A");
    });
    const updateA = deviceA.crdt.generateUpdate(docA);

    // B edits line 3 (concurrently)
    const docB = deviceB.crdt.getDoc(docId)!;
    docB.transact(() => {
      const ytext = docB.getText("content");
      ytext.delete(18, 6);
      ytext.insert(18, "Line C");
    });
    const updateB = deviceB.crdt.generateUpdate(docB);

    // Exchange updates
    deviceA.crdt.applyUpdate(docA, updateB);
    deviceB.crdt.applyUpdate(docB, updateA);

    // Both should converge
    expect(deviceA.crdt.getTextContent(docA)).toBe(
      deviceB.crdt.getTextContent(docB),
    );
  });
});

// ============================================================
// Binary File Sync
// ============================================================

describe("E2E Sync — Binary Files", () => {
  let deviceA: SyncEndpoint;
  let deviceB: SyncEndpoint;

  beforeEach(() => {
    deviceA = createEndpoint("device-a");
    deviceB = createEndpoint("device-b");
  });

  afterEach(() => {
    deviceA.crdt.destroy();
    deviceB.crdt.destroy();
  });

  it("should transfer a binary file from A to B", () => {
    sendFullFile(
      deviceA,
      deviceB,
      "images/photo.png",
      FileCategory.BINARY,
      "fake-png-content",
    );

    expect(deviceB.receivedMessages.length).toBe(1);
    expect(deviceB.receivedMessages[0].type).toBe(MessageType.FILE_CHANGE);
    expect(deviceB.receivedMessages[0].payload.relativePath).toBe(
      "images/photo.png",
    );
    expect(deviceB.receivedMessages[0].payload.fileCategory).toBe(
      FileCategory.BINARY,
    );
  });

  it("should detect binary file conflict (same file edited on both sides)", () => {
    const relativePath = "images/photo.png";

    // Simulate: A and B both have different versions
    const localHash = "hash-local";
    const remoteHash = "hash-remote";
    const localMtime = Date.now() - 5000; // 5s ago
    const remoteMtime = Date.now(); // now

    const hasConflict = deviceB.conflictDetector.detect(
      FileCategory.BINARY,
      localHash,
      remoteHash,
      localMtime,
      remoteMtime,
      "MODIFY_VS_MODIFY",
    );

    expect(hasConflict).toBe(true);

    // Register the conflict
    deviceB.conflictDetector.registerConflict({
      relativePath,
      localVersion: {
        type: ChangeType.MODIFY,
        relativePath,
        mtime: localMtime,
        hash: localHash,
        originDeviceId: "device-b",
        version: 1,
        fileCategory: FileCategory.BINARY,
        size: 1024,
      },
      remoteVersion: {
        type: ChangeType.MODIFY,
        relativePath,
        mtime: remoteMtime,
        hash: remoteHash,
        originDeviceId: "device-a",
        version: 1,
        fileCategory: FileCategory.BINARY,
        size: 2048,
      },
      status: "UNRESOLVED" as any,
      detectedAt: Date.now(),
      conflictType: "MODIFY_VS_MODIFY",
    });

    expect(deviceB.conflictDetector.hasConflict(relativePath)).toBe(true);
  });
});
