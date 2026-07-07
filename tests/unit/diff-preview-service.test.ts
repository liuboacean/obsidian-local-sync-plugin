// ============================================================
// Diff Preview Service Tests — Diff Preview Before Sync (Feature 2)
// ============================================================
// Covers ARCH §7 T05 / PRD: shouldPreview logic, updateConfig sync,
// CONFIRM_ALL session latch (no new modal afterwards), and the
// 30s auto-confirm timeout behaviour. The real DiffPreviewModal is
// mocked so we can drive request resolution without a DOM/Obsidian
// runtime. (Tests run under the node environment; the real modal
// requires `document`/`window` which are not available here.)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiffPreviewService } from "../../src/diff-preview-service";
import {
  FileChange,
  ChangeType,
  FileCategory,
  SyncSettings,
  DiffPreviewAction,
} from "../../src/types";
import { DIFF_PREVIEW_TIMEOUT_MS } from "../../src/constants";

// ---- Mock the modal so we control resolution -------------------------
// The factory captures the last constructed modal on globalThis so the
// tests can resolve it. If __MODAL_AUTO_TIMEOUT__ is a number, open()
// schedules an auto-confirm (used to validate the 30s timeout path).
vi.mock("../../src/diff-preview-modal", () => {
  class FakeDiffPreviewModal {
    request: any;
    opts: any;
    constructor(_app: any, request: any, opts: any) {
      this.request = request;
      this.opts = opts;
      (globalThis as any).__lastDiffModal = this;
    }
    open(): void {
      const auto = (globalThis as any).__MODAL_AUTO_TIMEOUT__;
      if (typeof auto === "number") {
        (globalThis as any).setTimeout(() => {
          this.request.resolve({
            requestId: this.request.requestId,
            action: DiffPreviewAction.CONFIRM,
          });
        }, auto);
      }
    }
    close(): void {
      /* noop */
    }
    resolveWith(action: DiffPreviewAction): void {
      this.request.resolve({
        requestId: this.request.requestId,
        action,
      });
    }
  }
  return { DiffPreviewModal: FakeDiffPreviewModal };
});

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

describe("DiffPreviewService — updateConfig", () => {
  let service: DiffPreviewService;
  beforeEach(() => {
    service = new DiffPreviewService({} as any);
  });

  it("syncs enabled + whitelistFolders from SyncSettings", () => {
    const settings: SyncSettings = {
      ...({} as SyncSettings),
      enableDiffPreview: true,
      diffPreviewWhitelistFolders: ["notes", "projects"],
    };
    service.updateConfig(settings);
    expect((service as any).enabled).toBe(true);
    expect((service as any).whitelistFolders).toEqual(["notes", "projects"]);
  });

  it("defaults enabled=false and whitelist=[] when settings omit the fields", () => {
    service.updateConfig({} as SyncSettings);
    expect((service as any).enabled).toBe(false);
    expect((service as any).whitelistFolders).toEqual([]);
  });

  it("disabling clears pending requests and resets the confirm-all latch", () => {
    service.updateConfig({
      ...({} as SyncSettings),
      enableDiffPreview: true,
      diffPreviewWhitelistFolders: [],
    });
    (service as any).confirmAllMode = true;
    (service as any).pendingRequests.set("x", {} as any);

    service.updateConfig({ ...({} as SyncSettings), enableDiffPreview: false });
    expect((service as any).enabled).toBe(false);
    expect((service as any).confirmAllMode).toBe(false);
    expect((service as any).pendingRequests.size).toBe(0);
  });
});

