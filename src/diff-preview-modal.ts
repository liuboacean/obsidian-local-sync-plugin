// ============================================================
// Diff Preview Modal — Diff Preview Before Sync (Feature 2)
// ============================================================
// An Obsidian Modal that shows a line-level diff for TEXT files or a
// meta-only comparison for BINARY files, with three actions
// (Confirm / Skip / Confirm All) and a 30s auto-confirm countdown.
//
// Closing the modal without a decision (X / Esc / click-outside) is
// treated as SKIP. All timers are cleared on close to avoid leaks.

import { Modal } from "obsidian";
import { diffLines, type Change } from "diff";
import {
  DiffPreviewRequest,
  DiffPreviewAction,
} from "./types";
import { DIFF_PREVIEW_TIMEOUT_MS } from "./constants";
import { formatTime } from "./utils";

// ============================================================
// Options
// ============================================================

interface DiffPreviewModalOptions {
  /** Show the "Confirm All" button (only when more files are queued). */
  showConfirmAll: boolean;
}

// ============================================================
// Modal Class
// ============================================================

export class DiffPreviewModal extends Modal {
  private readonly request: DiffPreviewRequest;
  private readonly showConfirmAll: boolean;
  private timeoutId: number | null = null;
  private intervalId: number | null = null;
  private remainingSeconds: number;
  private resolved = false;
  private countdownEl: HTMLElement | null = null;

  constructor(
    app: import("obsidian").App,
    request: DiffPreviewRequest,
    options: DiffPreviewModalOptions,
  ) {
    super(app);
    this.request = request;
    this.showConfirmAll = options.showConfirmAll;
    this.remainingSeconds = Math.ceil(DIFF_PREVIEW_TIMEOUT_MS / 1000);
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    this.renderHeader(contentEl);
    this.renderDiffContent(contentEl);
    this.renderActionButtons(contentEl);
    this.startCountdown();

    // Enter = confirm (ignored while typing in an input/textarea).
    contentEl.addEventListener("keydown", (evt: KeyboardEvent) => {
      const target = evt.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if (evt.key === "Enter" && !typing) {
        evt.preventDefault();
        this.decide(DiffPreviewAction.CONFIRM);
      }
    });
  }

  onClose(): void {
    this.clearCountdown();
    if (!this.resolved) {
      // Closed without a decision (X / Esc / click outside) → SKIP.
      this.resolved = true;
      this.request.resolve({
        requestId: this.request.requestId,
        action: DiffPreviewAction.SKIP,
      });
    }
    this.contentEl.empty();
  }

  // ============================================================
  // Header
  // ============================================================

  private renderHeader(containerEl: HTMLElement): void {
    const header = containerEl.createDiv({ cls: "local-sync-diff-header" });
    header.createEl("h3", {
      text: `📄 文件: ${this.request.change.relativePath}`,
      cls: "local-sync-diff-title",
    });
    if (this.showConfirmAll) {
      header.createEl("p", {
        text: "（多个文件待处理，可选择「全部确认」批量放行）",
        cls: "setting-item-description",
      });
    }
  }

  // ============================================================
  // Diff Content
  // ============================================================

  private renderDiffContent(containerEl: HTMLElement): void {
    const isText = this.request.newContent !== undefined;
    if (isText) {
      this.renderTextDiff(containerEl, this.request.currentContent ?? "", this.request.newContent ?? "");
    } else {
      this.renderBinaryComparison(containerEl);
    }
  }

  private renderTextDiff(
    containerEl: HTMLElement,
    oldText: string,
    newText: string,
  ): void {
    const wrapper = containerEl.createDiv({
      cls: "local-sync-diff-body",
    });

    const changes: Change[] = diffLines(oldText, newText);

    const pre = wrapper.createEl("pre", { cls: "local-sync-diff-pre" });

    if (changes.length === 0) {
      pre.createEl("div", {
        text: "（文件内容未发生变化）",
        cls: "setting-item-description",
      });
      return;
    }

    for (const part of changes) {
      const lines = part.value.split("\n");
      // diffLines keeps a trailing newline; drop the empty final element.
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      for (const line of lines) {
        let prefix = "  ";
        let color = "var(--text-normal)";
        if (part.added) {
          prefix = "＋";
          color = "var(--text-success)";
        } else if (part.removed) {
          prefix = "－";
          color = "var(--text-error)";
        }
        pre.createEl("div", {
          text: `${prefix} ${line}`,
          cls: "local-sync-diff-line",
        }).style.color = color;
      }
    }
  }

