import { describe, expect, it } from "vitest";
import worker from "../index";
import { IDENTITY, env } from "./helpers";

// The refusal path, which is the one that matters. This Worker holds no route,
// so in a correct deployment every request it sees has already been through the
// gateway. These tests are about what happens when that stops being true --
// because a service that quietly serves unauthenticated traffic when its front
// door is misconfigured is the exact failure the gateway exists to prevent.
//
// Plain vitest rather than @cloudflare/vitest-pool-workers: the entry point is
// called directly, and nothing on the paths under test needs a workerd runtime,
// a binding, or the network. Tool behavior is in tools.test.ts with fxtwitter
// stubbed; the protocol surface is in mcp.test.ts.

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://tweet.lost.plus${path}`, { headers });
}

describe("without gateway identity headers", () => {
  for (const path of ["/", "/mcp", "/mcp/", "/healthz", "/anything"]) {
    it(`refuses ${path}`, async () => {
      const response = await worker.fetch(request(path), env);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: "no gateway identity" });
    });
  }

  it("refuses a POST to /mcp, which is how a real client calls it", async () => {
    const response = await worker.fetch(
      new Request("https://tweet.lost.plus/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
    );
    expect(response.status).toBe(500);
  });

  it("refuses a caller presenting a bearer token, which it must not validate", async () => {
    // Before the gateway, this Worker would have called whoami with this. Now
    // a credential means nothing here: only the gateway's verdict does.
    const response = await worker.fetch(
      request("/mcp", { authorization: "Bearer lp_something" }),
      env,
    );
    expect(response.status).toBe(500);
  });

  it("refuses an identity sent without the encoding declaration", async () => {
    const { "x-lost-plus-encoding": _, ...unencoded } = IDENTITY;
    const response = await worker.fetch(request("/mcp", unencoded), env);
    expect(response.status).toBe(500);
  });

  it("refuses a partial identity", async () => {
    const { "x-lost-plus-role": _, ...partial } = IDENTITY;
    const response = await worker.fetch(request("/mcp", partial), env);
    expect(response.status).toBe(500);
  });
});

describe("with gateway identity headers", () => {
  it("404s a path it does not serve", async () => {
    // Including `/`, /healthz and the metadata document: the gateway routes
    // only /mcp here, so nothing else is served.
    for (const path of ["/", "/healthz", "/.well-known/oauth-protected-resource/mcp", "/nope"]) {
      const response = await worker.fetch(request(path, IDENTITY), env);
      expect(response.status).toBe(404);
    }
  });
});
