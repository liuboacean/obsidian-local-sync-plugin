// ============================================================
// PSK (Pre-Shared Key) Authentication & Handshake
// ============================================================
// Implements a challenge-response authentication protocol
// using HMAC-SHA256 with a pre-shared key.
//
// State machine: PENDING → CHALLENGED → AUTHENTICATED / FAILED / LOCKED

import * as crypto from "crypto";
import { AuthStatus } from "./types";
import { AUTH_MAX_FAILURES, AUTH_LOCKOUT_MS } from "./constants";


// ============================================================
// Constants
// ============================================================

const TOKEN_BYTE_LENGTH = 32; // 32 bytes → 64 hex chars
const CHALLENGE_BYTE_LENGTH = 16; // 16 bytes → 32 hex chars
const PAIRING_TOKEN_BYTE_LENGTH = 16;

// ============================================================
// Token Generation
// ============================================================

/**
 * Generate a cryptographically secure 32-byte random token as a hex string.
 * Returns a 64-character hex string.
 */
export function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTE_LENGTH).toString("hex");
}

// ============================================================
// Challenge-Response
// ============================================================

/**
 * Create an authentication challenge.
 *
 * Generates a random challenge string and computes the expected response
 * as HMAC-SHA256(psk, challenge).
 *
 * @returns An object containing the raw challenge and the expected response hex.
 */
export function createChallenge(): {
  challenge: string;
  expectedResponse: string;
} {
  const challenge = crypto.randomBytes(CHALLENGE_BYTE_LENGTH).toString("hex");
  return {
    challenge,
    expectedResponse: "", // Caller must provide PSK to compute expected response
  };
}

/**
 * Create an authentication challenge with a known PSK.
 *
 * @param psk - The pre-shared key used to compute the expected response.
 * @returns An object containing the challenge and the expected HMAC-SHA256 response.
 */
export function createChallengeWithPsk(psk: string): {
  challenge: string;
  expectedResponse: string;
} {
  const challenge = crypto.randomBytes(CHALLENGE_BYTE_LENGTH).toString("hex");
  const expectedResponse = computeHmacResponse(challenge, psk);
  return { challenge, expectedResponse };
}

/**
 * Compute the HMAC-SHA256 response for a given challenge and PSK.
 */
function computeHmacResponse(challenge: string, psk: string): string {
  return crypto
    .createHmac("sha256", psk)
    .update(challenge)
    .digest("hex");
}

/**
 * Compute the expected HMAC-SHA256 response given a challenge and PSK.
 * Alias for the internal function, exposed for external use.
 */
export function computeExpectedResponse(challenge: string, psk: string): string {
  return computeHmacResponse(challenge, psk);
}

/**
 * Verify a client's response against the expected HMAC-SHA256 value.
 *
 * Uses timing-safe comparison to prevent timing side-channel attacks.
 *
 * @param challenge - The original challenge string sent to the peer.
 * @param response - The response received from the peer.
 * @param psk - The pre-shared key.
 * @returns true if the response is valid.
 */
export function verifyResponse(
  challenge: string,
  response: string,
  psk: string,
): boolean {
  const expected = computeHmacResponse(challenge, psk);
  // Timing-safe comparison to prevent timing attacks
  if (response.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(response), Buffer.from(expected));
}

// ============================================================
// Pairing Token
// ============================================================

/**
 * Create a pairing token that binds a device identity to a PSK.
 * Format: base64(deviceId || deviceName || randomNonce), signed with HMAC-SHA256.
 *
 * @param deviceId - The unique device identifier.
 * @param deviceName - The human-readable device name.
 * @param psk - The pre-shared key.
 * @returns A pairing token string suitable for QR code scanning or manual entry.
 */
export function createPairingToken(
  deviceId: string,
  deviceName: string,
  psk: string,
): string {
  const nonce = crypto.randomBytes(PAIRING_TOKEN_BYTE_LENGTH).toString("hex");
  const payload = JSON.stringify({ deviceId, deviceName, nonce });
  const signature = crypto
    .createHmac("sha256", psk)
    .update(payload)
    .digest("hex");
  const tokenPayload = Buffer.from(payload).toString("base64");
  return `${tokenPayload}.${signature}`;
}

/**
 * Parse and verify a pairing token.
 *
 * @param token - The pairing token string to parse.
 * @param psk - The pre-shared key used to verify the signature.
 * @returns The parsed device info if valid, or null if the token is invalid.
 */
