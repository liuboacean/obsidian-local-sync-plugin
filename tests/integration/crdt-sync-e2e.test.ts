// ============================================================
// CRDT E2E Integration Tests
// ============================================================
// Validates Yjs CRDT convergence under various concurrent edit scenarios.
// These are the most critical tests for data integrity.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { CrdtEngine } from "../../src/crdt-engine";
import { generateDocId } from "../../src/utils";

// ============================================================
// Helpers
// ============================================================

class CrdtPeer {
  engine: CrdtEngine;
  name: string;

  constructor(name: string) {
    this.engine = new CrdtEngine();
    this.name = name;
  }

  initDoc(docId: string, relativePath: string, content?: string): Y.Doc {
    return this.engine.initDoc(docId, relativePath, content);
  }

  getDoc(docId: string): Y.Doc | undefined {
    return this.engine.getDoc(docId);
  }

  getText(docId: string): string {
    const doc = this.engine.getDoc(docId);
    if (!doc) return "";
    return this.engine.getTextContent(doc);
  }

  setText(docId: string, content: string): void {
    const doc = this.engine.getDoc(docId);
    if (doc) {
      this.engine.setTextContent(doc, content);
    }
  }

  destroy(): void {
    this.engine.destroy();
  }
}

function syncPeers(peers: CrdtPeer[], docId: string): void {
  // Gather all updates
  const allUpdates: Uint8Array[] = [];
  for (const peer of peers) {
    const doc = peer.getDoc(docId);
    if (doc) {
      allUpdates.push(peer.engine.generateUpdate(doc));
    }
  }

  // Apply all updates to all peers
  for (const peer of peers) {
    const doc = peer.getDoc(docId);
    if (doc) {
      for (const update of allUpdates) {
        // Skip own update
        const ownUpdate = peer.engine.generateUpdate(doc);
        if (Buffer.from(update).equals(Buffer.from(ownUpdate))) {
          continue;
        }
        peer.engine.applyUpdate(doc, update);
      }
    }
  }
}

// ============================================================
// Basic CRDT Tests
// ============================================================

describe("CRDT E2E — Basic Operations", () => {
  let peerA: CrdtPeer;
  let peerB: CrdtPeer;
  const docId = "test-doc-1";

  beforeEach(() => {
    peerA = new CrdtPeer("A");
    peerB = new CrdtPeer("B");
  });

  afterEach(() => {
    peerA.destroy();
    peerB.destroy();
  });

  it("two peers should converge after sync", () => {
    peerA.initDoc(docId, "test.md", "Hello World");
    peerB.initDoc(docId, "test.md", "Hello World");
    syncPeers([peerA, peerB], docId);
    expect(peerA.getText(docId)).toBe(peerB.getText(docId));
  });
});

// ============================================================
// Concurrent Edit — Same Position
// ============================================================

describe("CRDT E2E — Concurrent Insert at Same Position", () => {
  let peerA: CrdtPeer;
  let peerB: CrdtPeer;
  const docId = "concurrent-same-pos";

  beforeEach(() => {
    peerA = new CrdtPeer("A");
    peerB = new CrdtPeer("B");
    peerA.initDoc(docId, "test.md", "Hello World");
    peerB.initDoc(docId, "test.md", "Hello World");
  });

  afterEach(() => {
    peerA.destroy();
    peerB.destroy();
  });

  it("should converge when both insert at the same position", () => {
    // A inserts at position 6
    const docA = peerA.getDoc(docId)!;
    docA.transact(() => {
      const ytext = docA.getText("content");
      ytext.insert(6, " CRDT");
    });

    // B inserts at the same position 6
    const docB = peerB.getDoc(docId)!;
    docB.transact(() => {
      const ytext = docB.getText("content");
      ytext.insert(6, " Awesome");
    });

    syncPeers([peerA, peerB], docId);

    // Both converge to the same content
    expect(peerA.getText(docId)).toBe(peerB.getText(docId));
  });

  it("should converge when A inserts and B deletes at same position", () => {
    const docA = peerA.getDoc(docId)!;
    docA.transact(() => {
      const ytext = docA.getText("content");
      ytext.insert(6, " CRDT");
    });

    const docB = peerB.getDoc(docId)!;
    docB.transact(() => {
      const ytext = docB.getText("content");
      ytext.delete(6, 5); // Delete "World"
    });

    syncPeers([peerA, peerB], docId);

    expect(peerA.getText(docId)).toBe(peerB.getText(docId));
  });
});

