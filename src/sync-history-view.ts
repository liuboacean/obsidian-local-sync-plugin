// ============================================================
// Sync History View — Sync History Viewer (Feature 1)
// ============================================================
// Renders the "同步历史" panel (settings section 7): a statistics
// card, a filter bar (file path / time range / quick ranges), a
// paginated list (50 rows/page), expandable detail rows, and CSV
// export (copy to clipboard + save to file).
//
// Reads log data asynchronously via LogReader; the UI is rebuilt in
// place so filter inputs keep focus while typing.

import { Notice } from "obsidian";
import type ObsidianLocalSyncPlugin from "./main";
import { LogReader } from "./log-reader";
import {
  LogLevel,
  SyncEventType,
  SyncHistoryEntry,
  SyncHistoryFilters,
  SyncHistoryStats,
} from "./types";
import { SYNC_HISTORY_PAGE_SIZE } from "./constants";
import { formatTime } from "./utils";

// ============================================================
// Log level / event type → Chinese labels (display only; enum values unchanged)
// ============================================================
const LEVEL_LABELS: Record<string, string> = {
  DEBUG: "调试",
  INFO: "信息",
  SUCCESS: "成功",
  WARN: "警告",
  ERROR: "错误",
};
const EVENT_LABELS: Record<string, string> = {
  INFO: "信息",
  FILE_PUSHED: "文件已推送",
  FILE_RECEIVED: "文件已接收",
  CONFLICT_DETECTED: "检测到冲突",
  CONFLICT_RESOLVED: "冲突已解决",
  CONNECTED: "已连接",
  DISCONNECTED: "已断开",
  SYNC_STARTED: "同步开始",
  SYNC_COMPLETED: "同步完成",
  ERROR: "错误",
  DEVICE_DISCOVERED: "发现设备",
  DEVICE_LOST: "设备丢失",
  CRDT_MERGED: "CRDT 已合并",
};
function translateLevel(level: string): string {
  return LEVEL_LABELS[level] ?? level;
}
function translateEvent(event: string): string {
  return EVENT_LABELS[event] ?? event;
}


// ============================================================
// View Class
// ============================================================

export class SyncHistoryView {
  private readonly pageSize: number = SYNC_HISTORY_PAGE_SIZE;
  private currentPage = 0;
  private allEntries: SyncHistoryEntry[] = [];
  private filteredEntries: SyncHistoryEntry[] = [];
  private filters: SyncHistoryFilters = {};
  private readonly logReader = new LogReader();

  /** Cached sub-containers for in-place re-render. */
  private statsEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private filterBarEl: HTMLElement | null = null;
  private toolbarEl: HTMLElement | null = null;

  // ============================================================
  // Entry point
  // ============================================================

  /**
   * Render the full panel into containerEl. Lazily loads log data.
   */
  async render(
    containerEl: HTMLElement,
    _plugin: ObsidianLocalSyncPlugin,
  ): Promise<void> {
    containerEl.empty();
    containerEl.createEl("h3", {
      text: "📜 同步历史",
      cls: "local-sync-history-heading",
    });

    const loading = containerEl.createEl("p", {
      text: "正在加载同步历史...",
      cls: "setting-item-description",
    });

    try {
      this.allEntries = await this.logReader.readAll();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      containerEl.empty();
      containerEl.createEl("p", {
        text: `加载同步历史失败：${message}`,
      });
      return;
    }

    containerEl.empty();
    containerEl.createEl("h3", {
      text: "📜 同步历史",
      cls: "local-sync-history-heading",
    });

    this.statsEl = containerEl.createDiv({ cls: "local-sync-history-stats" });
    this.filterBarEl = containerEl.createDiv({
      cls: "local-sync-history-filters",
    });
    this.toolbarEl = containerEl.createDiv({
      cls: "local-sync-history-toolbar",
    });
    this.listEl = containerEl.createDiv({ cls: "local-sync-history-list" });

    loading.remove();
    this.buildFilterBar();
    this.buildToolbar();
    this.recomputeAndRender();
  }

  // ============================================================
  // Recompute + render list/stats
  // ============================================================

  private recomputeAndRender(): void {
    this.filteredEntries = this.logReader.applyFilters(
      this.allEntries,
      this.filters,
    );

    const totalPages = Math.max(
      1,
      Math.ceil(this.filteredEntries.length / this.pageSize),
    );
    if (this.currentPage >= totalPages) {
      this.currentPage = totalPages - 1;
    }
    if (this.currentPage < 0) {
      this.currentPage = 0;
    }

    this.renderStats();
    this.renderList();
  }

