// ============================================================
// Obsidian Settings Tab — Local Sync Plugin
// ============================================================
// 6 sections:
//   1. Connection Configuration
//   2. Device Discovery
//   3. Sync Rules
//   4. Conflict Strategy
//   5. Security Settings
//   6. Sync Status

import { App, Plugin, PluginSettingTab, Setting, Notice } from "obsidian";
import {
  SyncSettings,
  SyncMode,
  SyncDirection,
  ConflictStrategy,
  SyncStats,
  DiscoveredDevice,
} from "./types";
import { DEFAULT_SETTINGS } from "./settings";
import { DEFAULT_PORT, UDP_DISCOVERY_PORT } from "./constants";
import type ObsidianLocalSyncPlugin from "./main";

// ============================================================
// Setting Tab Class
// ============================================================

export class LocalSyncSettingTab extends PluginSettingTab {
  private plugin: ObsidianLocalSyncPlugin;

  constructor(app: App, plugin: ObsidianLocalSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obsidian Local Sync" });

    this.renderConnectionSection(containerEl);
    this.renderDiscoverySection(containerEl);
    this.renderSyncRulesSection(containerEl);
    this.renderConflictStrategySection(containerEl);
    this.renderSecuritySection(containerEl);
    this.renderSyncStatusSection(containerEl);

    // Auto-refresh stats every 3 seconds while settings page is open
    this.plugin.registerInterval(
      window.setInterval(() => {
        // Find and update the status section desc elements in-place
        this.updateStatsInPlace(containerEl);
      }, 3000)
    );
  }

  /**
   * Update the stats section in-place without rebuilding the entire page.
   */
  private updateStatsInPlace(containerEl: HTMLElement): void {
    const stats = this.plugin.engine?.getSyncStats() ?? null;
    const isConnected = this.plugin.connMgr?.getIsConnected() ?? false;

    // Find the "连接状态" setting and update its desc
    const allSettings = Array.from(containerEl.querySelectorAll(".setting-item-info"));
    for (const info of allSettings) {
      const nameEl = info.querySelector(".setting-item-name");
      if (!nameEl) continue;
      const name = nameEl.textContent || "";

      // The desc is the next sibling element
      const descEl = info.nextElementSibling?.querySelector(".setting-item-description");
      if (!descEl) continue;

      switch (name) {
        case "连接状态":
          descEl.textContent = isConnected ? "🟢 已连接" : "🔴 未连接";
          break;
        case "上次同步":
          descEl.textContent = stats?.lastSyncTime ?? "尚未同步";
          break;
        case "待同步文件":
          descEl.textContent = String(stats?.pendingFiles ?? 0);
          break;
        case "已同步文件":
          descEl.textContent = String(stats?.syncedFiles ?? 0);
          break;
        case "冲突文件":
          descEl.textContent = String(stats?.conflictedFiles ?? 0);
          break;
        case "发现设备":
          const deviceCount =
            (this.plugin.discoveryMgr?.getDiscoveredDevices()?.length ?? 0) +
            (isConnected ? 1 : 0);
          descEl.textContent = String(deviceCount);
          break;
      }
    }
  }

  // ============================================================
  // 1. Connection Configuration
  // ============================================================

