// ============================================================
// Log Reader Tests — Sync History Viewer (Feature 1)
// ============================================================
// Covers ARCH §7 T05 / PRD: parseLine (various line shapes),
// timestamp parsing, deriveIcon mapping (via parseLine's icon),
// applyFilters / readWithFilter, and getStats aggregation.

import { describe, it, expect, beforeEach } from "vitest";
import { LogReader } from "../../src/log-reader";
import {
  LogLevel,
  SyncEventType,
  SyncHistoryEntry,
} from "../../src/types";

// Exact glyphs as returned by deriveIcon (verified against source codepoints).
const ICON_SUCCESS = "✅"; // U+2705
const ICON_WARN = "⚠️"; // U+26A0 U+FE0F
const ICON_SKIP = "⏭"; // U+23ED
const ICON_ERROR = "❌"; // U+274C
const ICON_INFO = "ℹ️"; // U+2139 U+FE0F

function makeEntry(over: Partial<SyncHistoryEntry>): SyncHistoryEntry {
  return {
    id: 0,
    timestamp: 0,
    level: LogLevel.INFO,
    message: "",
    filePath: undefined,
    eventType: SyncEventType.INFO,
    icon: ICON_INFO,
    expanded: false,
    ...over,
  };
}

describe("LogReader — parseLine", () => {
  let reader: LogReader;
  beforeEach(() => {
    reader = new LogReader();
  });

  it("parses a normal line with filePath + eventType", () => {
    const line =
      "[2026-06-30 14:30:00] [SUCCESS] file pushed (notes/diary.md) [FILE_PUSHED]";
    const entry = reader.parseLine(line);
    expect(entry).not.toBeNull();
    const e = entry as SyncHistoryEntry;
    expect(e.level).toBe(LogLevel.SUCCESS);
    expect(e.message).toBe("file pushed");
    expect(e.filePath).toBe("notes/diary.md");
    expect(e.eventType).toBe(SyncEventType.FILE_PUSHED);
    // 2026-06-30 14:30:00 local time
    expect(e.timestamp).toBe(new Date(2026, 5, 30, 14, 30, 0).getTime());
    expect(e.icon).toBe(ICON_SUCCESS);
  });

  it("parses a line WITHOUT filePath (e.g. SYNC_STARTED) → filePath undefined", () => {
    const line = "[2026-06-30 14:30:00] [INFO] sync started [SYNC_STARTED]";
    const e = reader.parseLine(line) as SyncHistoryEntry;
    expect(e.filePath).toBeUndefined();
    expect(e.eventType).toBe(SyncEventType.SYNC_STARTED);
    expect(e.icon).toBe(ICON_SKIP);
  });

  it("parses a line WITHOUT eventType → eventType falls back to INFO", () => {
    // NOTE: SyncHistoryEntry.eventType is a required (non-optional) field,
    // so the implementation falls back to SyncEventType.INFO rather than
    // undefined. This is type-safe behaviour, consistent with the type.
    const line = "[2026-06-30 14:30:00] [INFO] generic log line (notes/x.md)";
    const e = reader.parseLine(line) as SyncHistoryEntry;
    expect(e.eventType).toBe(SyncEventType.INFO);
    expect(e.filePath).toBe("notes/x.md");
    expect(e.icon).toBe(ICON_SKIP);
  });

  it("returns null (no throw) for malformed / unparseable lines", () => {
    const bad = ["", "not a log line", "2026-06-30 garbage no brackets", "[] []"];
    for (const b of bad) {
      expect(() => reader.parseLine(b)).not.toThrow();
      expect(reader.parseLine(b)).toBeNull();
    }
  });

  it("parses timestamp correctly and falls back to 0 on malformed input", () => {
    // Valid → non-zero epoch ms
    const ts = (reader as any).parseTimestamp("2026-06-30 14:30:00");
    expect(typeof ts).toBe("number");
    expect(ts).toBe(new Date(2026, 5, 30, 14, 30, 0).getTime());

    // Malformed (too few parts) → 0
    expect((reader as any).parseTimestamp("2026-06-30")).toBe(0);
    expect((reader as any).parseTimestamp("")).toBe(0);
    expect((reader as any).parseTimestamp(undefined)).toBe(0);
  });
});

