// ============================================================
// WebSocket Connection Manager
// ============================================================
// Manages WebSocket server and client connections for the
// Obsidian Local Sync plugin. Supports SERVER, CLIENT, and
// DUPLEX modes with PSK authentication, heartbeat, and
// automatic reconnection with exponential backoff.

import { EventEmitter } from "events";
// ws via local CJS shim — avoids ESM wrapper.mjs issues
import WebSocket from "./ws";
import * as http from "http";
import * as https from "https";
import type { TlsOptions } from "./cert-manager";
import {
  MessageType,
  SyncMessage,
  SyncMode,
} from "./types";
import {
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  EVENTS,
} from "./constants";
import { serializeMessage, deserializeMessage, createMessage } from "./protocol";
import { AuthSession, createAuthSession, computeExpectedResponse } from "./auth-handshake";
import { debugLog, syncLogger } from "./sync-logger";
import { LogLevel, SyncEventType } from "./types";

// ============================================================
// Types
// ============================================================

export interface ConnectionManagerOptions {
  mode: SyncMode;
  port: number;
  targetAddress: string;
  deviceId: string;
  deviceName: string;
  sharedKey?: string;
  enableTls?: boolean;
  tlsOptions?: TlsOptions | null;
  allowTlsFallback?: boolean;
}

// ============================================================
// Connection Manager Class
// ============================================================

export class ConnectionManager extends EventEmitter {
  private mode: SyncMode;
  private port: number;
  private targetAddress: string;
  private deviceId: string;
  private deviceName: string;
  private sharedKey: string;

  private enableTls: boolean;
  private tlsOptions: TlsOptions | null;
  private allowTlsFallback: boolean;
  private trustedFingerprints: string[] = [];

  private server: WebSocket.Server | null = null;
  private clientSocket: WebSocket | null = null;
  private serverSocket: WebSocket | null = null;
  private activeSocket: WebSocket | null = null;
  private httpServer: http.Server | https.Server | null = null;

  private authSession: AuthSession | null = null;
  private isConnected = false;
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private heartbeatTimeoutTimer: number | null = null;

  /** Map of processed message UUIDs for deduplication. */
  private processedMessages: Map<string, boolean> = new Map();

  /** Time-to-live for dedup entries (ms). Cleared periodically. */
  private readonly DEDUP_TTL_MS = 60000;

  /** Timeout for pong response (ms). */
  private readonly HEARTBEAT_TIMEOUT_MS = 60000;

  constructor(options: ConnectionManagerOptions) {
    super();
    this.mode = options.mode;
    this.port = options.port;
    this.targetAddress = options.targetAddress;
    this.deviceId = options.deviceId;
    this.deviceName = options.deviceName;
    this.sharedKey = options.sharedKey || "";
    this.enableTls = options.enableTls ?? false;
    this.tlsOptions = options.tlsOptions || null;
    this.allowTlsFallback = options.allowTlsFallback ?? true;

    this.setMaxListeners(20);
  }

  // ============================================================
  // Connection State
  // ============================================================

  /**
   * Check if the connection is currently active.
   */
  getIsConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Update the target address for client connections.
   * Called when the user changes the target address in settings.
   */
  setTargetAddress(address: string): void {
    this.targetAddress = address;
  }

  /**
   * Get the currently active WebSocket instance.
   */
  getActiveSocket(): WebSocket | null {
    return this.activeSocket;
  }

  /**
   * Get the current connection mode.
   */
  getMode(): SyncMode {
    return this.mode;
  }

  // ============================================================
  // Start / Stop
  // ============================================================

  /**
   * Start the connection manager based on the configured mode.
   *
   * - SERVER: Start a WebSocket server and wait for incoming connections.
   * - CLIENT: Connect to a remote WebSocket server.
   * - DUPLEX: Start a server AND attempt to connect as a client.
   *           The first active connection wins; the redundant side disconnects.
   */
  async start(): Promise<void> {
    this.shouldReconnect = true;
    this.isConnected = false;

    syncLogger.log(
      LogLevel.INFO,
      `连接管理器启动（${this.mode} 模式，端口 ${this.port}`,
      undefined,
      SyncEventType.SYNC_STARTED,
    );

    if (this.mode === SyncMode.SERVER || this.mode === SyncMode.DUPLEX) {
      // Server may already be running from auto-start in onload()
      // Avoid EADDRINUSE by checking before starting again
      if (!this.server) {
        await this.startServer();
      } else {
        debugLog("[ObsSync] 服务已在运行，跳过重复启动");
      }
    }

    if (this.mode === SyncMode.CLIENT || this.mode === SyncMode.DUPLEX) {
      // Don't start client connection if target address is not set
      if (!this.targetAddress) {
        debugLog("[ObsSync] 未配置目标地址，跳过客户端连接");
        return;
      }
      this.startClientConnection();
    }
  }

