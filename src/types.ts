// ============================================================
// Enums
// ============================================================

export enum SyncStatus {
  SYNCED = "SYNCED",
  PENDING = "PENDING",
  CONFLICTED = "CONFLICTED",
  SYNCING = "SYNCING",
  FAILED = "FAILED",
}

export enum ChangeType {
  CREATE = "CREATE",
  MODIFY = "MODIFY",
  DELETE = "DELETE",
  RENAME = "RENAME",
}

export enum ConflictStatus {
  UNRESOLVED = "UNRESOLVED",
  KEEP_LOCAL = "KEEP_LOCAL",
  KEEP_REMOTE = "KEEP_REMOTE",
  KEEP_BOTH = "KEEP_BOTH",
}

export enum MessageType {
  HANDSHAKE = "HANDSHAKE",
  HANDSHAKE_ACK = "HANDSHAKE_ACK",
  FILE_CHANGE = "FILE_CHANGE",
  FILE_CHANGE_ACK = "FILE_CHANGE_ACK",
  FILE_DELETE = "FILE_DELETE",
  FILE_REQUEST = "FILE_REQUEST",
  FILE_RESPONSE = "FILE_RESPONSE",
  CONFLICT_NOTIFY = "CONFLICT_NOTIFY",
  CONFLICT_RESOLVE = "CONFLICT_RESOLVE",
  SYNC_STATUS = "SYNC_STATUS",
  HEARTBEAT = "HEARTBEAT",
  FILE_LIST_BATCH = "FILE_LIST_BATCH",
  FILE_LIST_ACK = "FILE_LIST_ACK",
  CRDT_UPDATE = "CRDT_UPDATE",
  CRDT_SYNC_FULL = "CRDT_SYNC_FULL",
  DISCOVERY_ANNOUNCE = "DISCOVERY_ANNOUNCE",
  DISCOVERY_RESPONSE = "DISCOVERY_RESPONSE",
  // TLS
  CERT_FINGERPRINT = "CERT_FINGERPRINT",
  CERT_FINGERPRINT_ACK = "CERT_FINGERPRINT_ACK",
  TLS_FALLBACK_NOTIFY = "TLS_FALLBACK_NOTIFY",
}

export enum LogLevel {
  INFO = "INFO",
  SUCCESS = "SUCCESS",
  WARN = "WARN",
  ERROR = "ERROR",
  DEBUG = "DEBUG",
}

export enum SyncEventType {
  INFO = "INFO",
  FILE_PUSHED = "FILE_PUSHED",
  FILE_RECEIVED = "FILE_RECEIVED",
  CONFLICT_DETECTED = "CONFLICT_DETECTED",
  CONFLICT_RESOLVED = "CONFLICT_RESOLVED",
  CONNECTED = "CONNECTED",
  DISCONNECTED = "DISCONNECTED",
  SYNC_STARTED = "SYNC_STARTED",
  SYNC_COMPLETED = "SYNC_COMPLETED",
  ERROR = "ERROR",
  DEVICE_DISCOVERED = "DEVICE_DISCOVERED",
  DEVICE_LOST = "DEVICE_LOST",
  CRDT_MERGED = "CRDT_MERGED",
}

export enum SyncMode {
  SERVER = "SERVER",
  CLIENT = "CLIENT",
  DUPLEX = "DUPLEX",
}

export enum SyncDirection {
  BIDIRECTIONAL = "BIDIRECTIONAL",
  UPLOAD_ONLY = "UPLOAD_ONLY",
  DOWNLOAD_ONLY = "DOWNLOAD_ONLY",
}

export enum ConflictStrategy {
  ALWAYS_ASK = "ALWAYS_ASK",
  KEEP_LATEST = "KEEP_LATEST",
  KEEP_LOCAL = "KEEP_LOCAL",
}

export enum FileCategory {
  TEXT = "TEXT",
  BINARY = "BINARY",
}

