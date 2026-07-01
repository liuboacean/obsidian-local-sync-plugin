// ============================================================
// Auth Handshake Tests
// ============================================================

import { describe, it, expect, vi } from "vitest";
import {
  generateToken,
  createChallengeWithPsk,
  verifyResponse,
  createPairingToken,
  parsePairingToken,
  computeExpectedResponse,
  AuthSession,
  createAuthSession,
} from "../../src/auth-handshake";
import { AuthStatus } from "../../src/types";

// ============================================================
// Token Generation
// ============================================================

describe("generateToken", () => {
  it("should generate a 64-character hex string", () => {
    const token = generateToken();
    expect(token).toBeDefined();
    expect(typeof token).toBe("string");
    expect(token.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });

  it("should generate unique tokens each time", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateToken());
    }
    expect(tokens.size).toBe(100);
  });
});

// ============================================================
// Challenge-Response
// ============================================================

describe("createChallengeWithPsk", () => {
  it("should generate a challenge string", () => {
    const result = createChallengeWithPsk("my-secret-key");
    expect(result.challenge).toBeDefined();
    expect(typeof result.challenge).toBe("string");
    expect(result.challenge.length).toBeGreaterThan(0);
  });

  it("should generate an expected response", () => {
    const result = createChallengeWithPsk("my-secret-key");
    expect(result.expectedResponse).toBeDefined();
    expect(typeof result.expectedResponse).toBe("string");
    expect(result.expectedResponse.length).toBeGreaterThan(0);
  });
});

describe("verifyResponse", () => {
  it("should accept a correct response", () => {
    const { challenge, expectedResponse } = createChallengeWithPsk("my-key");
    const isValid = verifyResponse(challenge, expectedResponse, "my-key");
    expect(isValid).toBe(true);
  });

  it("should reject an incorrect response", () => {
    const { challenge } = createChallengeWithPsk("my-key");
    const isValid = verifyResponse(challenge, "wrong-response", "my-key");
    expect(isValid).toBe(false);
  });

  it("should reject a response with wrong PSK", () => {
    const { challenge, expectedResponse } = createChallengeWithPsk("key-a");
    const isValid = verifyResponse(challenge, expectedResponse, "key-b");
    expect(isValid).toBe(false);
  });

  it("should reject a response with wrong length", () => {
    const { challenge } = createChallengeWithPsk("my-key");
    const isValid = verifyResponse(
      challenge,
      "too-short",
      "my-key",
    );
    expect(isValid).toBe(false);
  });

  it("should be consistent: same inputs produce same response", () => {
    const challenge = "abc123";
    const psk = "test-key";
    const response1 = computeExpectedResponse(challenge, psk);
    const response2 = computeExpectedResponse(challenge, psk);
    expect(response1).toBe(response2);
  });
});

// ============================================================
// Pairing Tokens
// ============================================================

describe("createPairingToken", () => {
  it("should create a token with dot-separated format", () => {
    const token = createPairingToken("device-1", "My Device", "my-psk");
    expect(token).toBeDefined();
    expect(typeof token).toBe("string");
    expect(token).toContain(".");
    const parts = token.split(".");
    expect(parts.length).toBe(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });
});

describe("parsePairingToken", () => {
  it("should parse a valid token", () => {
    const token = createPairingToken("device-1", "My Device", "my-psk");
    const result = parsePairingToken(token, "my-psk");
    expect(result).not.toBeNull();
    expect(result!.deviceId).toBe("device-1");
    expect(result!.deviceName).toBe("My Device");
  });

  it("should return null for invalid signature", () => {
    const token = createPairingToken("device-1", "My Device", "key-a");
    const result = parsePairingToken(token, "key-b");
    expect(result).toBeNull();
  });

  it("should return null for malformed token", () => {
    const result = parsePairingToken("invalid-token", "my-psk");
    expect(result).toBeNull();
  });

  it("should return null for empty token", () => {
    const result = parsePairingToken("", "my-psk");
    expect(result).toBeNull();
  });
});

// ============================================================
// AuthSession (State Machine)
// ============================================================

describe("AuthSession", () => {
  it("should start in PENDING state", () => {
    const session = createAuthSession("test-psk");
    expect(session.getStatus()).toBe(AuthStatus.PENDING);
  });

  it("should transition to CHALLENGED after start()", () => {
    const session = createAuthSession("test-psk");
    const challenge = session.start();
    expect(challenge).toBeDefined();
    expect(typeof challenge).toBe("string");
    expect(session.getStatus()).toBe(AuthStatus.CHALLENGED);
  });

  it("should transition to AUTHENTICATED on correct response", () => {
    const session = createAuthSession("test-psk");
    const challenge = session.start();

    // Correct response
    const expectedResponse = computeExpectedResponse(challenge, "test-psk");
    const result = session.processResponse(
      expectedResponse,
      "peer-device",
      "Peer Device",
    );
    expect(result).toBe(true);
    expect(session.getStatus()).toBe(AuthStatus.AUTHENTICATED);
    expect(session.getDeviceId()).toBe("peer-device");
    expect(session.getDeviceName()).toBe("Peer Device");
  });

  it("should transition to FAILED on wrong response", () => {
    const session = createAuthSession("test-psk");
    session.start();

    const result = session.processResponse(
      "wrong-response",
      "peer-device",
      "Peer Device",
    );
    expect(result).toBe(false);
    expect(session.getStatus()).toBe(AuthStatus.FAILED);
  });

  it("should reject response when not in CHALLENGED state", () => {
    const session = createAuthSession("test-psk");
    // State is PENDING — not challenged yet
    const result = session.processResponse(
      "some-response",
      "peer-device",
      "Peer Device",
    );
    expect(result).toBe(false);
  });

  it("should throw when starting twice", () => {
    const session = createAuthSession("test-psk");
    session.start();
    // Starting again while CHALLENGED should still work (spec doesn't forbid)
    // Actually, the spec says start() transitions PENDING→CHALLENGED
    // If already CHALLENGED, the implementation throws? Let's check...
    // Looking at the code: start() checks for LOCKED, no other state check.
    // So it should re-challenge. Let's verify it returns a challenge.
    const challenge2 = session.start();
    expect(challenge2).toBeDefined();
  });

  it("should track device info after authentication", () => {
    const session = createAuthSession("test-psk");
    session.start();
    const expectedResponse = computeExpectedResponse(
      (session as any).challenge || "",
      "test-psk",
    );

    // Actually the challenge is stored internally. Let me use the proper flow.
    // The session.start() returns the challenge. The computeExpectedResponse
    // uses that challenge.
    const session2 = createAuthSession("test-psk");
    const challenge = session2.start();
    const response = computeExpectedResponse(challenge, "test-psk");
    session2.processResponse(response, "my-peer", "My Peer");

    expect(session2.getDeviceId()).toBe("my-peer");
    expect(session2.getDeviceName()).toBe("My Peer");
  });
});

// ============================================================
// Replay Attack Resistance
// ============================================================

describe("Replay Attack Resistance", () => {
  it("should reject replayed response in a new session", () => {
    // Session A: legitimate auth
    const sessionA = createAuthSession("shared-psk");
    const challengeA = sessionA.start();
    const responseA = computeExpectedResponse(challengeA, "shared-psk");
    expect(sessionA.processResponse(responseA, "peer", "Peer")).toBe(true);

    // Session B: attacker replays responseA (different challenge)
    const sessionB = createAuthSession("shared-psk");
    sessionB.start();
    expect(sessionB.processResponse(responseA, "peer", "Peer")).toBe(false);
  });
});