export function parsePairingToken(
  token: string,
  psk: string,
): { deviceId: string; deviceName: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) {
      return null;
    }
    const [payloadBase64, signature] = parts;
    const payloadStr = Buffer.from(payloadBase64, "base64").toString("utf-8");
    const expectedSignature = crypto
      .createHmac("sha256", psk)
      .update(payloadStr)
      .digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return null;
    }
    const payload = JSON.parse(payloadStr) as Record<string, unknown>;
    if (typeof payload.deviceId !== "string" || typeof payload.deviceName !== "string") {
      return null;
    }
    return { deviceId: payload.deviceId, deviceName: payload.deviceName };
  } catch {
    return null;
  }
}

// ============================================================
// Authentication Session (State Machine)
// ============================================================

export class AuthSession {
  private status: AuthStatus = AuthStatus.PENDING;
  private challenge: string = "";
  private expectedResponse: string = "";
  private failureCount: number = 0;
  private lockedUntil: number = 0;
  private deviceId: string = "";
  private deviceName: string = "";

  /**
   * Create a new AuthSession.
   *
   * @param psk - The pre-shared key used for this session.
   */
  constructor(private psk: string) {}

  /**
   * Get the current authentication status.
   */
  getStatus(): AuthStatus {
    return this.status;
  }

  /**
   * Get the authenticated peer's device ID (only valid after AUTHENTICATED).
   */
  getDeviceId(): string {
    return this.deviceId;
  }

  /**
   * Get the authenticated peer's device name (only valid after AUTHENTICATED).
   */
  getDeviceName(): string {
    return this.deviceName;
  }

  /**
   * Initiate the authentication handshake.
   * Transitions from PENDING → CHALLENGED.
   *
   * @returns The challenge string to send to the peer.
   */
  start(): string {
    if (this.status === AuthStatus.LOCKED) {
      this.checkLockout();
      if (this.status === AuthStatus.LOCKED) {
        throw new Error("AuthSession: session is locked due to too many failures");
      }
    }

    const { challenge, expectedResponse } = createChallengeWithPsk(this.psk);
    this.challenge = challenge;
    this.expectedResponse = expectedResponse;
    this.status = AuthStatus.CHALLENGED;
    return challenge;
  }

  /**
   * Process a response from the peer.
   *
   * @param response - The HMAC-SHA256 response to the challenge.
   * @param peerDeviceId - The device ID of the responding peer.
   * @param peerDeviceName - The device name of the responding peer.
   * @returns true if authentication succeeded.
   */
  processResponse(
    response: string,
    peerDeviceId: string,
    peerDeviceName: string,
  ): boolean {
    if (this.status === AuthStatus.LOCKED) {
      this.checkLockout();
      if (this.status === AuthStatus.LOCKED) {
        return false;
      }
    }

    if (this.status !== AuthStatus.CHALLENGED) {
      return false;
    }

    const computed = computeHmacResponse(this.challenge, this.psk);

    if (response.length !== computed.length) {
      this.handleFailure();
      return false;
    }

    const isValid = crypto.timingSafeEqual(
      Buffer.from(response),
      Buffer.from(computed),
    );

    if (isValid) {
      this.status = AuthStatus.AUTHENTICATED;
      this.failureCount = 0;
      this.deviceId = peerDeviceId;
      this.deviceName = peerDeviceName;
      return true;
    } else {
      this.handleFailure();
      return false;
    }
  }

  /**
   * Reset the session back to PENDING.
   */
  reset(): void {
    this.status = AuthStatus.PENDING;
    this.challenge = "";
    this.expectedResponse = "";
    this.deviceId = "";
    this.deviceName = "";
    // Keep failureCount for lockout tracking
  }

  /**
   * Handle an authentication failure.
   * Locks the session after AUTH_MAX_FAILURES consecutive failures.
   */
  private handleFailure(): void {
    this.failureCount++;
    this.status = AuthStatus.FAILED;
    if (this.failureCount >= AUTH_MAX_FAILURES) {
      this.status = AuthStatus.LOCKED;
      this.lockedUntil = Date.now() + AUTH_LOCKOUT_MS;
    }
  }

  /**
   * Check if the lockout period has expired and release the session if so.
   */
  private checkLockout(): void {
    if (this.status === AuthStatus.LOCKED && Date.now() >= this.lockedUntil) {
      this.status = AuthStatus.PENDING;
      this.failureCount = 0;
      this.lockedUntil = 0;
    }
  }
}

// ============================================================
// Convenience: Create a default AuthSession
// ============================================================

/**
 * Create a new AuthSession with the given PSK.
 * If no PSK is provided, generates a random one.
 *
 * @param psk - Optional pre-shared key. If omitted, a random key is generated.
 * @returns A new AuthSession instance.
 */
export function createAuthSession(psk?: string): AuthSession {
  const key = psk || generateToken();
  return new AuthSession(key);
}