  /**
   * Stop the connection manager.
   * Closes all sockets, stops timers, and resets state.
   */
  stop(): void {
    this.shouldReconnect = false;
    this.isConnected = false;

    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.closeSockets();
    this.closeHttpServer();
    this.processedMessages.clear();

    syncLogger.log(
      LogLevel.INFO,
      "连接管理器已停止",
      undefined,
      SyncEventType.DISCONNECTED,
    );
  }

  /**
   * Disconnect the current session (graceful alias).
   */
  disconnect(): void {
    this.stop();
  }

  // ============================================================
  // Server Mode
  // ============================================================

  /**
   * Start a WebSocket server on the configured port.
   * Public so main.ts can auto-start it in onload().
   */
  async startServer(): Promise<void> {
    debugLog("[ObsSync] startServer() 端口:", this.port);
    try {
      if (this.enableTls && this.tlsOptions?.isReady) {
        // WSS server with TLS
        this.httpServer = https.createServer({
          key: this.tlsOptions.keyPem,
          cert: this.tlsOptions.certPem,
        });
        this.server = new WebSocket.Server({
          server: this.httpServer,
          maxPayload: 100 * 1024 * 1024, // 100 MB
        });
        this.httpServer.listen(this.port);
        debugLog("[ObsSync] WSS 服务端正在启用 TLS，端口", this.port);
      } else {
        // Plain WS server
        this.httpServer = http.createServer();
        this.server = new WebSocket.Server({
          server: this.httpServer,
          maxPayload: 100 * 1024 * 1024, // 100 MB
        });
        this.httpServer.listen(this.port);
        debugLog("[ObsSync] WS 服务端正在启动（明文），端口", this.port);
      }

      this.server.on("connection", (socket: WebSocket) => {
        syncLogger.log(
          LogLevel.INFO,
          "入站连接已建立",
          undefined,
          SyncEventType.CONNECTED,
        );
        this.serverSocket = socket;
        this.activeSocket = socket;
        this.setupSocketHandlers(socket);
        this.startHeartbeat();
        // Auth handshake sends the PSK challenge to the client.
        // isConnected and EVENTS.CONNECTED will be set after auth
        // completes in handleAuthMessage (lines 634-635).
        this.initAuthHandshake(socket);
      });

      this.server.on("error", (err: Error) => {
        debugLog("[ObsSync] 服务端错误: " + err.message);
        syncLogger.log(
          LogLevel.ERROR,
          `服务端错误：${err.message}`,
          undefined,
          SyncEventType.ERROR,
        );
        this.emit(EVENTS.DISCONNECTED);
      });

      this.server.on("listening", () => {
        debugLog("[ObsSync] 服务端正在监听，端口", this.port);
        syncLogger.log(
          LogLevel.SUCCESS,
          `服务端已在端口 ${this.port}`,
          undefined,
          SyncEventType.CONNECTED,
        );
      });

      syncLogger.log(
        LogLevel.INFO,
        `正在启动服务端，端口 ${this.port}`,
        undefined,
        SyncEventType.SYNC_STARTED,
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      debugLog("[ObsSync] startServer() 捕获异常: " + errorMessage);
      syncLogger.log(
        LogLevel.ERROR,
        `启动服务端失败：${errorMessage}`,
        undefined,
        SyncEventType.ERROR,
      );
      this.emit(EVENTS.DISCONNECTED);
    }
  }

  // ============================================================
  // Client Mode
  // ============================================================

  /**
   * Start a client connection with automatic reconnection.
   */
  private startClientConnection(): void {
    this.shouldReconnect = true;
    this.performClientConnection();
  }

  /**
   * Perform the actual WebSocket client connection.
   */
  private performClientConnection(): void {
    if (!this.shouldReconnect) {
      return;
    }

    const protocol = this.enableTls ? "wss" : "ws";
    const url = `${protocol}://${this.targetAddress}:${this.port}`;
    debugLog("[ObsSync] 正在连接到:", url, "mode:", this.mode, "isConnected:", this.isConnected);
    syncLogger.log(
      LogLevel.INFO,
      `正在连接 ${url}`,
      undefined,
      SyncEventType.SYNC_STARTED,
    );

    try {
      // WSS with self-signed certs — connection will fall back to WS
      // if TLS handshake fails (no rejectUnauthorized for security compliance)
      const socket = new WebSocket(url);

      socket.on("open", () => {
        debugLog("[ObsSync] 客户端 WebSocket 已打开，目标", this.targetAddress);
        syncLogger.log(
          LogLevel.SUCCESS,
          `已连接到 ${this.targetAddress}:${this.port}`,
          undefined,
          SyncEventType.CONNECTED,
        );

        // If already connected via server, use this new socket (fresh) instead
        if (this.isConnected && this.mode === SyncMode.DUPLEX) {
          debugLog("[ObsSync] 已通过服务端连接，改用客户端套接字");
          this.isConnected = false;
        }

        this.reconnectAttempts = 0;
        this.clientSocket = socket;
        this.activeSocket = socket;
        this.setupSocketHandlers(socket);
        this.startHeartbeat();
        // isConnected and EVENTS.CONNECTED will be set after receiving
        // the server's HANDSHAKE challenge in handleAuthMessage (lines 594-604).
        // The server initiates the auth handshake; we wait for its challenge.
        debugLog("[ObsSync] 客户端套接字已打开，等待服务端认证质询");
      });

      socket.on("error", (err: Error) => {
        syncLogger.log(
          LogLevel.WARN,
          `客户端连接错误：${err.message}`,
          undefined,
          SyncEventType.ERROR,
        );

        // TLS/WSS connection failed — try fallback to plain WS
        // Only fall back on genuine TLS errors (not ECONNREFUSED)
        const isTlsError = err.message.includes("cert") || err.message.includes("SSL") || 
                           err.message.includes("TLS") || err.message.includes("CERT") ||
                           err.message.includes("secure") || err.message.includes("DEPTH_ZERO");
        
        if (this.enableTls && this.allowTlsFallback && isTlsError) {
          debugLog("[ObsSync] TLS WSS 连接失败，回退到 WS:", err.message);
          this.enableTls = false;
          this.emit(EVENTS.TLS_FALLBACK);
          this.scheduleReconnect();
          return;
        }

        // On any connection error, retry with reconnect if shouldReconnect is enabled
        if (this.shouldReconnect) {
          this.scheduleReconnect();
          return;
        }
      });

      socket.on("close", () => {
        if (this.clientSocket === socket) {
          this.clientSocket = null;
        }
        if (this.activeSocket === socket) {
          this.activeSocket = null;
          this.isConnected = false;
          this.emit(EVENTS.DISCONNECTED);
          this.stopHeartbeat();
          this.scheduleReconnect();
        }
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      syncLogger.log(
        LogLevel.WARN,
        `创建客户端连接失败：${errorMessage}`,
        undefined,
        SyncEventType.ERROR,
      );
      this.scheduleReconnect();
    }
  }

  // ============================================================
  // Socket Event Handlers
  // ============================================================

  /**
   * Set up event handlers for a WebSocket connection.
   */
  private setupSocketHandlers(socket: WebSocket): void {
    socket.on("message", (data: WebSocket.Data) => {
      this.handleIncomingMessage(socket, data);
    });

    socket.on("close", () => {
      this.handleSocketClose(socket);
    });

    socket.on("error", (err: Error) => {
      syncLogger.log(
        LogLevel.ERROR,
        `套接字错误：${err.message}`,
        undefined,
        SyncEventType.ERROR,
      );
    });

    socket.on("pong", () => {
      this.handlePong();
    });
  }

  /**
   * Handle an incoming WebSocket message.
   */
  private handleIncomingMessage(socket: WebSocket, data: WebSocket.Data): void {
    // Try to decode Buffer data as UTF-8 text first
    // In Obsidian Electron, ws library delivers text frames as Buffer
    if (data instanceof Buffer) {
      const text = data.toString("utf-8");
      // If it starts with { or [, it's likely JSON text, not binary CRDT
      if (text.startsWith("{") || text.startsWith("[")) {
        const message = deserializeMessage(text);
        if (message) {
          // Valid JSON message — handle as text
          this.handleTextMessage(socket, message);
          return;
        }
      }
      // Not JSON text — forward as CRDT binary update
      this.emit(EVENTS.CRDT_UPDATE_RECEIVED, data);
      return;
    }
    
    if (data instanceof ArrayBuffer) {
      this.emit(EVENTS.CRDT_UPDATE_RECEIVED, data);
      return;
    }

    // Text data — parse as JSON message
    const messageStr = typeof data === "string" ? data : data.toString();
    const message = deserializeMessage(messageStr);
    if (message) {
      this.handleTextMessage(socket, message);
    }
  }

  /**
   * Process a parsed SyncMessage (text or JSON-decoded Buffer).
   */
  private handleTextMessage(socket: WebSocket, message: SyncMessage): void {
    // Deduplication
    if (this.processedMessages.has(message.uuid)) {
      return;
    }
    this.processedMessages.set(message.uuid, true);

    // Periodic dedup cleanup
    if (this.processedMessages.size > 1000) {
      this.processedMessages.clear();
    }

    // Handle authentication messages
    if (this.handleAuthMessage(socket, message)) {
      return;
    }

    // Skip messages with undefined type (likely control frames or bad parse)
    if (!message.type) {
      debugLog("[ObsSync] 跳过类型未定义的消息");
      return;
    }

    // Handle heartbeat messages
    if (message.type === MessageType.HEARTBEAT) {
      this.handleHeartbeatMessage(socket);
      return;
    }

    // Handle cert-fingerprint messages (TLS)
    if (message.type === MessageType.CERT_FINGERPRINT) {
      this.handleCertFingerprintMessage(socket, message);
      return;
    }
    if (message.type === MessageType.CERT_FINGERPRINT_ACK) {
      this.handleCertFingerprintAck(message);
      return;
    }
    if (message.type === MessageType.TLS_FALLBACK_NOTIFY) {
      this.handleTlsFallbackNotify(message);
      return;
    }

    // Forward all other messages as events
    this.emit(EVENTS.MESSAGE_RECEIVED, message);
  }

  /**
   * Handle socket close event.
   */
  private handleSocketClose(socket: WebSocket): void {
    if (this.serverSocket === socket) {
      this.serverSocket = null;
    }
    if (this.clientSocket === socket) {
      this.clientSocket = null;
    }
    if (this.activeSocket === socket) {
      this.activeSocket = null;
      this.isConnected = false;
      this.emit(EVENTS.DISCONNECTED);
      this.stopHeartbeat();
      this.scheduleReconnect();
    }
  }

  // ============================================================
  // Authentication Integration
  // ============================================================

  /**
   * Initialize the PSK authentication handshake on a new connection.
   */
  private initAuthHandshake(socket: WebSocket): void {
    const psk = this.sharedKey || "default-key";
    this.authSession = createAuthSession(psk);
    const challenge = this.authSession.start();

    const challengeMsg = createMessage(
      MessageType.HANDSHAKE,
      { challenge },
      this.deviceId,
      this.deviceName,
    );

    this.sendRawMessage(socket, challengeMsg);
  }

  /**
   * Handle authentication-related messages.
   * Returns true if the message was an auth message (and was handled).
   */
  private handleAuthMessage(socket: WebSocket, message: SyncMessage): boolean {
    // HANDSHAKE (challenge) does not require authSession — client side
    // responds to server's challenge using sharedKey directly.
    if (message.type === MessageType.HANDSHAKE) {
      const challenge = message.payload?.challenge;
      if (!challenge || typeof challenge !== "string") {
        return true;
      }

      const psk = this.sharedKey || "default-key";
      const response = computeExpectedResponse(challenge, psk);

      const responseMsg = createMessage(
        MessageType.HANDSHAKE_ACK,
        { response },
        this.deviceId,
        this.deviceName,
      );
      this.sendRawMessage(socket, responseMsg);

      // Mark as connected on the client side too
      this.activeSocket = socket;
      this.isConnected = true;
      this.startHeartbeat();
      debugLog("[ObsSync] 客户端已响应服务端认证质询，已连接");
      syncLogger.log(
        LogLevel.SUCCESS,
        `已通过了对端认证：${message.deviceName} (${message.deviceId})`,
        undefined,
        SyncEventType.CONNECTED,
      );
      this.emit(EVENTS.CONNECTED);
      return true;
    }

    // Other auth messages require authSession (only server side)
    if (!this.authSession) {
      return false;
    }

    switch (message.type) {
      case MessageType.HANDSHAKE_ACK: {
        // Received a response to our challenge — verify it
        const response = message.payload?.response;
        if (!response || typeof response !== "string") {
          return true;
        }

        const isValid = this.authSession.processResponse(
          response,
          message.deviceId,
          message.deviceName,
        );

        if (isValid) {
          syncLogger.log(
            LogLevel.SUCCESS,
            `对端已通过认证: ${message.deviceName} (${message.deviceId})`,
            undefined,
            SyncEventType.CONNECTED,
          );
          this.isConnected = true;
          this.emit(EVENTS.CONNECTED);
        } else {
          syncLogger.log(
            LogLevel.WARN,
            `认证失败（对端）：${message.deviceName}`,
            undefined,
            SyncEventType.ERROR,
          );
          socket.close(4001, "Authentication failed");
        }
        return true;
      }

      default:
        return false;
    }
  }

  // ============================================================
  // TLS / Certificate Fingerprint Handling
  // ============================================================

  /**
   * Handle an incoming CERT_FINGERPRINT message.
   * If the fingerprint is already trusted, auto-accept.
   * Otherwise, emit an event for the UI to show PIN confirmation.
   */
  private handleCertFingerprintMessage(socket: WebSocket, message: SyncMessage): void {
    const remoteFingerprint = message.payload?.fingerprint as string | undefined;
    if (!remoteFingerprint) return;

    if (this.trustedFingerprints.includes(remoteFingerprint)) {
      // Auto-accept: already trusted
      const ack = createMessage(
        MessageType.CERT_FINGERPRINT_ACK,
        { accepted: true },
        this.deviceId,
        this.deviceName,
      );
      this.sendRawMessage(socket, ack);
    } else {
      // Not trusted — emit event so main.ts can show PIN confirmation
      this.emit(EVENTS.CERT_FINGERPRINT, { socket, fingerprint: remoteFingerprint });
    }

    // Send our own fingerprint
    if (this.tlsOptions?.fingerprint) {
      const msg = createMessage(
        MessageType.CERT_FINGERPRINT,
        { fingerprint: this.tlsOptions.fingerprint, algorithm: "ECDSA-P256" },
        this.deviceId,
        this.deviceName,
      );
      this.sendRawMessage(socket, msg);
    }
  }

  /**
   * Handle an incoming CERT_FINGERPRINT_ACK message.
   */
  private handleCertFingerprintAck(message: SyncMessage): void {
    const accepted = message.payload?.accepted as boolean | undefined;
    debugLog("[ObsSync] 证书指纹 ack 已收到，accepted:", accepted);
    if (!accepted) {
      syncLogger.log(
        LogLevel.WARN,
        "远端拒绝了我们的证书指纹",
        undefined,
        SyncEventType.ERROR,
      );
    }
  }

  /**
   * Handle an incoming TLS_FALLBACK_NOTIFY message.
   */
  private handleTlsFallbackNotify(message: SyncMessage): void {
    const reason = message.payload?.reason as string | undefined;
    syncLogger.log(
      LogLevel.WARN,
      `远端回退到明文 WS：${reason || "未知原因"}`,
      undefined,
      SyncEventType.ERROR,
    );
  }

  /**
   * Set the list of trusted certificate fingerprints.
   */
  setTrustedFingerprints(fingerprints: string[]): void {
    this.trustedFingerprints = fingerprints;
  }

  // ============================================================
  // Message Sending
  // ============================================================

  /**
   * Send a SyncMessage over the active connection.
   */
  sendMessage(msg: SyncMessage): void {
    if (!this.activeSocket || !this.isConnected) {
      syncLogger.log(
        LogLevel.WARN,
        "无法发送消息：未连接",
        undefined,
        SyncEventType.ERROR,
      );
      return;
    }

    this.sendRawMessage(this.activeSocket, msg);
  }

  /**
   * Send a CRDT binary frame over the active connection.
   */
  sendBinary(data: Uint8Array): void {
    if (!this.activeSocket || !this.isConnected) {
      syncLogger.log(
        LogLevel.WARN,
        "无法发送二进制：未连接",
        undefined,
        SyncEventType.ERROR,
      );
      return;
    }

    try {
      this.activeSocket.send(data);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      syncLogger.log(
        LogLevel.ERROR,
        `发送二进制失败：${errorMessage}`,
        undefined,
        SyncEventType.ERROR,
      );
    }
  }

  /**
   * Send a raw SyncMessage over a specific socket.
   */
  private sendRawMessage(socket: WebSocket, msg: SyncMessage): void {
    try {
      const serialized = serializeMessage(msg);
      socket.send(serialized);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      syncLogger.log(
        LogLevel.ERROR,
        `发送消息失败：${errorMessage}`,
        undefined,
        SyncEventType.ERROR,
      );
    }
  }

  // ============================================================
  // Heartbeat
  // ============================================================

  /**
   * Start the heartbeat ping/pong cycle.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = window.setInterval(() => {
      if (this.activeSocket && this.activeSocket.readyState === WebSocket.OPEN) {
        try {
          this.activeSocket.ping();
          const pingMsg = createMessage(
            MessageType.HEARTBEAT,
            {},
            this.deviceId,
            this.deviceName,
          );
          this.sendRawMessage(this.activeSocket, pingMsg);
        } catch {
          // Socket might be closing
        }

        // Set a timeout for pong response
        this.heartbeatTimeoutTimer = window.setTimeout(() => {
          syncLogger.log(
            LogLevel.WARN,
            "心跳超时——未收到 pong 响应",
            undefined,
            SyncEventType.DISCONNECTED,
          );
          this.handleHeartbeatTimeout();
        }, this.HEARTBEAT_TIMEOUT_MS);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop the heartbeat ping/pong cycle.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      window.clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  /**
   * Handle an incoming heartbeat message — respond with pong.
   */
  private handleHeartbeatMessage(socket: WebSocket): void {
    // The ws library handles ping/pong automatically at the protocol level.
    // We just log and acknowledge.
    const pongMsg = createMessage(
      MessageType.HEARTBEAT,
      {},
      this.deviceId,
      this.deviceName,
    );
    this.sendRawMessage(socket, pongMsg);
  }

  /**
   * Handle a pong frame from the peer.
   */
  private handlePong(): void {
    if (this.heartbeatTimeoutTimer) {
      window.clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  /**
   * Handle heartbeat timeout — force close and reconnect.
   */
  private handleHeartbeatTimeout(): void {
    if (this.activeSocket) {
      try {
        this.activeSocket.terminate();
      } catch {
        // Already closed
      }
    }
    this.isConnected = false;
    this.activeSocket = null;
    this.emit(EVENTS.DISCONNECTED);
    this.scheduleReconnect();
  }

  // ============================================================
  // Reconnection
  // ============================================================

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (!this.shouldReconnect) {
      return;
    }

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );

    this.reconnectAttempts++;

    syncLogger.log(
      LogLevel.INFO,
      `将在 ${delay} 毫秒后重连（第 ${this.reconnectAttempts})`,
      undefined,
      SyncEventType.DISCONNECTED,
    );

    this.emit(EVENTS.RECONNECTING, { delay, attempt: this.reconnectAttempts });

    this.reconnectTimer = window.setTimeout(() => {
      if (!this.shouldReconnect) {
        return;
      }

      if (this.mode === SyncMode.CLIENT || this.mode === SyncMode.DUPLEX) {
        this.performClientConnection();
      }
    }, delay);
  }

  /**
   * Clear the reconnection timer.
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ============================================================
  // Socket Cleanup
  // ============================================================

  /**
   * Close all active sockets.
   */
  private closeSockets(): void {
    if (this.clientSocket) {
      try {
        this.clientSocket.close(1000, "Shutting down");
      } catch {
        // Already closed
      }
      this.clientSocket = null;
    }

    if (this.serverSocket) {
      try {
        this.serverSocket.close(1000, "Shutting down");
      } catch {
        // Already closed
      }
      this.serverSocket = null;
    }

    if (this.activeSocket && this.activeSocket !== this.clientSocket && this.activeSocket !== this.serverSocket) {
      try {
        this.activeSocket.close(1000, "Shutting down");
      } catch {
        // Already closed
      }
    }
    this.activeSocket = null;

    if (this.server) {
      try {
        this.server.close();
      } catch {
        // Already closed
      }
      this.server = null;
    }
  }

  /**
   * Close the HTTP/S server.
   */
  private closeHttpServer(): void {
    if (this.httpServer) {
      try {
        this.httpServer.close();
      } catch {
        /* ignore */
      }
      this.httpServer = null;
    }
  }
}
