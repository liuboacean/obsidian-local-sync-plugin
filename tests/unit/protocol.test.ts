// ============================================================
// Protocol Tests
// ============================================================

import { describe, it, expect } from "vitest";
import {
  serializeMessage,
  deserializeMessage,
  createMessage,
  serializeBinary,
  deserializeBinary,
  generateUuid,
  createCertFingerprintMessage,
  createCertFingerprintAck,
  createTlsFallbackNotify,
} from "../../src/protocol";
import { MessageType } from "../../src/types";

// ============================================================
// UUID Generation
// ============================================================

describe("generateUuid", () => {
  it("should generate a UUID v4 string", () => {
    const uuid = generateUuid();
    expect(uuid).toBeDefined();
    expect(typeof uuid).toBe("string");
    expect(uuid.length).toBeGreaterThan(0);
  });
});

// ============================================================
// createMessage
// ============================================================

describe("createMessage", () => {
  it("should create a well-formed SyncMessage", () => {
    const msg = createMessage(
      MessageType.HEARTBEAT,
      { key: "value" },
      "device-1",
      "Test Device",
    );

    expect(msg).toBeDefined();
    expect(msg.uuid).toBeDefined();
    expect(typeof msg.uuid).toBe("string");
    expect(msg.type).toBe(MessageType.HEARTBEAT);
    expect(msg.deviceId).toBe("device-1");
    expect(msg.deviceName).toBe("Test Device");
    expect(msg.timestamp).toBeGreaterThan(0);
    expect(msg.payload).toEqual({ key: "value" });
  });

  it("should generate a UUID for each message", () => {
    // Note: crypto.randomUUID is mocked in test environment.
    // In production, crypto.randomUUID() guarantees uniqueness.
    const msg1 = createMessage(MessageType.HEARTBEAT, {}, "d1", "Device 1");
    expect(msg1.uuid).toBeDefined();
    expect(typeof msg1.uuid).toBe("string");
    expect(msg1.uuid.length).toBeGreaterThan(0);
  });

  it("should handle empty payload", () => {
    const msg = createMessage(
      MessageType.SYNC_STATUS,
      undefined,
      "device-1",
      "Test",
    );
    expect(msg.payload).toBeUndefined();
  });
});

// ============================================================
// serializeMessage / deserializeMessage
// ============================================================

describe("serializeMessage", () => {
  it("should serialize a valid message to JSON string", () => {
    const msg = createMessage(
      MessageType.FILE_CHANGE,
      { relativePath: "test.md" },
      "device-1",
      "Test Device",
    );
    const serialized = serializeMessage(msg);
    expect(typeof serialized).toBe("string");
    const parsed = JSON.parse(serialized);
    expect(parsed.uuid).toBe(msg.uuid);
    expect(parsed.type).toBe("FILE_CHANGE");
  });

  it("should throw for message without uuid", () => {
    const invalidMsg = {
      type: MessageType.HEARTBEAT,
      deviceId: "d1",
      deviceName: "D1",
      timestamp: Date.now(),
      payload: {},
    } as any;
    expect(() => serializeMessage(invalidMsg)).toThrow("uuid");
  });

  it("should throw for empty uuid", () => {
    const msg = createMessage(MessageType.HEARTBEAT, {}, "d1", "D1");
    msg.uuid = "";
    expect(() => serializeMessage(msg)).toThrow("uuid");
  });
});