describe("LogReader — deriveIcon mapping (via parseLine.icon)", () => {
  let reader: LogReader;
  beforeEach(() => {
    reader = new LogReader();
  });

  function iconFor(
    level: LogLevel,
    eventType: SyncEventType,
    filePath?: string,
  ): string {
    const line = filePath
      ? `[2026-06-30 14:30:00] [${level}] msg (${filePath}) [${eventType}]`
      : `[2026-06-30 14:30:00] [${level}] msg [${eventType}]`;
    return (reader.parseLine(line) as SyncHistoryEntry).icon;
  }

  it("SUCCESS / FILE_PUSHED / FILE_RECEIVED → ✅", () => {
    expect(iconFor(LogLevel.SUCCESS, SyncEventType.INFO)).toBe(ICON_SUCCESS);
    expect(iconFor(LogLevel.INFO, SyncEventType.FILE_PUSHED, "a.md")).toBe(
      ICON_SUCCESS,
    );
    expect(iconFor(LogLevel.INFO, SyncEventType.FILE_RECEIVED, "a.md")).toBe(
      ICON_SUCCESS,
    );
  });

  it("WARN / CONFLICT_DETECTED → ⚠️", () => {
    expect(iconFor(LogLevel.WARN, SyncEventType.INFO)).toBe(ICON_WARN);
    expect(iconFor(LogLevel.INFO, SyncEventType.CONFLICT_DETECTED, "a.md")).toBe(
      ICON_WARN,
    );
  });

  it("INFO / SYNC_STARTED → ⏭", () => {
    expect(iconFor(LogLevel.INFO, SyncEventType.INFO)).toBe(ICON_SKIP);
    expect(iconFor(LogLevel.INFO, SyncEventType.SYNC_STARTED)).toBe(ICON_SKIP);
  });

  it("ERROR / DISCONNECTED → ❌", () => {
    expect(iconFor(LogLevel.ERROR, SyncEventType.INFO, "a.md")).toBe(ICON_ERROR);
    expect(iconFor(LogLevel.INFO, SyncEventType.DISCONNECTED)).toBe(ICON_ERROR);
  });

  it("other (DEBUG level + INFO eventType) → ℹ️ fallback", () => {
    expect(iconFor(LogLevel.DEBUG, SyncEventType.INFO)).toBe(ICON_INFO);
  });
});

describe("LogReader — getStats", () => {
  let reader: LogReader;
  beforeEach(() => {
    reader = new LogReader();
  });

  it("classifies entries by icon and counts event types", () => {
    const entries: SyncHistoryEntry[] = [
      makeEntry({ icon: ICON_SUCCESS, eventType: SyncEventType.FILE_PUSHED }),
      makeEntry({ icon: ICON_SUCCESS, eventType: SyncEventType.FILE_RECEIVED }),
      makeEntry({ icon: ICON_SUCCESS, eventType: SyncEventType.CONNECTED }),
      makeEntry({ icon: ICON_WARN, eventType: SyncEventType.CONFLICT_DETECTED }),
      makeEntry({ icon: ICON_SKIP, eventType: SyncEventType.INFO }),
      makeEntry({ icon: ICON_ERROR, eventType: SyncEventType.ERROR }),
      makeEntry({ icon: ICON_INFO, eventType: SyncEventType.INFO }),
    ];

    const stats = reader.getStats(entries);
    expect(stats.totalEntries).toBe(7);
    expect(stats.successCount).toBe(3);
    expect(stats.warnCount).toBe(1);
    expect(stats.skipCount).toBe(1);
    expect(stats.errorCount).toBe(1);
    expect(stats.filePushCount).toBe(1);
    expect(stats.fileReceiveCount).toBe(1);
    expect(stats.conflictCount).toBe(1);
  });

  it("returns all-zero stats for an empty list", () => {
    const stats = reader.getStats([]);
    expect(stats.totalEntries).toBe(0);
    expect(stats.successCount).toBe(0);
    expect(stats.conflictCount).toBe(0);
  });
});

