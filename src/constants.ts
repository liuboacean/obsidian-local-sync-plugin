// ============================================================
// Port Configuration
// ============================================================

export const DEFAULT_PORT = 8888;
export const UDP_DISCOVERY_PORT = 8889;

// ============================================================
// Timing Constants (ms)
// ============================================================

export const DEBOUNCE_MS = 500;
export const HEARTBEAT_INTERVAL_MS = 120000
export const HEARTBEAT_TIMEOUT_MS = 240000;
export const CONFLICT_WINDOW_MS = 30000;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 60000;
export const RECENTLY_PUSHED_TTL_MS = 2000;
export const AUTH_LOCKOUT_MS = 300000;
export const UDP_DISCOVERY_INTERVAL_MS = 5000;
export const UDP_DEVICE_TIMEOUT_MS = 30000;
export const CRDT_SNAPSHOT_INTERVAL_MS = 300000; // 5min dirty-flag check

// ============================================================
// TLS Certificate Constants
// ============================================================

export const CERT_DIR_NAME = "certs";
export const CERT_DIR_PREFIX = ".obsidian-sync";
export const CERT_FILE_NAME = "cert.pem";
export const KEY_FILE_NAME = "key.pem";
export const CERT_DAYS_VALID = 3650; // 10 years

// ============================================================
// Size & Count Limits
// ============================================================

export const MAX_LOG_ENTRIES = 500;
export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
export const FILE_LIST_BATCH_SIZE = 100;
export const AUTH_MAX_FAILURES = 5;
export const HASH_SIZE_LIMIT_BYTES = 5 * 1024 * 1024; // 5 MB
export const LOG_MAX_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB
export const LOG_MAX_FILES = 3;
export const CRDT_MAX_DOC_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

// ============================================================
// File Extension Sets
// ============================================================

export const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".svg",
  ".csv",
  ".log",
  ".canvas",
]);

export const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".mp3",
  ".mp4",
  ".pdf",
  ".zip",
  ".docx",
  ".xlsx",
  ".excalidraw",
]);

// ============================================================
// Event Name Constants
// ============================================================

export const EVENTS = {
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  MESSAGE_RECEIVED: "message-received",
  RECONNECTING: "reconnecting",
  FILE_CREATED: "file-created",
  FILE_MODIFIED: "file-modified",
  FILE_DELETED: "file-deleted",
  FILE_RENAMED: "file-renamed",
  SYNC_PROGRESS: "sync-progress",
  CONFLICT_DETECTED: "conflict-detected",
  SYNC_COMPLETED: "sync-completed",
  DEVICE_DISCOVERED: "device-discovered",
  DEVICE_LOST: "device-lost",
  CRDT_UPDATE_RECEIVED: "crdt-update-received",

  // TLS
  TLS_FALLBACK: "tls-fallback",
  TLS_ERROR: "tls-error",
  CERT_RESET: "cert-reset",
  CERT_FINGERPRINT: "cert-fingerprint",
} as const;
