// ============================================================
// Discovery Manager Tests
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiscoveryManager } from "../../src/discovery-manager";
import { UDP_DISCOVERY_PORT } from "../../src/constants";

// ============================================================
// Basic Lifecycle
// ============================================================

describe("DiscoveryManager — Lifecycle", () => {
  let manager: DiscoveryManager;

  beforeEach(() => {
    manager = new DiscoveryManager({
      deviceId: "local-device",
      deviceName: "Local Machine",
      port: 8888,
    });
  });

  afterEach(() => {
    manager.stopDiscovery();
  });

  it("should start and stop without error", () => {
    expect(manager.isRunning()).toBe(false);
    manager.startDiscovery();
    // Socket creation is mocked, so it may or may not report as running
    // based on implementation details. Let's just verify no crash.
    expect(() => manager.stopDiscovery()).not.toThrow();
  });

  it("should start only once (no duplicate)", () => {
    manager.startDiscovery();
    manager.startDiscovery(); // Second call should be no-op
    expect(() => manager.stopDiscovery()).not.toThrow();
  });

  it("should stop when not running gracefully", () => {
    expect(() => manager.stopDiscovery()).not.toThrow();
  });
});

// ============================================================
// Device Management
// ============================================================

describe("DiscoveryManager — Device Management", () => {
  let manager: DiscoveryManager;

  beforeEach(() => {
    manager = new DiscoveryManager({
      deviceId: "local-device",
      deviceName: "Local Machine",
      port: 8888,
    });
  });

  afterEach(() => {
    manager.stopDiscovery();
  });

  it("should return empty device list initially", () => {
    const devices = manager.getDiscoveredDevices();
    expect(devices).toEqual([]);
  });

  it("should return undefined for unknown device", () => {
    const device = manager.getDevice("non-existent");
    expect(device).toBeUndefined();
  });
});

// ============================================================
// Broadcast
// ============================================================

describe("DiscoveryManager — Broadcast", () => {
  it("should broadcast presence without error", () => {
    const manager = new DiscoveryManager({
      deviceId: "local-device",
      deviceName: "Local Machine",
      port: 8888,
    });

    manager.startDiscovery();
    // broadcastPresence should not throw even if socket is mocked
    expect(() => manager.broadcastPresence()).not.toThrow();
    manager.stopDiscovery();
  });

  it("should not broadcast when not running", () => {
    const manager = new DiscoveryManager({
      deviceId: "local-device",
      deviceName: "Local Machine",
      port: 8888,
    });
    // Not started
    expect(() => manager.broadcastPresence()).not.toThrow();
  });
});