describe("LogReader — applyFilters / readWithFilter", () => {
  let reader: LogReader;
  beforeEach(() => {
    reader = new LogReader();
  });

  const SAMPLE: SyncHistoryEntry[] = [
    makeEntry({
      id: 1,
      timestamp: new Date(2026, 5, 30, 14, 30, 0).getTime(),
      level: LogLevel.SUCCESS,
      message: "pushed",
      filePath: "notes/diary.md",
      eventType: SyncEventType.FILE_PUSHED,
      icon: ICON_SUCCESS,
    }),
    makeEntry({
      id: 2,
      timestamp: new Date(2026, 5, 30, 9, 0, 0).getTime(),
      level: LogLevel.ERROR,
      message: "failed",
      filePath: "projects/todo.md",
      eventType: SyncEventType.ERROR,
      icon: ICON_ERROR,
    }),
    makeEntry({
      id: 3,
      timestamp: new Date(2026, 5, 29, 12, 0, 0).getTime(),
      level: LogLevel.INFO,
      message: "sync started",
      filePath: undefined,
      eventType: SyncEventType.SYNC_STARTED,
      icon: ICON_SKIP,
    }),
  ];

  it("filePathFilter does a case-insensitive substring match and excludes entries without a filePath", () => {
    // PRD: "过滤匹配文件路径的历史记录" — under an active path filter only
    // entries whose filePath matches should remain; entries with no filePath
    // (e.g. SYNC_STARTED) must be excluded, not leaked into search results.
    const r1 = reader.applyFilters(SAMPLE, { filePathFilter: "NOTES" });
    expect(r1.map((e) => e.id)).toEqual([1]); // only notes/diary.md

    const r2 = reader.applyFilters(SAMPLE, { filePathFilter: "md" });
    expect(r2.map((e) => e.id).sort()).toEqual([1, 2]); // both .md
  });

  it("time range from/to boundaries are inclusive", () => {
    const from = new Date(2026, 5, 30, 0, 0, 0).getTime();
    const to = new Date(2026, 5, 30, 23, 59, 59).getTime();
    const r = reader.applyFilters(SAMPLE, { fromTimestamp: from, toTimestamp: to });
    expect(r.map((e) => e.id).sort()).toEqual([1, 2]); // only 2026-06-30 entries

    // Exactly-on-boundary from should include the entry at that timestamp.
    const fromExact = new Date(2026, 5, 30, 14, 30, 0).getTime();
    const re = reader.applyFilters(SAMPLE, { fromTimestamp: fromExact });
    expect(re.map((e) => e.id)).toContain(1);
  });

  it("level and eventType filters narrow correctly", () => {
    const r1 = reader.applyFilters(SAMPLE, { levels: [LogLevel.ERROR] });
    expect(r1.map((e) => e.id)).toEqual([2]);

    const r2 = reader.applyFilters(SAMPLE, {
      eventTypes: [SyncEventType.FILE_PUSHED],
    });
    expect(r2.map((e) => e.id)).toEqual([1]);
  });

  it("readWithFilter delegates to applyFilters over the loaded entries (no throw)", async () => {
    // The dev machine has real sync logs, so we assert consistency with
    // applyFilters rather than assuming an empty result set.
    const all = await reader.readAll();
    const filtered = await reader.readWithFilter({
      filePathFilter: "zzz-no-such-path-xyz",
    });
    const rederived = reader.applyFilters(all, {
      filePathFilter: "zzz-no-such-path-xyz",
    });
    expect(Array.isArray(filtered)).toBe(true);
    expect(filtered.length).toBe(rederived.length);
  });
});

// ============================================================
// QA regression — applyFilters levels / eventTypes (Task A)
// Verifies the multi-select level + event type filtering surfaced by the
// sync-history filter bar routes correctly through LogReader.applyFilters:
//   ① single level → only that level
//   ② multiple levels → union
//   ③ eventType filter → correct subset (and union of eventTypes)
//   ④ levels/eventTypes undefined or [] → no restriction (return all)
// ============================================================