  // ============================================================
  // Statistics card
  // ============================================================

  private renderStats(): void {
    if (!this.statsEl) {
      return;
    }
    const stats: SyncHistoryStats = this.logReader.getStats(
      this.filteredEntries,
    );
    this.statsEl.empty();

    const cards: Array<{ label: string; value: number; cls: string }> = [
      { label: "总记录", value: stats.totalEntries, cls: "total" },
      { label: "✅ 成功", value: stats.successCount, cls: "success" },
      { label: "⚠️ 警告", value: stats.warnCount, cls: "warn" },
      { label: "⏭ 跳过", value: stats.skipCount, cls: "skip" },
      { label: "❌ 错误", value: stats.errorCount, cls: "error" },
      { label: "🔁 冲突", value: stats.conflictCount, cls: "conflict" },
    ];

    for (const card of cards) {
      const el = this.statsEl.createDiv({
        cls: `local-sync-stat-card stat-${card.cls}`,
      });
      el.createEl("div", { text: String(card.value), cls: "stat-value" });
      el.createEl("div", { text: card.label, cls: "stat-label" });
    }
  }

  // ============================================================
  // Filter bar
  // ============================================================

  private buildFilterBar(): void {
    if (!this.filterBarEl) {
      return;
    }
    const bar = this.filterBarEl;
    bar.empty();

    // File path keyword
    const pathSetting = bar.createDiv({ cls: "local-sync-filter-row" });
    pathSetting.createEl("span", { text: "文件路径: " });
    const pathInput = pathSetting.createEl("input", {
      type: "text",
      placeholder: "搜索文件路径关键词",
      cls: "local-sync-filter-input",
    });
    pathInput.addEventListener("input", () => {
      this.filters.filePathFilter = pathInput.value;
      this.currentPage = 0;
      this.recomputeAndRender();
    });

    // From date
    const fromSetting = bar.createDiv({ cls: "local-sync-filter-row" });
    fromSetting.createEl("span", { text: "从: " });
    const fromInput = fromSetting.createEl("input", {
      type: "text",
      placeholder: "2026-06-30",
      cls: "local-sync-filter-input local-sync-filter-date",
    });
    fromInput.addEventListener("input", () => {
      this.filters.fromTimestamp = this.parseDateStart(fromInput.value);
      this.currentPage = 0;
      this.recomputeAndRender();
    });

    // To date
    const toSetting = bar.createDiv({ cls: "local-sync-filter-row" });
    toSetting.createEl("span", { text: "至: " });
    const toInput = toSetting.createEl("input", {
      type: "text",
      placeholder: "2026-06-30",
      cls: "local-sync-filter-input local-sync-filter-date",
    });
    toInput.addEventListener("input", () => {
      this.filters.toTimestamp = this.parseDateEnd(toInput.value);
      this.currentPage = 0;
      this.recomputeAndRender();
    });

    // Level filter (multi-select checkboxes → this.filters.levels)
    const levelRow = bar.createDiv({ cls: "local-sync-filter-row" });
    levelRow.createEl("span", { text: "级别: " });
    const levelOrder = Object.values(LogLevel);
    const levelCheckboxes: HTMLInputElement[] = [];
    for (const level of levelOrder) {
      const wrapper = levelRow.createEl("label", {
        cls: "local-sync-filter-check",
      });
      const cb = wrapper.createEl("input", { type: "checkbox" });
      wrapper.createSpan({ text: translateLevel(level) });
      levelCheckboxes.push(cb);
    }
    const updateLevelFilter = (): void => {
      const selected = levelOrder.filter(
        (_lv, idx) => levelCheckboxes[idx].checked,
      );
      this.filters.levels = selected.length > 0 ? selected : undefined;
      this.currentPage = 0;
      this.recomputeAndRender();
    };
    levelCheckboxes.forEach((cb) => {
      cb.addEventListener("change", updateLevelFilter);
    });

    // Event type filter (multi-select checkboxes → this.filters.eventTypes)
    const eventRow = bar.createDiv({ cls: "local-sync-filter-row" });
    eventRow.createEl("span", { text: "事件类型: " });
    const eventOrder = Object.values(SyncEventType);
    const eventCheckboxes: HTMLInputElement[] = [];
    for (const event of eventOrder) {
      const wrapper = eventRow.createEl("label", {
        cls: "local-sync-filter-check",
      });
      const cb = wrapper.createEl("input", { type: "checkbox" });
      wrapper.createSpan({ text: translateEvent(event) });
      eventCheckboxes.push(cb);
    }
    const updateEventFilter = (): void => {
      const selected = eventOrder.filter(
        (_ev, idx) => eventCheckboxes[idx].checked,
      );
      this.filters.eventTypes = selected.length > 0 ? selected : undefined;
      this.currentPage = 0;
      this.recomputeAndRender();
    };
    eventCheckboxes.forEach((cb) => {
      cb.addEventListener("change", updateEventFilter);
    });

    // Quick range buttons
    const quickRow = bar.createDiv({ cls: "local-sync-filter-row" });
    const todayBtn = quickRow.createEl("button", {
      text: "今天",
      cls: "local-sync-filter-btn",
    });
    todayBtn.addEventListener("click", () => {
      const now = Date.now();
      const start = this.startOfDay(now);
      this.filters.fromTimestamp = start;
      this.filters.toTimestamp = now;
      fromInput.value = this.toDateInput(start);
      toInput.value = this.toDateInput(now);
      this.currentPage = 0;
      this.recomputeAndRender();
    });

    const weekBtn = quickRow.createEl("button", {
      text: "7天",
      cls: "local-sync-filter-btn",
    });
    weekBtn.addEventListener("click", () => {
      const now = Date.now();
      const from = now - 7 * 24 * 60 * 60 * 1000;
      this.filters.fromTimestamp = from;
      this.filters.toTimestamp = now;
      fromInput.value = this.toDateInput(from);
      toInput.value = this.toDateInput(now);
      this.currentPage = 0;
      this.recomputeAndRender();
    });

    const clearBtn = quickRow.createEl("button", {
      text: "清除筛选",
      cls: "local-sync-filter-btn",
    });
    clearBtn.addEventListener("click", () => {
      this.filters = {};
      fromInput.value = "";
      toInput.value = "";
      pathInput.value = "";
      levelCheckboxes.forEach((cb) => (cb.checked = false));
      eventCheckboxes.forEach((cb) => (cb.checked = false));
      this.currentPage = 0;
      this.recomputeAndRender();
    });
  }