  private renderBinaryComparison(containerEl: HTMLElement): void {
    const wrapper = containerEl.createDiv({ cls: "local-sync-diff-body" });
    const table = wrapper.createEl("table", {
      cls: "local-sync-diff-table",
    });

    const head = table.createEl("thead").createEl("tr");
    head.createEl("th", { text: "属性" });
    head.createEl("th", { text: "本地（当前）" });
    head.createEl("th", { text: "上次同步" });

    const body = table.createEl("tbody");
    const newMeta = this.request.newMeta;
    const currentMeta = this.request.currentMeta;

    this.appendMetaRow(body, "大小 (bytes)", newMeta?.size, currentMeta?.size);
    this.appendMetaRow(body, "修改时间", newMeta ? formatTime(newMeta.mtime) : undefined, currentMeta ? formatTime(currentMeta.mtime) : undefined);
    this.appendMetaRow(body, "哈希 (SHA-256)", newMeta?.hash || "（不可用）", currentMeta?.hash || "（无记录）");

    if (!currentMeta) {
      wrapper.createEl("p", {
        text: "（首次同步，无旧版本元信息记录）",
        cls: "setting-item-description",
      });
    }
  }

  private appendMetaRow(
    body: HTMLElement,
    label: string,
    newValue: string | number | undefined,
    oldValue: string | number | undefined,
  ): void {
    const tr = body.createEl("tr");
    tr.createEl("td", { text: label });
    tr.createEl("td", { text: newValue !== undefined ? String(newValue) : "—" });
    tr.createEl("td", { text: oldValue !== undefined ? String(oldValue) : "—" });
  }

  // ============================================================
  // Action Buttons
  // ============================================================

  private renderActionButtons(containerEl: HTMLElement): void {
    const bar = containerEl.createDiv({ cls: "local-sync-diff-actions" });

    // Skip (normal)
    const skipBtn = bar.createEl("button", {
      text: "⏭ 跳过",
      cls: "local-sync-diff-btn",
    });
    skipBtn.addEventListener("click", () => this.decide(DiffPreviewAction.SKIP));

    // Confirm (cta)
    const confirmBtn = bar.createEl("button", {
      text: "✅ 确认同步",
      cls: "local-sync-diff-btn mod-cta",
    });
    confirmBtn.addEventListener("click", () =>
      this.decide(DiffPreviewAction.CONFIRM),
    );

    // Confirm All (only when more files queued)
    if (this.showConfirmAll) {
      const confirmAllBtn = bar.createEl("button", {
        text: "✅✅ 全部确认",
        cls: "local-sync-diff-btn",
      });
      confirmAllBtn.addEventListener("click", () =>
        this.decide(DiffPreviewAction.CONFIRM_ALL),
      );
    }

    // Countdown text
    this.countdownEl = bar.createEl("span", {
      text: "",
      cls: "local-sync-diff-countdown",
    });
  }

  // ============================================================
  // Decision
  // ============================================================

  private decide(action: DiffPreviewAction): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    this.clearCountdown();
    this.request.resolve({
      requestId: this.request.requestId,
      action,
    });
    this.close();
  }

  // ============================================================
  // Countdown
  // ============================================================

  private startCountdown(): void {
    this.updateCountdownText();
    this.timeoutId = window.setTimeout(() => {
      // Auto-confirm on timeout.
      this.decide(DiffPreviewAction.CONFIRM);
    }, DIFF_PREVIEW_TIMEOUT_MS);

    this.intervalId = window.setInterval(() => {
      this.remainingSeconds -= 1;
      this.updateCountdownText();
      if (this.remainingSeconds <= 0 && this.intervalId !== null) {
        window.clearInterval(this.intervalId);
        this.intervalId = null;
      }
    }, 1000);
  }

  private updateCountdownText(): void {
    if (this.countdownEl) {
      this.countdownEl.textContent = `⏱ ${Math.max(0, this.remainingSeconds)}秒后自动同步`;
    }
  }

  private clearCountdown(): void {
    if (this.timeoutId !== null) {
      window.clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