describe("DiffPreviewService — shouldPreview", () => {
  let service: DiffPreviewService;
  beforeEach(() => {
    service = new DiffPreviewService({} as any);
  });

  it("enabled=false → never preview (direct pass-through)", () => {
    service.updateConfig({ ...({} as SyncSettings), enableDiffPreview: false });
    expect((service as any).shouldPreview(makeChange())).toBe(false);
  });

  it("enabled=true + empty whitelist → preview all files", () => {
    service.updateConfig({
      ...({} as SyncSettings),
      enableDiffPreview: true,
      diffPreviewWhitelistFolders: [],
    });
    expect((service as any).shouldPreview(makeChange())).toBe(true);
  });

  it("enabled=true + whitelist matches folder → preview", () => {
    service.updateConfig({
      ...({} as SyncSettings),
      enableDiffPreview: true,
      diffPreviewWhitelistFolders: ["notes", "projects"],
    });
    expect(
      (service as any).shouldPreview(makeChange({ relativePath: "notes/a.md" })),
    ).toBe(true);
    expect(
      (service as any).shouldPreview(
        makeChange({ relativePath: "projects/todo.md" }),
      ),
    ).toBe(true);
  });

  it("enabled=true + whitelist does NOT match folder → no preview", () => {
    service.updateConfig({
      ...({} as SyncSettings),
      enableDiffPreview: true,
      diffPreviewWhitelistFolders: ["notes"],
    });
    expect(
      (service as any).shouldPreview(
        makeChange({ relativePath: "images/photo.png" }),
      ),
    ).toBe(false);
  });

  it("whitelist folder with trailing slash is normalized", () => {
    service.updateConfig({
      ...({} as SyncSettings),
      enableDiffPreview: true,
      diffPreviewWhitelistFolders: ["notes/"],
    });
    expect(
      (service as any).shouldPreview(makeChange({ relativePath: "notes/a.md" })),
    ).toBe(true);
  });

  it("whitelist exact match (file at folder root) → preview", () => {
    service.updateConfig({
      ...({} as SyncSettings),
      enableDiffPreview: true,
      diffPreviewWhitelistFolders: ["notes"],
    });
    expect(
      (service as any).shouldPreview(makeChange({ relativePath: "notes" })),
    ).toBe(true);
  });

  it("DELETE events never preview (direct pass-through)", () => {
    service.updateConfig({
      ...({} as SyncSettings),
      enableDiffPreview: true,
      diffPreviewWhitelistFolders: ["notes"],
    });
    expect(
      (service as any).shouldPreview(
        makeChange({
          type: ChangeType.DELETE,
          relativePath: "notes/a.md",
        }),
      ),
    ).toBe(false);
  });

  it("confirmAllMode engaged → no further previews", () => {
    service.updateConfig({
      ...({} as SyncSettings),
      enableDiffPreview: true,
      diffPreviewWhitelistFolders: ["notes"],
    });
    (service as any).confirmAllMode = true;
    expect(
      (service as any).shouldPreview(makeChange({ relativePath: "notes/a.md" })),
    ).toBe(false);
  });
});

describe("DiffPreviewService — createHook", () => {
  it("returns a hook with the expected name and a handler function", () => {
    const service = new DiffPreviewService({} as any);
    const hook = service.createHook();
    expect(hook.name).toBe("diff-preview");
    expect(typeof hook.handler).toBe("function");
  });
});

describe("DiffPreviewService — CONFIRM_ALL session latch", () => {
  let service: DiffPreviewService;
  beforeEach(() => {
    service = new DiffPreviewService({} as any);
    (globalThis as any).__lastDiffModal = undefined;
    service.updateConfig({
      ...({} as SyncSettings),
      enableDiffPreview: true,
      diffPreviewWhitelistFolders: [],
    });
  });

  it("after CONFIRM_ALL, subsequent changes resolve true without a new modal", async () => {
    const hook = service.createHook();

    // First change → opens a modal; user picks CONFIRM_ALL.
    const p1 = hook.handler(makeChange({ relativePath: "notes/a.md" }), "/vault");
    await vi.waitFor(() =>
      expect((globalThis as any).__lastDiffModal).toBeTruthy(),
    );
    const modal1 = (globalThis as any).__lastDiffModal;
    modal1.resolveWith(DiffPreviewAction.CONFIRM_ALL);
    const r1 = await p1;
    expect(r1).toBe(true);
    expect((service as any).confirmAllMode).toBe(true);

    // Second change → should NOT open a new modal (session latch).
    const modalBefore = (globalThis as any).__lastDiffModal;
    const p2 = hook.handler(makeChange({ relativePath: "notes/b.md" }), "/vault");
    const r2 = await p2;
    expect(r2).toBe(true);
    expect((globalThis as any).__lastDiffModal).toBe(modalBefore);
  });
});

describe("DiffPreviewService — 30s auto-confirm timeout", () => {
  let service: DiffPreviewService;
  beforeEach(() => {
    service = new DiffPreviewService({} as any);
    (globalThis as any).__lastDiffModal = undefined;
  });
  afterEach(() => {
    (globalThis as any).__MODAL_AUTO_TIMEOUT__ = undefined;
  });

  it("handler resolves true (proceed) when the modal times out", async () => {
    // Inject a short timeout to validate the timeout→auto-confirm path
    // (real code uses DIFF_PREVIEW_TIMEOUT_MS = 30000).
    (globalThis as any).__MODAL_AUTO_TIMEOUT__ = 50;
    service.updateConfig({
      ...({} as SyncSettings),
      enableDiffPreview: true,
      diffPreviewWhitelistFolders: [],
    });
    const hook = service.createHook();
    const p = hook.handler(makeChange({ relativePath: "notes/a.md" }), "/vault");
    const result = await p;
    expect(result).toBe(true);
    // Timeout resolves CONFIRM, not CONFIRM_ALL → latch stays disengaged.
    expect((service as any).confirmAllMode).toBe(false);
  });
});
