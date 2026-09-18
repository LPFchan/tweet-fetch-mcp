// tweet-fetch Worker: MCP server on Cloudflare Workers, port of the Python
// tweet-fetch-mcp (fxtwitter backend).
//
// This Worker declares no route of its own. tweet.lost.plus belongs to the
// gateway Worker, which validates the caller's credential against Common Auth
// and then invokes this one over a service binding. So this file has no
// authentication in it at all: no whoami call, no introspection, no bearer
// challenge, no RFC 9728 metadata document, no CORS. All five of those are the
// gateway's, and a second copy here could only drift from them.
//
// What arrives instead is an identity the gateway has already established. See
// identity.ts.
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";

import { identityFrom } from "./identity";

export interface Env {
  FETCH_TIMEOUT_MS: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

const TWEET_URL_RE = /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/;

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

  server.registerTool("fetch_tweet", { description: "Fetch tweet data from a Twitter/X.com URL using the fxtwitter API. Accepts x.com and twitter.com URLs including /photo/N suffixes. Returns the full v2 conversation response.", inputSchema: z.object({ tweet_url: tweetUrlParam }) }, async ({ tweet_url }) => {
              const data = await fetchConversation(env, tweet_url);
              return text(data);
            });

  server.registerTool("get_tweet_text", { description: "Extract just the tweet text from a Twitter/X.com URL.", inputSchema: z.object({ tweet_url: tweetUrlParam }) }, async ({ tweet_url }) => {
              const data = await fetchConversation(env, tweet_url);
              return text(data.status.text);
            });

  server.registerTool("get_tweet_media", { description: "Extract media URLs and metadata from a Twitter/X.com URL.", inputSchema: z.object({ tweet_url: tweetUrlParam }) }, async ({ tweet_url }) => {
              const data = await fetchConversation(env, tweet_url);
              const all = data.status?.media?.all ?? [];
              return text(
                all.map((m: any) => ({ type: m.type, url: m.url, width: m.width, height: m.height })),
              );
            });

  server.registerTool("get_tweet_author", { description: "Get the author/profile information from a Twitter/X.com tweet URL.", inputSchema: z.object({ tweet_url: tweetUrlParam }) }, async ({ tweet_url }) => {
              const data = await fetchConversation(env, tweet_url);
              return text(data.author);
            });

  server.registerTool("get_tweet_stats", { description: "Get engagement statistics from a Twitter/X.com tweet URL.", inputSchema: z.object({ tweet_url: tweetUrlParam }) }, async ({ tweet_url }) => {
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
            });

  server.registerTool("get_thread", { description: "Get the author's self-reply thread from a Twitter/X.com tweet URL.", inputSchema: z.object({ tweet_url: tweetUrlParam }) }, async ({ tweet_url }) => {
              const data = await fetchConversation(env, tweet_url);
              return text(data.thread ?? []);
            });

  server.registerTool("get_replies", { description: "Get replies to a tweet from a Twitter/X.com tweet URL, ranked by likes.", inputSchema: z.object({ tweet_url: tweetUrlParam }) }, async ({ tweet_url }) => {
              const data = await fetchConversation(env, tweet_url);
              return text(data.replies ?? []);
            });

  return server;
}

// --- entry -------------------------------------------------------------------

/**
 * No identity headers, so no service.
 *
 * The only way to reach this Worker is through a service binding declared by
 * another Worker in the account, and the only Worker that declares one is the
 * gateway, which never forwards a request it has not authorized. So arriving
 * here without an identity means the deployment is wrong -- the gateway's
 * route for this host lost its `mcp` policy, or something else in the account
 * bound to this Worker directly.
 *
 * 500 rather than 401, because it is true. A 401 would tell the caller to
 * authenticate, and the caller may well have done so correctly; the fault is
 * on this side of the binding. Serving the tools anyway is the specific
 * failure the whole gateway arrangement exists to prevent, so this refuses.
 */
function refused(): Response {
  return Response.json(
    { error: "no gateway identity", detail: "this service is only reachable through the gateway" },
    { status: 500 },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Before routing, not after. There is no path here that serves without an
    // identity, so there is no reason for one to be reachable before the check.
    const identity = identityFrom(request.headers);
    if (identity === null) return refused();

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return Response.json({
        name: "tweet-fetch-mcp",
        runtime: "cloudflare-workers",
        mcp_path: "/mcp",
        caller: { sub: identity.sub, email: identity.email, name: identity.name, role: identity.role },
        tools: [
          "fetch_tweet",
          "get_tweet_text",
          "get_tweet_media",
          "get_tweet_author",
          "get_tweet_stats",
          "get_thread",
          "get_replies",
        ],
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("not found", { status: 404 });
    }

    // Stateless MCP: fresh server + transport per request (no session state).
    const server = buildServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport();
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
