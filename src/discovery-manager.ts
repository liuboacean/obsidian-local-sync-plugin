// ============================================================
// UDP Broadcast Discovery Manager
// ============================================================
// Discovers other Obsidian Local Sync devices on the local network
// using UDP broadcast announcements.
//
// Uses Node.js built-in `dgram` module.
// Only operates on private IP ranges: 10.x.x.x, 192.168.x.x, 172.16-31.x.x.

import * as dgram from "dgram";
import * as os from "os";
import { EventEmitter } from "events";
import { DiscoveredDevice } from "./types";
import {
  UDP_DISCOVERY_PORT,
  UDP_DISCOVERY_INTERVAL_MS,
  UDP_DEVICE_TIMEOUT_MS,
  EVENTS,
} from "./constants";
import { syncLogger } from "./sync-logger";
import { LogLevel, SyncEventType } from "./types";

// ============================================================
// Types
// ============================================================

export interface DiscoveryManagerOptions {
  deviceId: string;
  deviceName: string;
  port: number;
  udpDiscoveryPort?: number;
}

interface DiscoveryMessage {
  type: "DISCOVERY_ANNOUNCE" | "DISCOVERY_RESPONSE";
  deviceId: string;
  deviceName: string;
  port: number;
}

// ============================================================
// Private IP Detection
// ============================================================

/**
 * Check if an IP address is on a private network range.
 * Private ranges: 10.x.x.x, 192.168.x.x, 172.16-31.x.x
 */
function isPrivateIp(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const first = parseInt(parts[0], 10);
  const second = parseInt(parts[1], 10);

  if (first === 10) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  return false;
}

/**
 * Get the first private IPv4 address of this machine.
 * Returns null if no private IP is found (e.g., on a public-only network).
 */
function getPrivateIp(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) {
      continue;
    }
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal && isPrivateIp(addr.address)) {
        return addr.address;
      }
    }
  }
  return null;
}

// ============================================================
// Discovery Manager Class
// ============================================================

export class DiscoveryManager extends EventEmitter {
  private deviceId: string;
  private deviceName: string;
  private syncPort: number;
  private udpPort: number;

  private socket: dgram.Socket | null = null;
  private broadcastTimer: number | null = null;
  private cleanupTimer: number | null = null;
  private _warnTimeout: number | null = null;
  private running = false;

  /** Map of discovered devices. */
  private devices: Map<string, DiscoveredDevice> = new Map();

  constructor(options: DiscoveryManagerOptions) {
    super();
    this.deviceId = options.deviceId;
    this.deviceName = options.deviceName;
    this.syncPort = options.port;
    this.udpPort = options.udpDiscoveryPort || UDP_DISCOVERY_PORT;

    this.setMaxListeners(20);
  }

  // ============================================================
  // Public API
  // ============================================================

  /**
   * Start the UDP discovery service.
   * Creates a UDP socket, binds to the discovery port, and begins
   * broadcasting presence announcements.
   */
  startDiscovery(port?: number): void {
    if (this.running) {
      return;
    }

    const bindPort = port ?? this.udpPort;
    this.running = true;

    try {
      this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

      this.socket.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        this.handleDiscoveryMessage(msg, rinfo);
      });

      this.socket.on("error", (err: Error) => {
        syncLogger.log(
          LogLevel.ERROR,
          `UDP 发现出错：${err.message}`,
          undefined,
          SyncEventType.ERROR,
        );
      });

      this.socket.on("listening", () => {
        if (this.socket) {
          try {
            this.socket.setBroadcast(true);
          } catch {
            // May fail on some systems; non-critical
          }
          syncLogger.log(
            LogLevel.INFO,
            `UDP 发现正在监听端口 ${bindPort}`,
            undefined,
            SyncEventType.SYNC_STARTED,
          );
        }
      });

      this.socket.bind(bindPort, () => {
        // Start broadcasting presence
        this.startBroadcasting();
        this.startCleanupTimer();

        // Timeout warning: if no devices found after 30s, suggest manual connection
        this._warnTimeout = window.setTimeout(() => {
          if (this.devices.size === 0) {
            syncLogger.log(
              LogLevel.WARN,
              "UDP 发现：30 秒后此子网未找到设备。若设备在其他子网，请在设置中使用手动 IP 连接。",
              undefined,
              SyncEventType.ERROR,
            );
          }
        }, 30000);
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      syncLogger.log(
        LogLevel.ERROR,
        `启动 UDP 发现失败：${errorMessage}`,
        undefined,
        SyncEventType.ERROR,
      );
      this.running = false;
    }
  }