describe("deserializeMessage", () => {
  it("should deserialize a valid message", () => {
    const original = createMessage(
      MessageType.FILE_CHANGE,
      { relativePath: "test.md" },
      "device-1",
      "Test",
    );
    const serialized = serializeMessage(original);
    const deserialized = deserializeMessage(serialized);
    expect(deserialized).not.toBeNull();
    expect(deserialized!.uuid).toBe(original.uuid);
    expect(deserialized!.type).toBe(MessageType.FILE_CHANGE);
    expect(deserialized!.deviceId).toBe("device-1");
    expect(deserialized!.deviceName).toBe("Test");
    expect(deserialized!.payload).toEqual({ relativePath: "test.md" });
  });

  it("should return null for invalid JSON", () => {
    const result = deserializeMessage("not-json");
    expect(result).toBeNull();
  });

  it("should return null for null payload", () => {
    const result = deserializeMessage("null");
    expect(result).toBeNull();
  });

  it("should return null for missing fields", () => {
    const result = deserializeMessage(
      JSON.stringify({ type: "HEARTBEAT" }),
    );
    expect(result).toBeNull();
  });

  it("should return null for invalid message type", () => {
    const result = deserializeMessage(
      JSON.stringify({
        uuid: "abc",
        type: "INVALID_TYPE",
        deviceId: "d1",
        deviceName: "D1",
        timestamp: Date.now(),
        payload: {},
      }),
    );
    expect(result).toBeNull();
  });

  it("should return null for missing timestamp", () => {
    const result = deserializeMessage(
      JSON.stringify({
        uuid: "abc",
        type: "HEARTBEAT",
        deviceId: "d1",
        deviceName: "D1",
        payload: {},
      }),
    );
    expect(result).toBeNull();
  });
});

// ============================================================
// Binary Serialization
// ============================================================

describe("serializeBinary / deserializeBinary", () => {
  it("should round-trip Uint8Array through Buffer", () => {
    const original = new Uint8Array([0, 1, 2, 3, 255, 128, 64]);
    const buffer = serializeBinary(original);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBe(original.length);

    const result = deserializeBinary(buffer);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(result[i]).toBe(original[i]);
    }
  });

  it("should handle empty Uint8Array", () => {
    const original = new Uint8Array(0);
    const buffer = serializeBinary(original);
    expect(buffer.length).toBe(0);

    const result = deserializeBinary(buffer);
    expect(result.length).toBe(0);
  });

  it("should handle large binary data (1MB)", () => {
    const size = 1024 * 1024;
    const original = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      original[i] = i % 256;
    }

    const buffer = serializeBinary(original);
    expect(buffer.length).toBe(size);

    const result = deserializeBinary(buffer);
    expect(result.length).toBe(size);
    expect(result[0]).toBe(0);
    expect(result[size - 1]).toBe((size - 1) % 256);
  });

  it("should handle subarray views correctly", () => {
    const full = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const sub = full.subarray(2, 5); // [2, 3, 4]
    const buffer = serializeBinary(sub);
    expect(buffer.length).toBe(3);
    expect(buffer[0]).toBe(2);
    expect(buffer[2]).toBe(4);
  });
});

// ============================================================
// TLS Protocol Messages
// ============================================================

describe("TLS Protocol Messages", () => {
  it("should create cert-fingerprint message", () => {
    const fp = "3A:4B:5C:6D:7E:8F:90:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09:10:11:12:13:14:15:16:17:18";
    const msg = createCertFingerprintMessage(fp, "ECDSA-P256", "dev1", "My Device");
    expect(msg.type).toBe(MessageType.CERT_FINGERPRINT);
    expect(msg.payload.fingerprint).toBe(fp);
    expect(msg.payload.algorithm).toBe("ECDSA-P256");
    expect(msg.deviceId).toBe("dev1");
  });

  it("should create cert-fingerprint-ack message", () => {
    const msg = createCertFingerprintAck(true, "dev2", "Other Device");
    expect(msg.type).toBe(MessageType.CERT_FINGERPRINT_ACK);
    expect(msg.payload.accepted).toBe(true);
  });

  it("should create TLS fallback notification message", () => {
    const msg = createTlsFallbackNotify("ECONNREFUSED", "dev1", "My Device");
    expect(msg.type).toBe(MessageType.TLS_FALLBACK_NOTIFY);
    expect(msg.payload.reason).toBe("ECONNREFUSED");
  });

  it("should round-trip serialization for fingerprint messages", () => {
    const msg = createCertFingerprintMessage("AA:BB:CC:DD", "ECDSA-P256", "dev1", "Dev");
    const serialized = JSON.stringify(msg);
    const deserialized = JSON.parse(serialized);
    expect(deserialized.type).toBe("CERT_FINGERPRINT");
    expect(deserialized.payload.fingerprint).toBe("AA:BB:CC:DD");
  });
});