export enum AuthStatus {
  PENDING = "PENDING",
  CHALLENGED = "CHALLENGED",
  AUTHENTICATED = "AUTHENTICATED",
  FAILED = "FAILED",
  LOCKED = "LOCKED",
}

// ============================================================
// Type Aliases
// ============================================================

export type ConflictType =
  | "MODIFY_VS_MODIFY"
  | "DELETE_VS_MODIFY"
  | "RENAME_VS_RENAME"
  | "DELETE_VS_DELETE";

// ============================================================
// Interfaces
// ============================================================

export interface SyncFileState {
  relativePath: string;
  localMtime: number;
  localHash: string;
  remoteMtime: number;
  remoteHash: string;
  status: SyncStatus;
  pendingOperation?: string;
  version: number;
  lastPushedAt: number;
  fileCategory: FileCategory;
  crdtDocId?: string;
}

export interface FileChange {
  type: ChangeType;
  relativePath: string;
  content?: string;
  mtime: number;
  hash: string;
  originDeviceId: string;
  version: number;
  fileCategory: FileCategory;
  size: number;
}

export interface ConflictInfo {
  relativePath: string;
  localVersion: FileChange;
  remoteVersion: FileChange;
  status: ConflictStatus;
  detectedAt: number;
  conflictType: ConflictType;
}

export interface SyncMessage {
  uuid: string;
  type: MessageType;
  deviceId: string;
  deviceName: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface SyncStats {
  pendingFiles: number;
  syncedFiles: number;
  vaultFileCount: number;
  conflictedFiles: number;
  failedFiles: number;
  totalBytes: number;
  transferredBytes: number;
  lastSyncTime?: string;
}

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  filePath?: string;
  eventType: SyncEventType;
}

export interface SyncSettings {
  mode: SyncMode;
  port: number;
  targetAddress: string;
  deviceName: string;
  deviceId?: string;
  ignoreFolders: string[];
  ignoreExtensions: string[];
  direction: SyncDirection;
  conflictStrategy: ConflictStrategy;
  syncObsidianConfig: boolean;
  sharedKey?: string;
  enableUdpDiscovery: boolean;
  udpDiscoveryPort: number;
  crdtEnabled: boolean;
  textExtensions: string[];
  // TLS
  enableTls?: boolean;
  allowTlsFallback?: boolean;
  trustedFingerprints?: string[];

  // Diff Preview Before Sync (v1.2.0)
  enableDiffPreview?: boolean;
  diffPreviewWhitelistFolders?: string[];
}

export interface DiscoveredDevice {
  deviceId: string;
  deviceName: string;
  ip: string;
  port: number;
  firstSeen: number;
  lastSeen: number;
  status: "online" | "offline";
  source: "udp" | "manual";
}

export interface CrdtSyncState {
  docId: string;
  relativePath: string;
  lastSnapshotTime: number;
  lastUpdateTime: number;
  isDirty: boolean;
  docSize: number;
}

export interface QRDeviceInfo {
  deviceId: string;
  deviceName: string;
  ip: string;
  port: number;
  pskPrefix: string;
  timestamp: number;
}

// ============================================================
// TLS Message Interfaces
// ============================================================

export interface CertFingerprintMessage {
  type: string;
  fingerprint: string;
  algorithm: string;
  deviceId: string;
}

export interface CertFingerprintAckMessage {
  type: string;
  accepted: boolean;
  deviceId: string;
}

export interface CertInfo {
  fingerprint: string;
  algorithm: string;
  issuedAt: Date;
  expiresAt: Date;
  serialNumber: string;
  isExpired: boolean;
}

// ============================================================
// Sync History Viewer Types (Feature 1)
// ============================================================

/**
 * A single parsed sync-history log entry that is rendered in the
 * settings-page "同步历史" panel. Extends the on-disk log format with a
 * derived `icon` (✅/⚠️/⏭/❌/ℹ️) and a UI `expanded` flag.
 */