  /**
   * Stop the UDP discovery service.
   * Closes the socket and clears all timers.
   */
  stopDiscovery(): void {
    this.running = false;

    this.stopBroadcasting();
    this.stopCleanupTimer();

    if (this._warnTimeout) {
      window.clearTimeout(this._warnTimeout);
      this._warnTimeout = null;
    }

    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Already closed
      }
      this.socket = null;
    }

    syncLogger.log(
      LogLevel.INFO,
      "UDP 发现已停止",
      undefined,
      SyncEventType.DISCONNECTED,
    );
  }

  /**
   * Get the list of all discovered devices.
   */
  getDiscoveredDevices(): DiscoveredDevice[] {
    return Array.from(this.devices.values());
  }

  /**
   * Get a specific discovered device by ID.
   */
  getDevice(deviceId: string): DiscoveredDevice | undefined {
    return this.devices.get(deviceId);
  }

  /**
   * Check if the discovery service is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // ============================================================
  // Broadcasting
  // ============================================================

  /**
   * Send a DISCOVERY_ANNOUNCE broadcast message.
   */
  broadcastPresence(): void {
    if (!this.socket || !this.running) {
      return;
    }

    const privateIp = getPrivateIp();
    if (!privateIp) {
      return;
    }

    const message: DiscoveryMessage = {
      type: "DISCOVERY_ANNOUNCE",
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      port: this.syncPort,
    };

    const payload = Buffer.from(JSON.stringify(message));

    try {
      // Broadcast to the entire subnet
      this.socket.send(payload, 0, payload.length, this.udpPort, "255.255.255.255");
    } catch {
      // Broadcast may fail on some networks; non-critical
    }
  }

  /**
   * Send a DISCOVERY_RESPONSE back to a specific address.
   */
  private sendDiscoveryResponse(targetIp: string, targetPort: number): void {
    if (!this.socket || !this.running) {
      return;
    }

    const message: DiscoveryMessage = {
      type: "DISCOVERY_RESPONSE",
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      port: this.syncPort,
    };

    const payload = Buffer.from(JSON.stringify(message));

    try {
      this.socket.send(payload, 0, payload.length, targetPort, targetIp);
    } catch {
      // Non-critical
    }
  }

  // ============================================================
  // Message Handling
  // ============================================================

  /**
   * Handle an incoming UDP discovery message.
   */
  private handleDiscoveryMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    let parsed: DiscoveryMessage;
    try {
      parsed = JSON.parse(msg.toString("utf-8")) as DiscoveryMessage;
    } catch {
      // Malformed message; ignore
      return;
    }

    // Validate required fields
    if (
      !parsed.deviceId ||
      !parsed.deviceName ||
      typeof parsed.port !== "number"
    ) {
      return;
    }

    // Self-filter: skip our own announcements
    if (parsed.deviceId === this.deviceId) {
      return;
    }

    // Only accept from private IPs
    if (!isPrivateIp(rinfo.address)) {
      return;
    }

    const now = Date.now();

    // Update or add the device
    const existing = this.devices.get(parsed.deviceId);
    if (existing) {
      existing.lastSeen = now;
      existing.ip = rinfo.address;
      existing.port = parsed.port;
      existing.status = "online";
    } else {
      const device: DiscoveredDevice = {
        deviceId: parsed.deviceId,
        deviceName: parsed.deviceName,
        ip: rinfo.address,
        port: parsed.port,
        firstSeen: now,
        lastSeen: now,
        status: "online",
        source: "udp",
      };
      this.devices.set(parsed.deviceId, device);

      syncLogger.log(
        LogLevel.SUCCESS,
        `已发现设备: ${parsed.deviceName} (${parsed.deviceId}) at ${rinfo.address}:${parsed.port}`,
        undefined,
        SyncEventType.DEVICE_DISCOVERED,
      );

      this.emit(EVENTS.DEVICE_DISCOVERED, device);
    }

    // If this is an ANNOUNCE, respond with our presence
    if (parsed.type === "DISCOVERY_ANNOUNCE") {
      this.sendDiscoveryResponse(rinfo.address, rinfo.port);
    }
  }

  // ============================================================
  // Timers
  // ============================================================

  /**
   * Start broadcasting presence announcements at regular intervals.
   */
  private startBroadcasting(): void {
    this.stopBroadcasting();

    // Broadcast immediately on start
    this.broadcastPresence();

    this.broadcastTimer = window.setInterval(() => {
      this.broadcastPresence();
    }, UDP_DISCOVERY_INTERVAL_MS);
  }

  /**
   * Stop the broadcast timer.
   */
  private stopBroadcasting(): void {
    if (this.broadcastTimer) {
      window.clearInterval(this.broadcastTimer);
      this.broadcastTimer = null;
    }
  }

  /**
   * Start the device cleanup timer.
   * Marks devices as offline if they haven't been seen recently.
   */
  private startCleanupTimer(): void {
    this.stopCleanupTimer();

    this.cleanupTimer = window.setInterval(() => {
      this.cleanupStaleDevices();
    }, UDP_DEVICE_TIMEOUT_MS / 2);
  }

  /**
   * Stop the cleanup timer.
   */
  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      window.clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Mark devices as offline if they haven't announced within the timeout window.
   */
  private cleanupStaleDevices(): void {
    const now = Date.now();
    const timeout = UDP_DEVICE_TIMEOUT_MS;

    for (const [deviceId, device] of this.devices.entries()) {
      if (device.status === "online" && now - device.lastSeen > timeout) {
        device.status = "offline";

        syncLogger.log(
          LogLevel.WARN,
          `设备已丢失: ${device.deviceName} (${deviceId})`,
          undefined,
          SyncEventType.DEVICE_LOST,
        );

        this.emit(EVENTS.DEVICE_LOST, device);
      }
    }
  }
}
