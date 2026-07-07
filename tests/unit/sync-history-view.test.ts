// ============================================================
// Sync History View Tests — Sync History Viewer (Feature 1)
// ============================================================
// Covers ARCH §7 T05 / PRD: render does not throw, filter logic is
// consistent with LogReader.applyFilters, statistics recompute, CSV
// export format (header + escaping) and pagination maths.
//
// The view relies on Obsidian's augmented HTMLElement (createEl /
// createDiv / createSpan ...). Those methods are not available in the
// node test environment, so we provide a minimal FakeEl that mimics the
// subset the view uses. (Tests run under the node environment.)

import { describe, it, expect, beforeEach } from "vitest";
import { SyncHistoryView } from "../../src/sync-history-view";
import { LogReader } from "../../src/log-reader";
import {
  LogLevel,
  SyncEventType,
  SyncHistoryEntry,
} from "../../src/types";

// ---- Minimal fake DOM element -----------------------------------------
class FakeEl {
  tagName: string;
  cls = "";
  textContent = "";
  value = "";
  children: FakeEl[] = [];
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<(evt?: any) => void>> = {};
  style: Record<string, any> = {};

  constructor(tagName = "div") {
    this.tagName = tagName;
  }

  empty(): void {
    this.children = [];
    this.textContent = "";
  }

  createEl(tagOrOpts: any, opts?: any): FakeEl {
    const tag =
      typeof tagOrOpts === "string" ? tagOrOpts : tagOrOpts?.type ?? "div";
    const o = typeof tagOrOpts === "string" ? opts : tagOrOpts;
    const el = new FakeEl(tag);
    if (o?.text !== undefined) el.textContent = o.text;
    if (o?.cls) el.cls = o.cls;
    this.children.push(el);
    return el;
  }

  createDiv(opts?: any): FakeEl {
    const el = new FakeEl("div");
    if (opts?.cls) el.cls = opts.cls;
    this.children.push(el);
    return el;
  }

  createSpan(opts?: any): FakeEl {
    const el = new FakeEl("span");
    if (opts?.text !== undefined) el.textContent = opts.text;
    if (opts?.cls) el.cls = opts.cls;
    this.children.push(el);
    return el;
  }

  addEventListener(evt: string, cb: (evt?: any) => void): void {
    (this.listeners[evt] ||= []).push(cb);
  }

  setAttribute(k: string, v: string): void {
    this.attributes[k] = v;
  }

  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }

  remove(): void {
    /* noop */
  }

  click(evt?: any): void {
    (this.listeners["click"] || []).forEach((cb) =>
      cb(evt ?? { stopPropagation() {} }),
    );
  }

  findByCls(cls: string): FakeEl | null {
    if (this.cls === cls) return this;
    for (const c of this.children) {
      const found = c.findByCls(cls);
      if (found) return found;
    }
    return null;
  }

  findByText(text: string | RegExp): FakeEl | null {
    const match = (s: string) =>
      text instanceof RegExp ? text.test(s) : s === text;
    if (match(this.textContent)) return this;
    for (const c of this.children) {
      const found = c.findByText(text);
      if (found) return found;
    }
    return null;
  }
}

function sampleEntries(): SyncHistoryEntry[] {
  const mk = (id: number, path: string, level: LogLevel, et: SyncEventType) =>
    ({
      id,
      timestamp: new Date(2026, 5, 30, 10 + id, 0, 0).getTime(),
      level,
      message: `change ${id}`,
      filePath: path,
      eventType: et,
      icon: "✅",
      expanded: false,
    }) as SyncHistoryEntry;
  return [
    mk(1, "notes/diary.md", LogLevel.SUCCESS, SyncEventType.FILE_PUSHED),
    mk(2, "notes/todo.md", LogLevel.SUCCESS, SyncEventType.FILE_PUSHED),
    mk(3, "images/photo.png", LogLevel.ERROR, SyncEventType.ERROR),
  ];
}

describe("SyncHistoryView — render", () => {
  let view: SyncHistoryView;
  let container: FakeEl;

  beforeEach(() => {
    view = new SyncHistoryView();
    container = new FakeEl("div");
  });

  it("renders the panel without throwing when no log files exist", async () => {
    await expect(
      view.render(container as unknown as HTMLElement, {} as any),
    ).resolves.not.toThrow();
    // Heading + stats + filters + toolbar + list sections were created.
    expect(container.findByText("📜 同步历史")).not.toBeNull();
    expect(container.findByCls("local-sync-history-stats")).not.toBeNull();
    expect(container.findByCls("local-sync-history-filters")).not.toBeNull();
    expect(container.findByCls("local-sync-history-toolbar")).not.toBeNull();
    expect(container.findByCls("local-sync-history-list")).not.toBeNull();
  });

  it("shows the empty-state message when the filtered list is empty", async () => {
    await view.render(container as unknown as HTMLElement, {} as any);
    // Force an empty data set (hermetic — the dev machine may have real logs).
    (view as any).allEntries = [];
    (view as any).filters = {};
    (view as any).recomputeAndRender();
    expect(container.findByText(/暂无同步记录/)).not.toBeNull();
  });
});

