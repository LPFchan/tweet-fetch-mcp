// tweet-fetch Worker: MCP server on Cloudflare Workers, port of the
// Python tweet-fetch-mcp (fxtwitter backend). Authenticates machine tokens
// directly against Common Auth (whoami) instead of the loopback gateway.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export interface Env {
  AUTH_URL: string;
  TOKEN_SCOPE: string;
  FETCH_TIMEOUT_MS: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

const TWEET_URL_RE = /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/;

// --- auth --------------------------------------------------------------------

interface Identity {
  sub: string;
  email: string;
  name: string;
  role: string;
  services?: string[];
}

// Validate a credential against Common Auth. Two token types:
//   - machine tokens: GET /api/whoami?service=<scope>
//   - OAuth access tokens: GET /api/oauth/introspect?resource=<resource>&scope=<scope>
// Try whoami first (machine tokens), then introspect (OAuth). Mirrors the gateway.
async function validateToken(env: Env, token: string, requestUrl: string): Promise<Identity | null> {
  const resource = new URL(requestUrl).origin + "/mcp";

  // Machine token path
  try {
    const url = new URL("/api/whoami", env.AUTH_URL);
    url.searchParams.set("service", env.TOKEN_SCOPE);
    const resp = await fetch(url.toString(), {
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const identity = (await resp.json()) as Identity;
      if (
        identity.sub &&
        identity.email &&
        identity.name &&
        (identity.role === "administrator" || identity.role === "user")
      ) {
        return identity;
      }
    }
  } catch { /* fall through to introspect */ }

  // OAuth access token path
  try {
    const url = new URL("/api/oauth/introspect", env.AUTH_URL);
    url.searchParams.set("resource", resource);
    url.searchParams.set("scope", env.TOKEN_SCOPE);
    const resp = await fetch(url.toString(), {
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const identity = (await resp.json()) as Identity;
      if (
        identity.sub &&
        identity.email &&
        identity.name &&
        (identity.role === "administrator" || identity.role === "user")
      ) {
        return identity;
      }
    }
  } catch { /* reject */ }

  return null;
}

function extractToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const apiKey = request.headers.get("x-api-key");
  if (apiKey) return apiKey.trim();
  return null;
}

// MCP OAuth 2.0 Protected Resource Metadata — required by MCP clients
// (Claude.ai, etc.) to discover the authorization server.
function wwwAuthenticate(request: Request): string {
  const url = new URL(request.url);
  const resource = url.origin + "/mcp";
  const metadata = url.origin + "/.well-known/oauth-protected-resource/mcp";
  return 'Bearer realm="auth.lost.plus", resource_metadata="' + metadata + '", scope="tweet-fetch", error="invalid_token"';
}

// --- fxtwitter ---------------------------------------------------------------

async function fetchConversation(env: Env, tweetUrl: string): Promise<any> {
  const match = TWEET_URL_RE.exec(tweetUrl);
  if (!match) throw new Error("Invalid tweet URL: " + tweetUrl);
  const statusId = match[2];
  const timeoutMs = Number.parseInt(env.FETCH_TIMEOUT_MS || "15000", 10);
  const resp = await fetch("https://api.fxtwitter.com/2/conversation/" + statusId, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error("fxtwitter HTTP " + resp.status);
  const data = (await resp.json()) as any;
  if (data.code !== 200) {
    throw new Error("fxtwitter API error: " + (data.message ?? "unknown"));
  }
  return data;
}

// --- MCP server --------------------------------------------------------------

const tweetUrlParam = z.string().describe("Twitter/X.com status URL");

function text(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: "tweet-fetch", version: "0.1.0" });

  server.tool(
    "fetch_tweet",
    "Fetch tweet data from a Twitter/X.com URL using the fxtwitter API. Accepts x.com and twitter.com URLs including /photo/N suffixes. Returns the full v2 conversation response.",
    { tweet_url: tweetUrlParam },
    async ({ tweet_url }) => {
      const data = await fetchConversation(env, tweet_url);
      return text(data);
    },
  );

  server.tool(
    "get_tweet_text",
    "Extract just the tweet text from a Twitter/X.com URL.",
    { tweet_url: tweetUrlParam },
    async ({ tweet_url }) => {
      const data = await fetchConversation(env, tweet_url);
      return text(data.status.text);
    },
  );

  server.tool(
    "get_tweet_media",
    "Extract media URLs and metadata from a Twitter/X.com URL.",
    { tweet_url: tweetUrlParam },
    async ({ tweet_url }) => {
      const data = await fetchConversation(env, tweet_url);
      const all = data.status?.media?.all ?? [];
      return text(
        all.map((m: any) => ({ type: m.type, url: m.url, width: m.width, height: m.height })),
      );
    },
  );

  server.tool(
    "get_tweet_author",
    "Get the author/profile information from a Twitter/X.com tweet URL.",
    { tweet_url: tweetUrlParam },
    async ({ tweet_url }) => {
      const data = await fetchConversation(env, tweet_url);
      return text(data.author);
    },
  );

  server.tool(
    "get_tweet_stats",
    "Get engagement statistics from a Twitter/X.com tweet URL.",
    { tweet_url: tweetUrlParam },
    async ({ tweet_url }) => {
      const data = await fetchConversation(env, tweet_url);
      const s = data.status;
      return text({
        likes: s.likes ?? 0,
        retweets: s.retweets ?? s.reposts ?? 0,
        replies: s.replies ?? 0,
        bookmarks: s.bookmarks ?? 0,
        quotes: s.quotes ?? 0,
        views: s.views ?? 0,
      });
    },
  );

  server.tool(
    "get_thread",
    "Get the author's self-reply thread from a Twitter/X.com tweet URL.",
    { tweet_url: tweetUrlParam },
    async ({ tweet_url }) => {
      const data = await fetchConversation(env, tweet_url);
      return text(data.thread ?? []);
    },
  );

  server.tool(
    "get_replies",
    "Get replies to a tweet from a Twitter/X.com tweet URL, ranked by likes.",
    { tweet_url: tweetUrlParam },
    async ({ tweet_url }) => {
      const data = await fetchConversation(env, tweet_url);
      return text(data.replies ?? []);
    },
  );

  return server;
}

