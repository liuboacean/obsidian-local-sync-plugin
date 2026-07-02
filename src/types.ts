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
}

export enum LogLevel {
  INFO = "INFO",
  SUCCESS = "SUCCESS",
  WARN = "WARN",
  ERROR = "ERROR",
  DEBUG = "DEBUG",
}

export enum SyncEventType {
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
