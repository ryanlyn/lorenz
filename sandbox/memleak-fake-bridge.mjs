#!/usr/bin/env node
// Fake ACP bridge for memory-leak investigation: speaks enough of the ACP
// protocol for the real Executor to run full turns. Each prompt streams a
// configurable number of agent_message_chunk notifications, then completes.
import { createRequire } from "node:module";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

// Resolve the ACP SDK through @lorenz/acp's own dependency so the bridge works
// regardless of the pnpm store layout. This file lives in sandbox/, so the acp
// package sits at ../packages/acp relative to it.
const acpPackageRequire = createRequire(new URL("../packages/acp/package.json", import.meta.url));
const sdkPath = acpPackageRequire.resolve("@agentclientprotocol/sdk");
const acp = await import(pathToFileURL(sdkPath).href);

const CHUNKS_PER_TURN = Number(process.env.FAKE_BRIDGE_CHUNKS ?? 50);
/** When > 0, pace the chunks so one turn lasts this long (a long-lived agent session). */
const TURN_SECONDS = Number(process.env.FAKE_BRIDGE_TURN_SECONDS ?? 0);
const CHUNK_BYTES = Number(process.env.FAKE_BRIDGE_CHUNK_BYTES ?? 200);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeAgent {
  constructor(connection) {
    this.connection = connection;
  }
  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} };
  }
  async authenticate() {
    return {};
  }
  async newSession() {
    return { sessionId: `fake-${process.pid}-${Math.random().toString(36).slice(2)}` };
  }
  async prompt(params) {
    const pauseMs = TURN_SECONDS > 0 ? (TURN_SECONDS * 1000) / CHUNKS_PER_TURN : 0;
    for (let i = 0; i < CHUNKS_PER_TURN; i++) {
      if (pauseMs > 0) await sleep(pauseMs);
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `chunk ${i} of simulated agent output with a reasonably long payload body ${"x".repeat(CHUNK_BYTES)}`,
          },
        },
      });
    }
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: 1000,
        size: 100000,
      },
    });
    return { stopReason: "end_turn" };
  }
  async cancel() {
    return {};
  }
}

new acp.AgentSideConnection(
  (connection) => new FakeAgent(connection),
  acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