// --- CORS (mirrors the Python middleware) ------------------------------------

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name, last-event-id, x-api-key",
    "access-control-max-age": "86400",
    "access-control-expose-headers": "mcp-session-id, mcp-protocol-version, content-type",
  };
  if (origin) h["access-control-allow-origin"] = origin;
  return h;
}

// --- entry -------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true }, { headers: corsHeaders(origin) });
    }

    // Serve the OAuth protected-resource metadata so the whole discovery
    // chain works even when OCI (and its gateway) is down.
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return Response.json(
        {
          authorization_servers: ["https://auth.lost.plus"],
          bearer_methods_supported: ["header"],
          resource: url.origin + "/mcp",
          scopes_supported: ["tweet-fetch"],
        },
        { headers: { ...corsHeaders(origin), "cache-control": "no-store" } },
      );
    }

    if (url.pathname === "/" || url.pathname === "") {
      return Response.json(
        {
          name: "tweet-fetch-mcp",
          runtime: "cloudflare-workers",
          mcp_path: "/mcp",
          healthz: "/healthz",
          tools: [
            "fetch_tweet",
            "get_tweet_text",
            "get_tweet_media",
            "get_tweet_author",
            "get_tweet_stats",
            "get_thread",
            "get_replies",
          ],
        },
        { headers: corsHeaders(origin) },
      );
    }

    if (url.pathname !== "/mcp") {
      return new Response("not found", { status: 404, headers: corsHeaders(origin) });
    }

    // Auth: every /mcp request must carry a valid scoped machine token.
    const token = extractToken(request);
    if (!token) {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401,
        headers: { ...corsHeaders(origin), "content-type": "application/json", "www-authenticate": wwwAuthenticate(request) },
      });
    }
    const identity = await validateToken(env, token, request.url);
    if (!identity) {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401,
        headers: { ...corsHeaders(origin), "content-type": "application/json", "www-authenticate": wwwAuthenticate(request) },
      });
    }

    // Stateless MCP: fresh server + transport per request (no session state).
    const server = buildServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport();
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    // Attach CORS headers to the MCP response.
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
    headers.set("vary", "Origin");
    return new Response(response.body, { status: response.status, headers });
  },
};
