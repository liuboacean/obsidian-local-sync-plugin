// ============================================================
// WebSocket Connection Manager
// ============================================================
// Manages WebSocket server and client connections for the
// Obsidian Local Sync plugin. Supports SERVER, CLIENT, and
// DUPLEX modes with PSK authentication, heartbeat, and
// automatic reconnection with exponential backoff.

import { EventEmitter } from "events";
import WebSocket from "ws";
import {
  MessageType,
  SyncMessage,
  SyncMode,
  AuthStatus,
} from "./types";
import {
  DEFAULT_PORT,
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  EVENTS,
} from "./constants";
import { serializeMessage, deserializeMessage, createMessage } from "./protocol";
import { AuthSession, createAuthSession, computeExpectedResponse } from "./auth-handshake";
import { syncLogger } from "./sync-logger";
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

  private server: WebSocket.Server | null = null;
  private clientSocket: WebSocket | null = null;
  private serverSocket: WebSocket | null = null;
  private activeSocket: WebSocket | null = null;

  private authSession: AuthSession | null = null;
  private isConnected = false;
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

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
      `ConnectionManager starting in ${this.mode} mode on port ${this.port}`,
      undefined,
      SyncEventType.SYNC_STARTED,
    );

    if (this.mode === SyncMode.SERVER || this.mode === SyncMode.DUPLEX) {
      await this.startServer();
    }

    if (this.mode === SyncMode.CLIENT || this.mode === SyncMode.DUPLEX) {
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
    this.processedMessages.clear();

    syncLogger.log(
      LogLevel.INFO,
      "ConnectionManager stopped",
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
   */
  private async startServer(): Promise<void> {
    try {
      this.server = new WebSocket.Server({
        port: this.port,
        maxPayload: 100 * 1024 * 1024, // 100 MB
      });

      this.server.on("connection", (socket: WebSocket) => {
        syncLogger.log(
          LogLevel.INFO,
          "Incoming connection established",
          undefined,
          SyncEventType.CONNECTED,
        );

        // In DUPLEX mode, if we already have an active connection, reject the new one
        if (this.isConnected && this.mode === SyncMode.DUPLEX) {
          socket.close(4000, "Already connected via other side");
          return;
        }

        this.serverSocket = socket;
        this.activeSocket = socket;
        this.setupSocketHandlers(socket);
        this.startHeartbeat();
        this.initAuthHandshake(socket);
      });

      this.server.on("error", (err: Error) => {
        syncLogger.log(
          LogLevel.ERROR,
          `Server error: ${err.message}`,
          undefined,
          SyncEventType.ERROR,
        );
        this.emit(EVENTS.DISCONNECTED);
      });

      this.server.on("listening", () => {
        syncLogger.log(
          LogLevel.SUCCESS,
          `Server listening on port ${this.port}`,
          undefined,
          SyncEventType.CONNECTED,
        );
      });

      syncLogger.log(
        LogLevel.INFO,
        `Starting server on port ${this.port}`,
        undefined,
        SyncEventType.SYNC_STARTED,
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      syncLogger.log(
        LogLevel.ERROR,
        `Failed to start server: ${errorMessage}`,
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

    const url = `ws://${this.targetAddress}:${this.port}`;
    syncLogger.log(
      LogLevel.INFO,
      `Connecting to ${url}`,
      undefined,
      SyncEventType.SYNC_STARTED,
    );

    try {
      const socket = new WebSocket(url);

      socket.on("open", () => {
        syncLogger.log(
          LogLevel.SUCCESS,
          `Connected to ${this.targetAddress}:${this.port}`,
          undefined,
          SyncEventType.CONNECTED,
        );

        // In DUPLEX mode, if already connected via the server, close the client
        if (this.isConnected && this.mode === SyncMode.DUPLEX) {
          socket.close(4000, "Already connected via server");
          return;
        }

        this.reconnectAttempts = 0;
        this.clientSocket = socket;
        this.activeSocket = socket;
        this.isConnected = true;
        this.setupSocketHandlers(socket);
        this.startHeartbeat();
        this.initAuthHandshake(socket);
        this.emit(EVENTS.CONNECTED);
      });

      socket.on("error", (err: Error) => {
        syncLogger.log(
          LogLevel.WARN,
          `Client connection error: ${err.message}`,
          undefined,
          SyncEventType.ERROR,
        );
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
        `Failed to create client connection: ${errorMessage}`,
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
        `Socket error: ${err.message}`,
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
    // Binary data — forward as CRDT update event
    if (data instanceof Buffer || data instanceof ArrayBuffer) {
      this.emit(EVENTS.MESSAGE_RECEIVED, data);
      this.emit(EVENTS.CRDT_UPDATE_RECEIVED, data);
      return;
    }

    // Text data — parse as JSON message
    const messageStr = typeof data === "string" ? data : data.toString();
    const message = deserializeMessage(messageStr);

    if (!message) {
      syncLogger.log(
        LogLevel.WARN,
        "Received malformed message",
        undefined,
        SyncEventType.ERROR,
      );
      return;
    }

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

    // Handle heartbeat messages
    if (message.type === MessageType.HEARTBEAT) {
      this.handleHeartbeatMessage(socket);
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
    this.authSession.start();

    const challengeMsg = createMessage(
      MessageType.HANDSHAKE,
      { challenge: this.authSession.start() },
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
    if (!this.authSession) {
      return false;
    }

    switch (message.type) {
      case MessageType.HANDSHAKE: {
        // Received a challenge — respond to it
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
        return true;
      }

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
            `Peer authenticated: ${message.deviceName} (${message.deviceId})`,
            undefined,
            SyncEventType.CONNECTED,
          );
          this.isConnected = true;
          this.emit(EVENTS.CONNECTED);
        } else {
          syncLogger.log(
            LogLevel.WARN,
            `Authentication failed for ${message.deviceName}`,
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
  // Message Sending
  // ============================================================

  /**
   * Send a SyncMessage over the active connection.
   */
  sendMessage(msg: SyncMessage): void {
    if (!this.activeSocket || !this.isConnected) {
      syncLogger.log(
        LogLevel.WARN,
        "Cannot send message: not connected",
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
        "Cannot send binary: not connected",
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
        `Failed to send binary: ${errorMessage}`,
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
        `Failed to send message: ${errorMessage}`,
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

    this.heartbeatTimer = setInterval(() => {
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
        this.heartbeatTimeoutTimer = setTimeout(() => {
          syncLogger.log(
            LogLevel.WARN,
            "Heartbeat timeout — no pong received",
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
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
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
      clearTimeout(this.heartbeatTimeoutTimer);
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
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
      undefined,
      SyncEventType.DISCONNECTED,
    );

    this.emit(EVENTS.RECONNECTING, { delay, attempt: this.reconnectAttempts });

    this.reconnectTimer = setTimeout(() => {
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
      clearTimeout(this.reconnectTimer);
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
}
