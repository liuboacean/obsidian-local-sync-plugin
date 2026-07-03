// ============================================================
// WebSocket Message Protocol
// ============================================================
// Provides serialization, deserialization, and message creation
// for the Obsidian Local Sync WebSocket communication layer.

import * as crypto from "crypto";
import { MessageType, SyncMessage } from "./types";

// ============================================================
// UUID Generation
// ============================================================

/**
 * Generate a RFC 4122 v4 UUID.
 * Uses crypto.randomUUID() available in Node.js 19+ / modern Electron.
 */
export function generateUuid(): string {
  return crypto.randomUUID();
}

// ============================================================
// Validation Helpers
// ============================================================

/**
 * Validate that a value is a non-empty string.
 */
function isNonEmptyString(val: unknown): val is string {
  return typeof val === "string" && val.length > 0;
}

/**
 * Validate that a value is a valid MessageType enum member.
 */
function isValidMessageType(val: unknown): val is MessageType {
  return Object.values(MessageType).includes(val as MessageType);
}

/**
 * Validate that a parsed object conforms to the SyncMessage shape.
 */
function isValidSyncMessage(obj: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(obj.uuid) &&
    isValidMessageType(obj.type) &&
    isNonEmptyString(obj.deviceId) &&
    isNonEmptyString(obj.deviceName) &&
    typeof obj.timestamp === "number" &&
    obj.timestamp > 0 &&
    "payload" in obj
  );
}

// ============================================================
// Public API
// ============================================================

/**
 * Serialize a SyncMessage to a JSON string.
 * Throws if the message does not contain a valid uuid.
 */
export function serializeMessage(msg: SyncMessage): string {
  if (!msg.uuid || typeof msg.uuid !== "string" || msg.uuid.length === 0) {
    throw new Error("serializeMessage: message must have a valid uuid");
  }
  return JSON.stringify(msg);
}

/**
 * Deserialize a JSON string into a SyncMessage.
 * Returns null if parsing fails or the result does not pass type validation.
 */
export function deserializeMessage(data: string): SyncMessage | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    if (isValidSyncMessage(parsed)) {
        return parsed as unknown as SyncMessage;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Factory method to create a well-formed SyncMessage.
 * Automatically generates a uuid via crypto.randomUUID() and sets the timestamp.
 */
export function createMessage(
  type: MessageType,
  payload: Record<string, unknown>,
  deviceId: string,
  deviceName: string,
): SyncMessage {
  return {
    uuid: generateUuid(),
    type,
    deviceId,
    deviceName,
    timestamp: Date.now(),
    payload,
  };
}

/**
 * Serialize a Uint8Array payload into a Node.js Buffer for binary transmission.
 * Used for CRDT binary frames and large file chunks.
 */
export function serializeBinary(payload: Uint8Array): Buffer {
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
}

/**
 * Deserialize a Node.js Buffer back into a Uint8Array.
 * Used for receiving CRDT binary frames and large file chunks.
 */
export function deserializeBinary(data: Buffer): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

// ============================================================
// TLS Message Factory Functions
// ============================================================

/**
 * Create a cert-fingerprint message for TLS PIN verification.
 */
export function createCertFingerprintMessage(
  fingerprint: string,
  algorithm: string,
  deviceId: string,
  deviceName: string,
): SyncMessage {
  return createMessage(
    "CERT_FINGERPRINT" as unknown as MessageType,
    { fingerprint, algorithm },
    deviceId,
    deviceName,
  );
}

/**
 * Create a cert-fingerprint-ack message.
 */
export function createCertFingerprintAck(
  accepted: boolean,
  deviceId: string,
  deviceName: string,
): SyncMessage {
  return createMessage(
    "CERT_FINGERPRINT_ACK" as unknown as MessageType,
    { accepted },
    deviceId,
    deviceName,
  );
}

/**
 * Create a TLS fallback notification message.
 */
export function createTlsFallbackNotify(
  reason: string,
  deviceId: string,
  deviceName: string,
): SyncMessage {
  return createMessage(
    "TLS_FALLBACK_NOTIFY" as unknown as MessageType,
    { reason },
    deviceId,
    deviceName,
  );
}