describe("LogReader — applyFilters levels/eventTypes (QA)", () => {
  let reader: LogReader;
  beforeEach(() => {
    reader = new LogReader();
  });

  // Fixture spanning every LogLevel and several SyncEventTypes so union /
  // intersection behaviour can be asserted precisely.
  const FIXTURE: SyncHistoryEntry[] = [
    makeEntry({ id: 1, level: LogLevel.SUCCESS, eventType: SyncEventType.FILE_PUSHED, filePath: "a.md" }),
    makeEntry({ id: 2, level: LogLevel.ERROR, eventType: SyncEventType.ERROR, filePath: "b.md" }),
    makeEntry({ id: 3, level: LogLevel.INFO, eventType: SyncEventType.SYNC_STARTED, filePath: undefined }),
    makeEntry({ id: 4, level: LogLevel.WARN, eventType: SyncEventType.CONFLICT_DETECTED, filePath: "c.md" }),
    makeEntry({ id: 5, level: LogLevel.DEBUG, eventType: SyncEventType.FILE_RECEIVED, filePath: "d.md" }),
    makeEntry({ id: 6, level: LogLevel.SUCCESS, eventType: SyncEventType.CONNECTED, filePath: undefined }),
  ];
  const ALL_IDS = [1, 2, 3, 4, 5, 6];

  it("① single level returns only that level (eventType ignored)", () => {
    const r = reader.applyFilters(FIXTURE, { levels: [LogLevel.SUCCESS] });
    expect(r.map((e) => e.id).sort()).toEqual([1, 6]); // both SUCCESS rows
  });

  it("② multiple levels return the union of those levels", () => {
    const r = reader.applyFilters(FIXTURE, {
      levels: [LogLevel.SUCCESS, LogLevel.ERROR],
    });
    expect(r.map((e) => e.id).sort()).toEqual([1, 2, 6]);
  });

  it("③ single eventType returns only matching events", () => {
    const r = reader.applyFilters(FIXTURE, {
      eventTypes: [SyncEventType.FILE_PUSHED],
    });
    expect(r.map((e) => e.id)).toEqual([1]);
  });

  it("③b multiple eventTypes return the union of those events", () => {
    const r = reader.applyFilters(FIXTURE, {
      eventTypes: [SyncEventType.FILE_PUSHED, SyncEventType.FILE_RECEIVED],
    });
    expect(r.map((e) => e.id).sort()).toEqual([1, 5]);
  });

  it("④ levels = undefined does NOT restrict (returns all)", () => {
    const r = reader.applyFilters(FIXTURE, { levels: undefined });
    expect(r.map((e) => e.id).sort()).toEqual(ALL_IDS);
  });

  it("④b levels = [] (empty) does NOT restrict (returns all)", () => {
    const r = reader.applyFilters(FIXTURE, { levels: [] });
    expect(r.map((e) => e.id).sort()).toEqual(ALL_IDS);
  });

  it("④c eventTypes = undefined does NOT restrict (returns all)", () => {
    const r = reader.applyFilters(FIXTURE, { eventTypes: undefined });
    expect(r.map((e) => e.id).sort()).toEqual(ALL_IDS);
  });

  it("④d eventTypes = [] (empty) does NOT restrict (returns all)", () => {
    const r = reader.applyFilters(FIXTURE, { eventTypes: [] });
    expect(r.map((e) => e.id).sort()).toEqual(ALL_IDS);
  });

  it("④e both omitted returns the full set", () => {
    const r = reader.applyFilters(FIXTURE, {});
    expect(r.map((e) => e.id).sort()).toEqual(ALL_IDS);
  });

  it("combined levels + eventTypes apply as AND (intersection)", () => {
    const r = reader.applyFilters(FIXTURE, {
      levels: [LogLevel.SUCCESS],
      eventTypes: [SyncEventType.FILE_PUSHED],
    });
    expect(r.map((e) => e.id)).toEqual([1]); // only id 1 is SUCCESS + FILE_PUSHED
  });
});
