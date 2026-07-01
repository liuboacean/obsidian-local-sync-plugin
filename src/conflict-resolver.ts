// ============================================================
// Binary File Conflict Resolver Modal
// ============================================================
// Displays a modal dialog when a BINARY file conflict is detected.
// TEXT files use CRDT auto-merge, so only BINARY files trigger this UI.

import { App, Modal, Setting, ButtonComponent } from "obsidian";
import { ConflictInfo, ConflictStatus } from "./types";
import { formatTime } from "./utils";

// ============================================================
// Conflict Resolution Result
// ============================================================

export type ConflictResolution = "keep_local" | "keep_remote" | "keep_both";

// ============================================================
// Conflict Modal Class
// ============================================================

export class ConflictResolverModal extends Modal {
  private conflictInfo: ConflictInfo;
  private resolvePromise: Promise<ConflictResolution>;
  private resolveFn: ((value: ConflictResolution) => void) | null = null;

  constructor(app: App, conflictInfo: ConflictInfo) {
    super(app);
    this.conflictInfo = conflictInfo;
    this.resolvePromise = new Promise((resolve) => {
      this.resolveFn = resolve;
    });
  }

  /**
   * Show the conflict resolution modal and return the user's choice.
   */
  static showConflictModal(
    app: App,
    conflictInfo: ConflictInfo,
  ): Promise<ConflictResolution> {
    const modal = new ConflictResolverModal(app, conflictInfo);
    modal.open();
    return modal.resolvePromise;
  }

  // ============================================================
  // Modal Content
  // ============================================================

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    // Title
    contentEl.createEl("h2", {
      text: "⚠️ 二进制文件冲突",
      attr: { style: "color: var(--text-warning); margin-bottom: 12px;" },
    });

    contentEl.createEl("p", {
      text: "此文件为二进制文件，CRDT 无法自动合并。请选择处理方式：",
      attr: { style: "margin-bottom: 16px;" },
    });

    // File name
    contentEl.createEl("p", {
      text: `文件: ${this.conflictInfo.relativePath}`,
      attr: { style: "font-weight: bold; margin-bottom: 12px;" },
    });

    // Two-column version comparison
    const columnsEl = contentEl.createDiv({
      attr: { style: "display: flex; gap: 12px; margin-bottom: 16px;" },
    });

    // Local version (left column)
    const localCol = columnsEl.createDiv({
      attr: { style: "flex: 1; padding: 8px; border: 1px solid var(--background-modifier-border); border-radius: 6px;" },
    });
    localCol.createEl("h4", {
      text: "本地版本",
      attr: { style: "margin-bottom: 8px;" },
    });
    this.renderVersionInfo(localCol, this.conflictInfo.localVersion);

    // Remote version (right column)
    const remoteCol = columnsEl.createDiv({
      attr: { style: "flex: 1; padding: 8px; border: 1px solid var(--background-modifier-border); border-radius: 6px;" },
    });
    remoteCol.createEl("h4", {
      text: "远端版本",
      attr: { style: "margin-bottom: 8px;" },
    });
    this.renderVersionInfo(remoteCol, this.conflictInfo.remoteVersion);

    // Conflict type
    contentEl.createEl("p", {
      text: `冲突类型: ${this.conflictInfo.conflictType}`,
      attr: { style: "color: var(--text-muted); margin-bottom: 16px; font-size: 0.9em;" },
    });

    // Action buttons
    const buttonContainer = contentEl.createDiv({
      attr: { style: "display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px;" },
    });

    // Keep local
    new ButtonComponent(buttonContainer)
      .setButtonText("保留本地")
      .setCta()
      .onClick(() => {
        this.resolve("keep_local");
      });

    // Keep both
    new ButtonComponent(buttonContainer)
      .setButtonText("同时保留")
      .onClick(() => {
        this.resolve("keep_both");
      });

    // Keep remote
    new ButtonComponent(buttonContainer)
      .setButtonText("保留远端")
      .onClick(() => {
        this.resolve("keep_remote");
      });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
    // If user closes the modal without choosing, default to keep_local
    if (this.resolveFn) {
      this.resolveFn("keep_local");
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  /**
   * Render version information (file size, mtime, hash) for one side.
   */
  private renderVersionInfo(
    containerEl: HTMLElement,
    version: { mtime: number; hash: string; size: number },
  ): void {
    const info = [
      `大小: ${this.formatSize(version.size)}`,
      `修改时间: ${formatTime(version.mtime)}`,
      `SHA-256: ${version.hash ? version.hash.substring(0, 16) + "..." : "N/A"}`,
    ];

    for (const line of info) {
      containerEl.createEl("p", {
        text: line,
        attr: { style: "margin-bottom: 4px; font-size: 0.9em;" },
      });
    }
  }

  /**
   * Format byte size to human-readable string.
   */
  private formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (bytes >= 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${bytes} B`;
  }

  /**
   * Resolve the conflict with the user's choice.
   */
  private resolve(resolution: ConflictResolution): void {
    if (this.resolveFn) {
      this.resolveFn(resolution);
      this.resolveFn = null;
    }
    this.close();
  }
}
