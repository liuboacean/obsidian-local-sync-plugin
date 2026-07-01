// ============================================================
// Test Setup — Mocks for WebSocket, chokidar, dgram, etc.
// ============================================================

import { vi } from "vitest";

// ============================================================
// Mock os module (for hostname)
// ============================================================

vi.mock("os", () => {
  const actualOs = require("os");
  return {
    ...actualOs,
    hostname: () => "test-machine",
    default: {
      ...actualOs,
      hostname: () => "test-machine",
    },
  };
});

// ============================================================
// Mock crypto.randomUUID (used by protocol.ts)
// ============================================================

if (!globalThis.crypto) {
  (globalThis as any).crypto = {};
}
globalThis.crypto.randomUUID = vi
  .fn()
  .mockReturnValue("00000000-0000-0000-0000-000000000001");

// ============================================================
// Mock WebSocket (ws library)
// ============================================================

vi.mock("ws", () => {
  class MockWebSocket {
    readyState = 1; // OPEN
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;

    send = vi.fn();
    close = vi.fn();
    terminate = vi.fn();
    ping = vi.fn();
    on = vi.fn();
    removeAllListeners = vi.fn();
    addEventListener = vi.fn();

    private handlers: Record<string, Function[]> = {};

    constructor(url?: string) {
      this.on = vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (!this.handlers[event]) {
          this.handlers[event] = [];
        }
        this.handlers[event].push(handler);
        return this;
      });
    }

    _trigger(event: string, ...args: any[]) {
      const handlers = this.handlers[event] || [];
      for (const handler of handlers) {
        handler(...args);
      }
    }
  }

  class MockWebSocketServer {
    on = vi.fn();
    close = vi.fn();
    clients = new Set();

    private handlers: Record<string, Function[]> = {};

    constructor() {
      this.on = vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (!this.handlers[event]) {
          this.handlers[event] = [];
        }
        this.handlers[event].push(handler);
        return this;
      });
    }

    _trigger(event: string, ...args: any[]) {
      const handlers = this.handlers[event] || [];
      for (const handler of handlers) {
        handler(...args);
      }
    }
  }

  return {
    default: MockWebSocket,
    WebSocket: MockWebSocket,
  };
});

// ============================================================
// Mock chokidar
// ============================================================

vi.mock("chokidar", () => {
  const watcher: any = {
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    watch: vi.fn(() => watcher),
    default: { watch: vi.fn(() => watcher) },
  };
});

// ============================================================
// Mock dgram (UDP)
// ============================================================

vi.mock("dgram", () => {
  const socket: any = {
    on: vi.fn().mockReturnThis(),
    bind: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    setBroadcast: vi.fn(),
    addMembership: vi.fn(),
    unref: vi.fn(),
  };
  return {
    createSocket: vi.fn(() => socket),
    default: { createSocket: vi.fn(() => socket) },
  };
});