  // ============================================================
  // Toolbar (refresh + export)
  // ============================================================

  private buildToolbar(): void {
    if (!this.toolbarEl) {
      return;
    }
    const bar = this.toolbarEl;
    bar.empty();

    const refreshBtn = bar.createEl("button", {
      text: "🔄 刷新",
      cls: "local-sync-filter-btn",
    });
    refreshBtn.addEventListener("click", () => {
      void this.reload();
    });

    const copyBtn = bar.createEl("button", {
      text: "📋 复制 CSV",
      cls: "local-sync-filter-btn",
    });
    copyBtn.addEventListener("click", () => {
      void this.copyCsv();
    });

    const saveBtn = bar.createEl("button", {
      text: "💾 另存为文件",
      cls: "local-sync-filter-btn",
    });
    saveBtn.addEventListener("click", () => {
      this.saveCsv();
    });
  }

  private async reload(): Promise<void> {
    try {
      this.allEntries = await this.logReader.readAll();
      this.recomputeAndRender();
      new Notice("同步历史已刷新");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`刷新失败：${message}`);
    }
  }

  // ============================================================
  // List
  // ============================================================

  private renderList(): void {
    if (!this.listEl) {
      return;
    }
    const listEl = this.listEl;
    listEl.empty();

    if (this.filteredEntries.length === 0) {
      listEl.createEl("p", {
        text: "暂无同步记录。同步活动会写入 ~/.obsidian-sync/logs/sync.log。",
        cls: "setting-item-description",
      });
      return;
    }

    const startIdx = this.currentPage * this.pageSize;
    const endIdx = Math.min(
      startIdx + this.pageSize,
      this.filteredEntries.length,
    );
    const pageEntries = this.filteredEntries.slice(startIdx, endIdx);

    for (const entry of pageEntries) {
      this.renderEntryRow(listEl, entry);
    }

    this.renderPagination(listEl);
  }

  private renderEntryRow(
    containerEl: HTMLElement,
    entry: SyncHistoryEntry,
  ): void {
    const row = containerEl.createDiv({
      cls: "local-sync-history-row",
    });
    row.setAttribute("data-entry-id", String(entry.id));

    const summary = row.createDiv({ cls: "local-sync-history-summary" });
    summary.createSpan({ text: `${entry.icon} `, cls: "row-icon" });
    summary.createSpan({
      text: `[${formatTime(entry.timestamp)}] `,
      cls: "row-time",
    });
    summary.createSpan({
      text: `[${translateLevel(entry.level)}] `,
      cls: "row-level",
    });
    summary.createSpan({ text: entry.message, cls: "row-message" });
    if (entry.filePath) {
      summary.createSpan({
        text: ` (${entry.filePath})`,
        cls: "row-path",
      });
    }

    // Expand on click
    summary.addEventListener("click", () => {
      entry.expanded = !entry.expanded;
      this.renderList();
    });

    if (entry.expanded) {
      const detail = row.createDiv({ cls: "local-sync-history-detail" });
      detail.createEl("div", {
        text: `事件类型: ${translateEvent(entry.eventType)}`,
        cls: "setting-item-description",
      });
      detail.createEl("div", {
        text: `完整消息: ${entry.message}`,
        cls: "setting-item-description",
      });
      const raw = this.toRawLine(entry);
      detail.createEl("pre", {
        text: raw,
        cls: "local-sync-history-raw",
      });

      const copyRaw = detail.createEl("button", {
        text: "复制原始日志行",
        cls: "local-sync-filter-btn",
      });
      copyRaw.addEventListener("click", (evt: MouseEvent) => {
        evt.stopPropagation();
        void this.copyText(raw, "已复制原始日志行");
      });
    }
  }

  // ============================================================
  // Pagination
  // ============================================================

  private renderPagination(containerEl: HTMLElement): void {
    const totalPages = Math.max(
      1,
      Math.ceil(this.filteredEntries.length / this.pageSize),
    );
    const pager = containerEl.createDiv({
      cls: "local-sync-history-pager",
    });

    const prevBtn = pager.createEl("button", {
      text: "上一页",
      cls: "local-sync-filter-btn",
    });
    prevBtn.addEventListener("click", () => {
      if (this.currentPage > 0) {
        this.currentPage--;
        this.renderList();
      }
    });

    pager.createSpan({
      text: ` 第 ${this.currentPage + 1} / ${totalPages} 页 `,
      cls: "local-sync-pager-info",
    });

    const nextBtn = pager.createEl("button", {
      text: "下一页",
      cls: "local-sync-filter-btn",
    });
    nextBtn.addEventListener("click", () => {
      if (this.currentPage < totalPages - 1) {
        this.currentPage++;
        this.renderList();
      }
    });
  }

  // ============================================================
  // Export
  // ============================================================

  private buildCsv(): string {
    const header = ["timestamp", "level", "message", "filePath", "eventType"];
    const rows: string[] = [header.join(",")];
    for (const e of this.filteredEntries) {
      rows.push(
        [
          formatTime(e.timestamp),
          translateLevel(e.level),
          this.csvEscape(e.message),
          this.csvEscape(e.filePath ?? ""),
          translateEvent(e.eventType),
        ].join(","),
      );
    }
    return rows.join("\n");
  }

  private csvEscape(value: string): string {
    if (/[",\n]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  private async copyCsv(): Promise<void> {
    const csv = this.buildCsv();
    await this.copyText(csv, "已复制 CSV 到剪贴板");
  }

  private saveCsv(): void {
    const csv = this.buildCsv();
    const filename = `sync-history-${this.toDateInput(Date.now())}.csv`;
    try {
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      new Notice(`已导出 ${filename}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`导出失败：${message}`);
    }
  }

  private async copyText(text: string, successMsg: string): Promise<void> {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        new Notice(successMsg);
      } else {
        new Notice("当前环境不支持剪贴板");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`复制失败：${message}`);
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  private toRawLine(entry: SyncHistoryEntry): string {
    const ts = formatTime(entry.timestamp);
    const fileInfo = entry.filePath ? ` (${entry.filePath})` : "";
    const eventInfo = entry.eventType ? ` [${entry.eventType}]` : "";
    return `[${ts}] [${entry.level}] ${entry.message}${fileInfo}${eventInfo}`;
  }

  private parseDateStart(value: string): number | undefined {
    if (!value) {
      return undefined;
    }
    const d = new Date(`${value}T00:00:00`);
    if (Number.isNaN(d.getTime())) {
      return undefined;
    }
    return d.getTime();
  }

  private parseDateEnd(value: string): number | undefined {
    if (!value) {
      return undefined;
    }
    const d = new Date(`${value}T23:59:59`);
    if (Number.isNaN(d.getTime())) {
      return undefined;
    }
    return d.getTime();
  }

  private startOfDay(ts: number): number {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  private toDateInput(ts: number): string {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
}
