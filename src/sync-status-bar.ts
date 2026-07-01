// ============================================================
// Sync Status Bar Indicator
// ============================================================
// Displays real-time sync status in the Obsidian status bar.
//
// Format:
//   [● 已同步] | 2 设备 | 0 待同步    — 正常
//   [● 同步中] | 1 设备 | 3/10 文件    — 同步中
//   [○ 已断开]                           — 未连接
//   [⚠ 3冲突]                           — 有冲突

import type ObsidianLocalSyncPlugin from "./main";

// ============================================================
// Status Bar Class
// ============================================================

export class SyncStatusBar {
  private plugin: ObsidianLocalSyncPlugin;
  private statusBarEl: HTMLElement | null = null;

  /** Current display state. */
  private connectionStatus: "connected" | "disconnected" | "connecting" =
    "disconnected";
  private isSyncing = false;
  private deviceCount = 0;
  private pendingCount = 0;
  private conflictCount = 0;
  private syncProgressCurrent = 0;
  private syncProgressTotal = 0;

  /** Blink animation interval for syncing state. */
  private syncingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(plugin: ObsidianLocalSyncPlugin) {
    this.plugin = plugin;
  }

  // ============================================================
  // Registration
  // ============================================================

  /**
   * Register the status bar item with the Obsidian plugin.
   * Called from main.ts onload().
   */
  registerStatusBar(): void {
    this.statusBarEl = this.plugin.addStatusBarItem();
    this.render();
  }

  // ============================================================
  // Update Methods
  // ============================================================

  /**
   * Update connection status display.
   */
  updateConnectionStatus(
    status: "connected" | "disconnected" | "connecting",
  ): void {
    this.connectionStatus = status;
    if (status !== "connected") {
      this.stopSyncingAnimation();
    }
    this.render();
  }

  /**
   * Set the syncing state.
   * When syncing, a blue blinking animation is shown.
   */
  setSyncing(isSyncing: boolean): void {
    this.isSyncing = isSyncing;
    if (isSyncing) {
      this.startSyncingAnimation();
    } else {
      this.stopSyncingAnimation();
    }
    this.render();
  }

  /**
   * Set the number of discovered devices.
   */
  setDeviceCount(count: number): void {
    this.deviceCount = count;
    this.render();
  }

  /**
   * Set the number of pending (unsynced) files.
   */
  setPendingCount(count: number): void {
    this.pendingCount = count;
    this.render();
  }

  /**
   * Set sync progress (for initial sync or large transfers).
   */
  setSyncProgress(current: number, total: number): void {
    this.syncProgressCurrent = current;
    this.syncProgressTotal = total;
    this.render();
  }

  /**
   * Set the number of conflicting files.
   */
  setConflictCount(count: number): void {
    this.conflictCount = count;
    this.render();
  }

  // ============================================================
  // Rendering
  // ============================================================

  /**
   * Render the status bar text based on current state.
   */
  private render(): void {
    if (!this.statusBarEl) {
      return;
    }

    const parts: string[] = [];

    // Connection indicator
    if (this.conflictCount > 0) {
      parts.push(`⚠ ${this.conflictCount}冲突`);
    }

    switch (this.connectionStatus) {
      case "connected":
        if (this.isSyncing) {
          if (this.syncProgressTotal > 0) {
            parts.push(
              `● 同步中 ${this.syncProgressCurrent}/${this.syncProgressTotal}`,
            );
          } else {
            parts.push("● 同步中");
          }
        } else {
          parts.push("● 已同步");
        }
        break;
      case "connecting":
        parts.push("● 连接中");
        break;
      case "disconnected":
        parts.push("○ 已断开");
        break;
    }

    // Device count
    if (this.deviceCount > 0) {
      parts.push(`${this.deviceCount} 设备`);
    }

    // Pending files
    if (this.pendingCount > 0) {
      parts.push(`${this.pendingCount} 待同步`);
    }

    this.statusBarEl.setText(parts.join(" | "));
  }

  // ============================================================
  // Syncing Animation
  // ============================================================

  /**
   * Start a blue blinking animation to indicate active syncing.
   */
  private startSyncingAnimation(): void {
    this.stopSyncingAnimation();

    let visible = true;
    this.syncingInterval = setInterval(() => {
      if (this.statusBarEl) {
        this.statusBarEl.style.color = visible
          ? "var(--text-accent, #6c8cff)"
          : "var(--text-muted, #999)";
        visible = !visible;
      }
    }, 800);
  }

  /**
   * Stop the syncing animation and reset color.
   */
  private stopSyncingAnimation(): void {
    if (this.syncingInterval) {
      clearInterval(this.syncingInterval);
      this.syncingInterval = null;
    }
    if (this.statusBarEl) {
      this.statusBarEl.style.color = "";
    }
  }
}