  private renderConnectionSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "🔌 连接配置" });

    // Sync mode dropdown
    new Setting(containerEl)
      .setName("同步模式")
      .setDesc("选择连接模式：双向模式两端同时监听；服务端模式只监听；客户端模式只连接")
      .addDropdown((dropdown) => {
        dropdown
          .addOption(SyncMode.DUPLEX, "双向模式 (DUPLEX)")
          .addOption(SyncMode.SERVER, "服务端模式 (SERVER)")
          .addOption(SyncMode.CLIENT, "客户端模式 (CLIENT)")
          .setValue(this.plugin.getSettings().mode)
          .onChange(async (value: string) => {
            const settings = this.plugin.getSettings();
            settings.mode = value as SyncMode;
            await this.plugin.saveSettings();
          });
      });

    // Listen port
    new Setting(containerEl)
      .setName("监听端口")
      .setDesc("WebSocket 连接端口 (1-65535)")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_PORT))
          .setValue(String(this.plugin.getSettings().port))
          .onChange(async (value) => {
            const port = parseInt(value, 10);
            if (!isNaN(port) && port > 0 && port <= 65535) {
              const settings = this.plugin.getSettings();
              settings.port = port;
              await this.plugin.saveSettings();
            }
          })
      );

    // Target address
    new Setting(containerEl)
      .setName("目标地址")
      .setDesc("远端设备的 IP 地址（客户端模式需要填写）")
      .addText((text) =>
        text
          .setPlaceholder("192.168.1.100")
          .setValue(this.plugin.getSettings().targetAddress)
          .onChange(async (value) => {
            const settings = this.plugin.getSettings();
            settings.targetAddress = value;
            await this.plugin.saveSettings();
          })
      );

    // Device name
    new Setting(containerEl)
      .setName("设备标识")
      .setDesc("本设备在网络中显示的名称")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.deviceName)
          .setValue(this.plugin.getSettings().deviceName)
          .onChange(async (value) => {
            const settings = this.plugin.getSettings();
            settings.deviceName = value;
            await this.plugin.saveSettings();
          })
      );

    // Connect / Disconnect button
    new Setting(containerEl)
      .setName("连接控制")
      .setDesc("手动启动或断开同步连接")
      .addButton((button) => {
        const isConnected = this.plugin.connMgr?.getIsConnected() ?? false;
        button
          .setButtonText(isConnected ? "断开连接" : "开始连接")
          .setCta()
          .onClick(async () => {
            if (isConnected) {
              this.plugin.disconnectSync();
              button.setButtonText("开始连接");
              new Notice("同步已断开");
            } else {
              await this.plugin.startSync();
              button.setButtonText("断开连接");
              new Notice("同步连接已启动");
            }
          });
      });
  }

  // ============================================================
  // 2. Device Discovery
  // ============================================================

  private renderDiscoverySection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "📡 设备发现" });

    // UDP discovery toggle
    new Setting(containerEl)
      .setName("启用 UDP 广播发现")
      .setDesc("在局域网内自动发现其他运行本插件的设备")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.getSettings().enableUdpDiscovery)
          .onChange(async (value) => {
            const settings = this.plugin.getSettings();
            settings.enableUdpDiscovery = value;
            await this.plugin.saveSettings();
            if (value) {
              this.plugin.startDiscovery();
            } else {
              this.plugin.stopDiscovery();
            }
          })
      );

    // UDP discovery port
    new Setting(containerEl)
      .setName("发现端口")
      .setDesc("UDP 广播使用的端口")
      .addText((text) =>
        text
          .setPlaceholder(String(UDP_DISCOVERY_PORT))
          .setValue(String(this.plugin.getSettings().udpDiscoveryPort))
          .onChange(async (value) => {
            const port = parseInt(value, 10);
            if (!isNaN(port) && port > 0 && port <= 65535) {
              const settings = this.plugin.getSettings();
              settings.udpDiscoveryPort = port;
              await this.plugin.saveSettings();
            }
          })
      );

    // Discovered devices list
    const devices = this.plugin.discoveryMgr?.getDiscoveredDevices() ?? [];
    const deviceListEl = containerEl.createDiv("discovery-device-list");
    deviceListEl.style.marginTop = "8px";

    if (devices.length === 0) {
      deviceListEl.createEl("p", {
        text: "尚未发现设备。确保其他设备已开启 UDP 广播发现。",
        cls: "setting-item-description",
      });
    } else {
      deviceListEl.createEl("p", {
        text: `已发现 ${devices.length} 台设备:`,
        cls: "setting-item-description",
      });

      for (const device of devices) {
        this.renderDiscoveredDevice(deviceListEl, device);
      }
    }

    // Manual add device
    new Setting(containerEl)
      .setName("手动添加设备")
      .setDesc("输入 IP:端口 手动添加设备（如 192.168.1.100:8888）")
      .addText((text) =>
        text.setPlaceholder("192.168.1.100:8888")
      )
      .addButton((button) =>
        button.setButtonText("添加").onClick(async () => {
          const inputEl = containerEl.querySelector(
            '.setting-item:last-child input[type="text"]',
          ) as HTMLInputElement;
          if (inputEl && inputEl.value) {
            const parts = inputEl.value.split(":");
            const ip = parts[0];
            const port = parts.length > 1 ? parseInt(parts[1], 10) : DEFAULT_PORT;
            this.plugin.connectToDevice(ip, port);
            new Notice(`正在连接 ${ip}:${port}...`);
            inputEl.value = "";
          }
        })
      );
  }

  private renderDiscoveredDevice(
    containerEl: HTMLElement,
    device: DiscoveredDevice,
  ): void {
    const statusColor =
      device.status === "online" ? "#4caf50" : "#f44336";
    const statusText =
      device.status === "online" ? "在线" : "离线";

    new Setting(containerEl)
      .setName(device.deviceName || device.deviceId)
      .setDesc(`${device.ip}:${device.port}  ·  状态: ${statusText}`)
      .addExtraButton((button) => {
        button
          .setIcon("circle")
          .setTooltip(statusText)
          .extraSettingsEl.style.color = statusColor;
      })
      .addButton((button) => {
        if (device.status === "online") {
          button
            .setButtonText("连接")
            .onClick(() => {
              this.plugin.connectToDevice(device.ip, device.port);
              new Notice(`正在连接 ${device.deviceName}...`);
            });
        }
      });
  }

  // ============================================================
  // 3. Sync Rules
  // ============================================================

  private renderSyncRulesSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "📋 同步规则" });

    // Ignore folders
    new Setting(containerEl)
      .setName("忽略文件夹")
      .setDesc("不同步的文件夹名，逗号分隔")
      .addText((text) =>
        text
          .setPlaceholder(".trash, .git")
          .setValue(this.plugin.getSettings().ignoreFolders.join(", "))
          .onChange(async (value) => {
            const settings = this.plugin.getSettings();
            settings.ignoreFolders = value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          })
      );

    // Ignore extensions
    new Setting(containerEl)
      .setName("忽略扩展名")
      .setDesc("不同步的文件扩展名，逗号分隔")
      .addText((text) =>
        text
          .setPlaceholder(".tmp, .bak")
          .setValue(this.plugin.getSettings().ignoreExtensions.join(", "))
          .onChange(async (value) => {
            const settings = this.plugin.getSettings();
            settings.ignoreExtensions = value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          })
      );

    // Sync direction
    new Setting(containerEl)
      .setName("同步方向")
      .setDesc("选择数据流向")
      .addDropdown((dropdown) => {
        dropdown
          .addOption(SyncDirection.BIDIRECTIONAL, "双向同步")
          .addOption(SyncDirection.UPLOAD_ONLY, "仅上传 (本机→远端)")
          .addOption(SyncDirection.DOWNLOAD_ONLY, "仅下载 (远端→本机)")
          .setValue(this.plugin.getSettings().direction)
          .onChange(async (value: string) => {
            const settings = this.plugin.getSettings();
            settings.direction = value as SyncDirection;
            await this.plugin.saveSettings();
          });
      });
  }

  // ============================================================
  // 4. Conflict Strategy
  // ============================================================

  private renderConflictStrategySection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "⚡ 冲突策略" });

    new Setting(containerEl)
      .setName("二进制文件冲突策略")
      .setDesc("当两台设备同时修改了同一个二进制文件时的处理方式")
      .addDropdown((dropdown) => {
        dropdown
          .addOption(ConflictStrategy.ALWAYS_ASK, "始终询问（弹窗）")
          .addOption(ConflictStrategy.KEEP_LATEST, "保留最新版本")
          .addOption(ConflictStrategy.KEEP_LOCAL, "始终保留本地版本")
          .setValue(this.plugin.getSettings().conflictStrategy)
          .onChange(async (value: string) => {
            const settings = this.plugin.getSettings();
            settings.conflictStrategy = value as ConflictStrategy;
            await this.plugin.saveSettings();
          });
      });

    // Show active conflicts
    const activeConflicts =
      this.plugin.conflictDetector?.getActiveConflicts() ?? [];
    if (activeConflicts.length > 0) {
      new Setting(containerEl)
        .setName(`待解决冲突 (${activeConflicts.length})`)
        .setDesc("以下文件存在同步冲突，需要你决定保留哪个版本")
        .addButton((button) =>
          button.setButtonText("查看冲突").onClick(() => {
            // Trigger the conflict resolver for the first unresolved conflict
            if (activeConflicts.length > 0) {
              this.plugin.showConflictDialog(activeConflicts[0]);
            }
          })
        );
    }
  }

  // ============================================================
  // 5. Security Settings
  // ============================================================

  private renderSecuritySection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "🔒 安全设置" });

    // Sync .obsidian config toggle
    new Setting(containerEl)
      .setName("同步 .obsidian 配置")
      .setDesc("同步 Obsidian 设置、主题、热键等配置文件（谨慎启用）")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.getSettings().syncObsidianConfig)
          .onChange(async (value) => {
            const settings = this.plugin.getSettings();
            settings.syncObsidianConfig = value;
            await this.plugin.saveSettings();
          })
      );

    // PSK key display / reset
    new Setting(containerEl)
      .setName("预共享密钥 (PSK)")
      .setDesc("同步认证密钥。更改后所有设备需要重新配对")
      .addText((text) =>
        text
          .setPlaceholder("自动生成")
          .setValue(this.plugin.getSettings().sharedKey || "")
          .onChange(async (value) => {
            const settings = this.plugin.getSettings();
            settings.sharedKey = value || undefined;
            await this.plugin.saveSettings();
          })
      )
      .addButton((button) =>
        button.setButtonText("重置").onClick(async () => {
          const settings = this.plugin.getSettings();
          settings.sharedKey = undefined;
          await this.plugin.saveSettings();
          this.display(); // Refresh
          new Notice("PSK 已重置");
        })
      );
  }

  // ============================================================
  // 6. Sync Status
  // ============================================================

  private renderSyncStatusSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "📊 同步状态" });

    const stats: SyncStats | null =
      this.plugin.engine?.getSyncStats() ?? null;
    const isConnected =
      this.plugin.connMgr?.getIsConnected() ?? false;
    const deviceCount =
      (this.plugin.discoveryMgr?.getDiscoveredDevices()?.length ?? 0) +
      (isConnected ? 1 : 0);

    // Connection status
    const statusText = isConnected ? "🟢 已连接" : "🔴 未连接";
    new Setting(containerEl)
      .setName("连接状态")
      .setDesc(statusText);

    // Last sync time
    new Setting(containerEl)
      .setName("上次同步")
      .setDesc(stats?.lastSyncTime ?? "尚未同步");

    // Pending files
    new Setting(containerEl)
      .setName("待同步文件")
      .setDesc(String(stats?.pendingFiles ?? 0));

    // Synced files
    new Setting(containerEl)
      .setName("已同步文件")
      .setDesc(String(stats?.syncedFiles ?? 0));

    // Conflicted files
    new Setting(containerEl)
      .setName("冲突文件")
      .setDesc(String(stats?.conflictedFiles ?? 0));

    // Discovered devices
    new Setting(containerEl)
      .setName("发现设备")
      .setDesc(String(deviceCount));

    // Quick refresh button
    new Setting(containerEl)
      .setName("刷新状态")
      .setDesc("更新同步状态面板")
      .addButton((button) =>
        button.setButtonText("刷新").onClick(() => {
          this.display();
        })
      );
  }
}
