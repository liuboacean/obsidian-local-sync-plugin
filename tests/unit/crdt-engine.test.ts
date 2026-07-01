// ============================================================
// CRDT Engine Tests
// ============================================================
// The most critical test file — validates Yjs CRDT correctness
// for concurrent text editing, incremental updates, and snapshots.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { CrdtEngine } from "../../src/crdt-engine";
import { FileCategory } from "../../src/types";

// ============================================================
// CRDT Engine — Document Lifecycle
// ============================================================

describe("CrdtEngine — Document Lifecycle", () => {
  let engine: CrdtEngine;

  beforeEach(() => {
    engine = new CrdtEngine();
  });

  afterEach(() => {
    engine.destroy();
  });

  it("should create a new document with initial content", () => {
    const doc = engine.initDoc("doc-1", "notes/test.md", "Hello, world!");
    expect(doc).toBeDefined();
    expect(doc).toBeInstanceOf(Y.Doc);
    expect(engine.hasDoc("doc-1")).toBe(true);
  });

  it("should return existing document on duplicate initDoc", () => {
    const doc1 = engine.initDoc("doc-1", "notes/test.md", "Hello");
    const doc2 = engine.initDoc("doc-1", "notes/test.md", "World");
    expect(doc1).toBe(doc2);
    // Content should be "Hello" (first init), not overwritten
    expect(engine.getTextContent(doc1)).toBe("Hello");
  });

  it("should set and get text content", () => {
    const doc = engine.initDoc("doc-1", "test.md");
    engine.setTextContent(doc, "New content here");
    expect(engine.getTextContent(doc)).toBe("New content here");
  });

  it("should support empty documents", () => {
    const doc = engine.initDoc("doc-1", "empty.md");
    expect(engine.getTextContent(doc)).toBe("");
  });

  it("should destroy a document", () => {
    engine.initDoc("doc-1", "test.md", "Content");
    expect(engine.hasDoc("doc-1")).toBe(true);
    engine.destroyDoc("doc-1");
    expect(engine.hasDoc("doc-1")).toBe(false);
  });

  it("should handle destroy non-existent doc gracefully", () => {
    engine.destroyDoc("non-existent");
    // No throw expected
  });
});

// ============================================================
// CRDT Engine — Incremental Updates
// ============================================================

describe("CrdtEngine — Incremental Updates", () => {
  let engine: CrdtEngine;

  beforeEach(() => {
    engine = new CrdtEngine();
  });

  afterEach(() => {
    engine.destroy();
  });

  it("should generate an incremental update", () => {
    const doc = engine.initDoc("doc-1", "test.md", "Initial content");
    const update = engine.generateUpdate(doc);
    expect(update).toBeDefined();
    expect(update.byteLength).toBeGreaterThan(0);
  });

  it("should apply an incremental update from another doc", () => {
    // Simulate two devices
    const engineA = new CrdtEngine();
    const engineB = new CrdtEngine();

    try {
      // Initialize both docs empty, then do a full sync of the initial state
      const docA = engineA.initDoc("shared", "test.md");
      const docB = engineB.initDoc("shared", "test.md");

      // A writes initial content and sends full snapshot to B
      engineA.setTextContent(docA, "Initial");
      const fullSnapshot = engineA.syncFullDoc(docA);
      engineB.applyUpdate(docB, fullSnapshot);
      expect(engineB.getTextContent(docB)).toBe("Initial");

      // A makes a subsequent incremental change
      engineA.setTextContent(docA, "Changed by A");
      const update = engineA.generateUpdate(docA);

      // B applies A's incremental update
      engineB.applyUpdate(docB, update);

      // Both should have the same content
      expect(engineB.getTextContent(docB)).toBe("Changed by A");
    } finally {
      engineA.destroy();
      engineB.destroy();
    }
  });

  it("should merge concurrent edits correctly (CRDT property)", () => {
    const engineA = new CrdtEngine();
    const engineB = new CrdtEngine();

    try {
      // Both start with the same base
      const docA = engineA.initDoc("shared", "notes.md", "Hello World");
      const docB = engineB.initDoc("shared", "notes.md", "Hello World");

      // A inserts at position 6
      docA.transact(() => {
        const ytextA = docA.getText("content");
        ytextA.delete(5, 6); // Delete " World"
        ytextA.insert(5, " CRDT");
      });
      const updateA = engineA.generateUpdate(docA);

      // B modifies differently
      docB.transact(() => {
        const ytextB = docB.getText("content");
        ytextB.delete(0, 6); // Delete "Hello "
        ytextB.insert(0, "Hi ");
      });
      const updateB = engineB.generateUpdate(docB);

      // Exchange updates
      engineA.applyUpdate(docA, updateB);
      engineB.applyUpdate(docB, updateA);

      // Both should converge to the same content
      const contentA = engineA.getTextContent(docA);
      const contentB = engineB.getTextContent(docB);
      expect(contentA).toBe(contentB);
    } finally {
      engineA.destroy();
      engineB.destroy();
    }
  });

  it("should converge after complex concurrent edits", () => {
    const engineA = new CrdtEngine();
    const engineB = new CrdtEngine();

    try {
      const docA = engineA.initDoc("shared", "complex.md", "Line 1\nLine 2\nLine 3");
      const docB = engineB.initDoc("shared", "complex.md", "Line 1\nLine 2\nLine 3");

      // A edits line 1
      docA.transact(() => {
        const ytextA = docA.getText("content");
        ytextA.delete(0, 6);
        ytextA.insert(0, "Line A");
      });

      // B edits line 3
      docB.transact(() => {
        const ytextB = docB.getText("content");
        ytextB.delete(18, 6);
        ytextB.insert(18, "Line C");
      });

      const updateA = engineA.generateUpdate(docA);
      const updateB = engineB.generateUpdate(docB);

      // Apply crossed updates
      engineA.applyUpdate(docA, updateB);
      engineB.applyUpdate(docB, updateA);

      expect(engineA.getTextContent(docA)).toBe(engineB.getTextContent(docB));
    } finally {
      engineA.destroy();
      engineB.destroy();
    }
  });
});