export interface SyncHistoryEntry {
  /** Self-incrementing unique id (used for expand/select state). */
  id: number;
  /** Unix epoch milliseconds. */
  timestamp: number;
  level: LogLevel;
  message: string;
  filePath?: string;
  eventType: SyncEventType;
  /** Derived glyph: ✅ / ⚠️ / ⏭ / ❌ (or ℹ️ fallback). */
  icon: string;
  /** Front-end state: whether the detail row is expanded. */
  expanded: boolean;
}

/**
 * Filter criteria applied to the loaded sync-history entries.
 */
export interface SyncHistoryFilters {
  /** Substring match against filePath (case-insensitive). */
  filePathFilter?: string;
  /** Start of time range (Unix ms, inclusive). */
  fromTimestamp?: number;
  /** End of time range (Unix ms, inclusive). */
  toTimestamp?: number;
  /** Restrict to specific log levels. */
  levels?: LogLevel[];
  /** Restrict to specific event types. */
  eventTypes?: SyncEventType[];
}

/**
 * Aggregated statistics for the sync-history panel header card.
 */
export interface SyncHistoryStats {
  totalEntries: number;
  /** Count of ✅ entries. */
  successCount: number;
  /** Count of ⚠️ entries. */
  warnCount: number;
  /** Count of ⏭ entries. */
  skipCount: number;
  /** Count of ❌ entries. */
  errorCount: number;
  /** Count of FILE_PUSHED events. */
  filePushCount: number;
  /** Count of FILE_RECEIVED events. */
  fileReceiveCount: number;
  /** Count of CONFLICT_DETECTED events. */
  conflictCount: number;
}

// ============================================================
// Diff Preview Before Sync Types (Feature 2)
// ============================================================

/**
 * User decision produced by the Diff Preview modal.
 */
export enum DiffPreviewAction {
  CONFIRM = "CONFIRM",
  SKIP = "SKIP",
  CONFIRM_ALL = "CONFIRM_ALL",
}

/**
 * Configuration snapshot for the Diff Preview feature.
 * (Mirror of the relevant SyncSettings fields; kept as a standalone
 * interface so the service does not depend on the whole SyncSettings shape.)
 */
export interface DiffPreviewSettings {
  enabled: boolean;
  /** Folders that trigger the preview. Empty array = all folders. */
  whitelistFolders: string[];
  /** Auto-confirm timeout in milliseconds (default 30000). */
  timeoutMs: number;
}

/**
 * Binary file metadata used for non-text (meta-only) comparison.
 */
export interface BinaryMeta {
  size: number;
  hash: string;
  mtime: number;
}

/**
 * A single pending diff-preview request awaiting a user decision.
 * `resolve`/`reject` are supplied by DiffPreviewService and must be
 * invoked exactly once when the request is settled.
 */
export interface DiffPreviewRequest {
  requestId: string;
  change: FileChange;
  /** TEXT file: previous (baseline) content for the diff. */
  currentContent?: string;
  /** TEXT file: new content about to be sent. */
  newContent?: string;
  /** BINARY file: previous (baseline) metadata. */
  currentMeta?: BinaryMeta;
  /** BINARY file: new metadata about to be sent. */
  newMeta?: BinaryMeta;
  createdAt: Date;
  resolve: (result: DiffPreviewResult) => void;
  reject: (error: Error) => void;
}

/**
 * The result of a settled diff-preview request.
 */
export interface DiffPreviewResult {
  requestId: string;
  action: DiffPreviewAction;
  /** P2: partial content when only specific lines are selected. */
  selectedContent?: string;
}

/**
 * A hook invoked by SyncEngine before a local change is transmitted.
 * Returning `true` allows the send; returning `false` skips it.
 */
export interface BeforeSendHook {
  name: string;
  handler: (change: FileChange, vaultPath: string) => Promise<boolean>;
}
