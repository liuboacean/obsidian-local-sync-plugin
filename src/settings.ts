// ============================================================
// Settings — Defaults, Load, Save
// ============================================================

import * as crypto from "crypto";
import type { SyncSettings } from "./types";
import { SyncMode, SyncDirection, ConflictStrategy } from "./types";
import { DEFAULT_PORT, UDP_DISCOVERY_PORT } from "./constants";

// ============================================================
// Default Settings
// ============================================================

export const DEFAULT_SETTINGS: SyncSettings = {
  mode: SyncMode.DUPLEX,
  port: DEFAULT_PORT,
  targetAddress: "",
  deviceName: `Device-${crypto.randomBytes(4).toString("hex")}`,
  ignoreFolders: [".trash"],
  ignoreExtensions: [".tmp", ".bak"],
  direction: SyncDirection.BIDIRECTIONAL,
  conflictStrategy: ConflictStrategy.ALWAYS_ASK,
  syncObsidianConfig: false,
  enableUdpDiscovery: true,
  udpDiscoveryPort: UDP_DISCOVERY_PORT,
  crdtEnabled: true,
  textExtensions: [
    ".md", ".txt", ".html", ".css", ".js", ".ts",
    ".json", ".yaml", ".yml", ".xml", ".svg",
    ".csv", ".log", ".canvas",
  ],

  // TLS
  enableTls: true,
  allowTlsFallback: true,
  trustedFingerprints: [],

  // Diff Preview Before Sync (v1.2.0)
  enableDiffPreview: false,
  diffPreviewWhitelistFolders: [],
};

// ============================================================
// Settings Manager
// ============================================================

export interface SettingsManager {
  getSettings(): SyncSettings;
  loadSettings(): Promise<void>;
  saveSettings(settings: SyncSettings): Promise<void>;
}

/**
 * A simple settings manager that wraps the Obsidian loadData/saveData API.
 * The plugin passes its own loadData/saveData functions so this module
 * has no direct dependency on the Obsidian Plugin class.
 */
export function createSettingsManager(
  loadDataFn: () => Promise<Record<string, unknown>>,
  saveDataFn: (data: Record<string, unknown>) => Promise<void>,
): SettingsManager {
  let currentSettings: SyncSettings = { ...DEFAULT_SETTINGS };

  return {
    getSettings(): SyncSettings {
      return currentSettings;
    },

    async loadSettings(): Promise<void> {
      const loadedData = await loadDataFn();
      currentSettings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
    },

    async saveSettings(settings: SyncSettings): Promise<void> {
      currentSettings = settings;
      await saveDataFn(settings as unknown as Record<string, unknown>);
    },
  };
}
