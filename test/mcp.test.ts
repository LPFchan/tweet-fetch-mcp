import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../index";
import { initialize, legacy, modern, rpc, IDENTITY, env } from "./helpers";
import worker from "../index";

// The protocol surface: which revisions the endpoint speaks, what a tool list
// looks like in each era, and the cache hints a 2026-07-28 client is given.
// Nothing here reaches the network -- tools/list and initialize never call
// fxtwitter.

describe("2025-era clients", () => {
  for (const version of ["2025-06-18", "2025-03-26"]) {
    it(`initializes with a ${version} client`, async () => {
      const { status, body } = await initialize(version);
      expect(status).toBe(200);
      expect(body.result.protocolVersion).toBe(version);
      expect(body.result.serverInfo).toEqual({ name: "tweet-fetch", version: "0.1.0" });
      expect(body.result.capabilities.tools).toBeDefined();
    });
  }

  it("lists every tool without a session", async () => {
    // Stateless: no initialize first, no mcp-session-id. The Python server
    // was `stateless_http=True` and this must stay reachable the same way.
    const { status, body } = await legacy("tools/list");
    expect(status).toBe(200);
    expect(body.result.tools.map((t: any) => t.name)).toEqual([...TOOL_NAMES]);
    for (const tool of body.result.tools) {
      expect(tool.inputSchema.required).toEqual(["tweet_url"]);
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it("does not attach 2026 cache fields to a 2025-era list", async () => {
    const { body } = await legacy("tools/list");
    expect(body.result.ttlMs).toBeUndefined();
    expect(body.result.cacheScope).toBeUndefined();
  });

  it("accepts /mcp/ with a trailing slash, as the Python server did", async () => {
    const { status, body } = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { path: "/mcp/" });
    expect(status).toBe(200);
    expect(body.result.tools).toHaveLength(TOOL_NAMES.length);
  });

  it("does not open a session: GET /mcp is 405", async () => {
    const response = await worker.fetch(
      new Request("https://tweet.lost.plus/mcp", { headers: { ...IDENTITY, accept: "text/event-stream" } }),
      env,
    );
    expect(response.status).toBe(405);
  });
});

describe("2026-07-28 clients", () => {
  it("answers server/discover with the modern revision and a private 5-minute cache hint", async () => {
    const { status, body } = await modern("server/discover");
    expect(status).toBe(200);
    expect(body.result.supportedVersions).toEqual(["2026-07-28"]);
    expect(body.result.ttlMs).toBe(300_000);
    expect(body.result.cacheScope).toBe("private");
  });

  it("lists the same tools as the 2025 path, with a private 5-minute cache hint", async () => {
    const { status, contentType, body } = await modern("tools/list");
    expect(status).toBe(200);
    expect(contentType).toContain("application/json");
    expect(body.result.tools.map((t: any) => t.name)).toEqual([...TOOL_NAMES]);
    expect(body.result.ttlMs).toBe(300_000);
    expect(body.result.cacheScope).toBe("private");
  });

  it("rejects a modern version header on a request without the envelope", async () => {
    // The SDK's ladder, not ours, but the endpoint must keep rejecting this
    // rather than quietly serving it as legacy.
    const { status, body } = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" } },
    );
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });
});