// ============================================================
// Concurrent Edit — Different Positions
// ============================================================

describe("CRDT E2E — Concurrent Insert at Different Positions", () => {
  let peerA: CrdtPeer;
  let peerB: CrdtPeer;
  const docId = "concurrent-diff-pos";

  beforeEach(() => {
    peerA = new CrdtPeer("A");
    peerB = new CrdtPeer("B");
    peerA.initDoc(docId, "test.md", "Hello World");
    peerB.initDoc(docId, "test.md", "Hello World");
  });

  afterEach(() => {
    peerA.destroy();
    peerB.destroy();
  });

  it("should merge inserts at different positions", () => {
    const docA = peerA.getDoc(docId)!;
    docA.transact(() => {
      const ytext = docA.getText("content");
      ytext.insert(0, "[A] "); // At start
    });

    const docB = peerB.getDoc(docId)!;
    docB.transact(() => {
      const ytext = docB.getText("content");
      ytext.insert(11, " [B]"); // At end
    });

    syncPeers([peerA, peerB], docId);

    expect(peerA.getText(docId)).toBe(peerB.getText(docId));
  });
});

// ============================================================
// Three-Way Merge
// ============================================================

describe("CRDT E2E — Three-Way Merge", () => {
  let peerA: CrdtPeer;
  let peerB: CrdtPeer;
  let peerC: CrdtPeer;
  const docId = "three-way";

  beforeEach(() => {
    peerA = new CrdtPeer("A");
    peerB = new CrdtPeer("B");
    peerC = new CrdtPeer("C");
  });

  afterEach(() => {
    peerA.destroy();
    peerB.destroy();
    peerC.destroy();
  });

  it("three peers should converge after concurrent edits", () => {
    const baseContent = "Line 1\nLine 2\nLine 3";
    peerA.initDoc(docId, "three.md", baseContent);
    peerB.initDoc(docId, "three.md", baseContent);
    peerC.initDoc(docId, "three.md", baseContent);

    // Each peer edits a different line
    const docA = peerA.getDoc(docId)!;
    docA.transact(() => {
      const ytext = docA.getText("content");
      ytext.delete(0, 6);
      ytext.insert(0, "Line A");
    });

    const docB = peerB.getDoc(docId)!;
    docB.transact(() => {
      const ytext = docB.getText("content");
      ytext.delete(7, 6);
      ytext.insert(7, "Line B");
    });

    const docC = peerC.getDoc(docId)!;
    docC.transact(() => {
      const ytext = docC.getText("content");
      ytext.delete(14, 6);
      ytext.insert(14, "Line C");
    });

    syncPeers([peerA, peerB, peerC], docId);

    const contentA = peerA.getText(docId);
    const contentB = peerB.getText(docId);
    const contentC = peerC.getText(docId);

    expect(contentA).toBe(contentB);
    expect(contentB).toBe(contentC);
  });
});

// ============================================================
// Disconnect and Reconnect
// ============================================================

describe("CRDT E2E — Disconnect and Reconnect", () => {
  it("should restore state after simulated disconnect", () => {
    const peerA = new CrdtPeer("A");
    const peerB = new CrdtPeer("B");
    const docId = "reconnect-test";

    // Phase 1: Initial sync
    peerA.initDoc(docId, "notes/doc.md", "Version 1");
    peerB.initDoc(docId, "notes/doc.md", "Version 1");
    syncPeers([peerA, peerB], docId);

    // Phase 2: A makes changes while B is "offline"
    const docA = peerA.getDoc(docId)!;
    docA.transact(() => {
      const ytext = docA.getText("content");
      ytext.insert(9, " edited by A");
    });
    const updateA = peerA.engine.generateUpdate(docA);

    // Phase 3: B makes changes while A is "offline"
    const docB = peerB.getDoc(docId)!;
    docB.transact(() => {
      const ytext = docB.getText("content");
      ytext.insert(9, " edited by B");
    });
    const updateB = peerB.engine.generateUpdate(docB);

    // Phase 4: Reconnection — apply accumulated updates
    peerA.engine.applyUpdate(docA, updateB);
    peerB.engine.applyUpdate(docB, updateA);

    const contentA = peerA.getText(docId);
    const contentB = peerB.getText(docId);
    expect(contentA).toBe(contentB);

    peerA.destroy();
    peerB.destroy();
  });
});