// ============================================================
// CRDT Engine — Full Snapshot
// ============================================================

describe("CrdtEngine — Full Snapshot", () => {
  let engine: CrdtEngine;

  beforeEach(() => {
    engine = new CrdtEngine();
  });

  afterEach(() => {
    engine.destroy();
  });

  it("should generate a full document snapshot", () => {
    const doc = engine.initDoc("doc-1", "test.md", "Snapshot content");
    const snapshot = engine.syncFullDoc(doc);
    expect(snapshot).toBeDefined();
    expect(snapshot.byteLength).toBeGreaterThan(0);
  });

  it("should restore content from a snapshot", () => {
    const doc = engine.initDoc("doc-1", "test.md", "Content to snapshot");
    const snapshot = engine.syncFullDoc(doc);

    // Create a new engine and apply the snapshot
    const engine2 = new CrdtEngine();
    try {
      const doc2 = engine2.initDoc("doc-1", "test.md");
      engine2.applyUpdate(doc2, snapshot);
      expect(engine2.getTextContent(doc2)).toBe("Content to snapshot");
    } finally {
      engine2.destroy();
    }
  });
});

// ============================================================
// CRDT Engine — Utility Methods
// ============================================================

describe("CrdtEngine — Utility Methods", () => {
  let engine: CrdtEngine;

  beforeEach(() => {
    engine = new CrdtEngine();
  });

  afterEach(() => {
    engine.destroy();
  });

  it("should get doc size", () => {
    const doc = engine.initDoc("doc-1", "test.md", "A");
    const size = engine.getDocSize(doc);
    expect(typeof size).toBe("number");
    expect(size).toBeGreaterThan(0);
  });

  it("should check CRDT support", () => {
    const supported = engine.isCrdtSupported();
    expect(supported).toBe(true);
  });

  it("should determine CRDT suitability for TEXT < 50MB", () => {
    const result = engine.shouldUseCrdt(FileCategory.TEXT, 1024);
    expect(result).toBe(true);
  });

  it("should reject BINARY files from CRDT", () => {
    const result = engine.shouldUseCrdt(FileCategory.BINARY, 1024);
    expect(result).toBe(false);
  });

  it("should reject large files (>50MB) from CRDT", () => {
    const result = engine.shouldUseCrdt(FileCategory.TEXT, 51 * 1024 * 1024);
    expect(result).toBe(false);
  });

  it("should get doc count", () => {
    expect(engine.getDocCount()).toBe(0);
    engine.initDoc("a", "a.md");
    engine.initDoc("b", "b.md");
    expect(engine.getDocCount()).toBe(2);
  });

  it("should list all doc IDs", () => {
    engine.initDoc("a", "a.md");
    engine.initDoc("b", "b.md");
    const ids = engine.getDocIds();
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids.length).toBe(2);
  });

  it("should get state for a document", () => {
    engine.initDoc("doc-1", "notes/test.md", "test");
    const state = engine.getState("doc-1");
    expect(state).toBeDefined();
    expect(state!.docId).toBe("doc-1");
    expect(state!.relativePath).toBe("notes/test.md");
  });

  it("should get all states", () => {
    engine.initDoc("a", "a.md", "hello");
    engine.initDoc("b", "b.md", "world");
    const states = engine.getAllStates();
    expect(states.length).toBe(2);
  });

  it("should destroy all docs on engine destroy", () => {
    engine.initDoc("a", "a.md");
    engine.initDoc("b", "b.md");
    engine.destroy();
    expect(engine.getDocCount()).toBe(0);
  });
});

// ============================================================
// CRDT Engine — GC
// ============================================================

describe("CrdtEngine — GC", () => {
  it("should trigger GC without error", () => {
    const engine = new CrdtEngine();
    const doc = engine.initDoc("doc-1", "test.md", "Content for GC");
    // GC should not throw
    expect(() => engine.gc(doc)).not.toThrow();
    engine.destroy();
  });
});