describe("SyncHistoryView — filtering & stats", () => {
  let view: SyncHistoryView;
  let container: FakeEl;

  beforeEach(async () => {
    view = new SyncHistoryView();
    container = new FakeEl("div");
    await view.render(container as unknown as HTMLElement, {} as any);
    // Inject sample data directly (render loaded [] since no log files).
    (view as any).allEntries = sampleEntries();
  });

  it("applies filePath filter consistently with LogReader.applyFilters", () => {
    (view as any).filters = { filePathFilter: "notes" };
    (view as any).recomputeAndRender();

    const expected = new LogReader().applyFilters((view as any).allEntries, {
      filePathFilter: "notes",
    });
    const filtered = (view as any).filteredEntries as SyncHistoryEntry[];
    expect(filtered.map((e: SyncHistoryEntry) => e.id).sort()).toEqual(
      expected.map((e) => e.id).sort(),
    );
    expect(filtered.length).toBe(2);
  });

  it("applies time-range filter consistently with LogReader.applyFilters", () => {
    const from = new Date(2026, 5, 30, 12, 0, 0).getTime();
    (view as any).filters = { fromTimestamp: from };
    (view as any).recomputeAndRender();
    const expected = new LogReader().applyFilters((view as any).allEntries, {
      fromTimestamp: from,
    });
    const filtered = (view as any).filteredEntries as SyncHistoryEntry[];
    expect(filtered.map((e: SyncHistoryEntry) => e.id).sort()).toEqual(
      expected.map((e) => e.id).sort(),
    );
  });
});

describe("SyncHistoryView — CSV export", () => {
  let view: SyncHistoryView;
  let container: FakeEl;

  beforeEach(async () => {
    view = new SyncHistoryView();
    container = new FakeEl("div");
    await view.render(container as unknown as HTMLElement, {} as any);
    const entries = sampleEntries();
    // Add a comma to exercise CSV escaping.
    entries[0] = { ...entries[0], message: "hello, world" };
    (view as any).allEntries = entries;
    (view as any).filters = {};
    (view as any).recomputeAndRender();
  });

  it("builds CSV with the correct header and field order", () => {
    const csv = (view as any).buildCsv() as string;
    const header = csv.split("\n")[0];
    expect(header).toBe("timestamp,level,message,filePath,eventType");
  });

  it("escapes commas by wrapping the field in double quotes", () => {
    const csv = (view as any).buildCsv() as string;
    expect(csv).toContain('"hello, world"');
  });

  it("csvEscape quotes fields containing comma / quote / newline", () => {
    expect((view as any).csvEscape("a,b")).toBe('"a,b"');
    expect((view as any).csvEscape('she said "hi"')).toBe('"she said ""hi"""');
    expect((view as any).csvEscape("plain")).toBe("plain");
    expect((view as any).csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("SyncHistoryView — pagination", () => {
  let view: SyncHistoryView;
  let container: FakeEl;

  function makeEntries(n: number): SyncHistoryEntry[] {
    return Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      timestamp: new Date(2026, 5, 30, 10, 0, 0).getTime() + i,
      level: LogLevel.SUCCESS,
      message: `m${i}`,
      filePath: `f${i}.md`,
      eventType: SyncEventType.FILE_PUSHED,
      icon: "✅",
      expanded: false,
    }));
  }

  beforeEach(async () => {
    view = new SyncHistoryView();
    container = new FakeEl("div");
    await view.render(container as unknown as HTMLElement, {} as any);
    (view as any).allEntries = makeEntries(120);
    (view as any).filters = {};
    (view as any).recomputeAndRender();
  });

  it("uses a 50-row page size and computes 3 pages for 120 entries", () => {
    expect((view as any).pageSize).toBe(50);
    expect((view as any).filteredEntries.length).toBe(120);
    expect((view as any).currentPage).toBe(0);
  });

  it("advances and clamps the current page via the next-button handler", () => {
    const next = container.findByText("下一页");
    expect(next).not.toBeNull();

    next!.click();
    expect((view as any).currentPage).toBe(1);
    next!.click();
    expect((view as any).currentPage).toBe(2);
    // Already on the last page → stays clamped.
    next!.click();
    expect((view as any).currentPage).toBe(2);
  });
});
