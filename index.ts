// tweet-fetch Worker: MCP server on Cloudflare Workers (fxtwitter backend).
//
// This Worker declares no route of its own. tweet.lost.plus belongs to the
// gateway Worker, which validates the caller's credential against Common Auth
// and then invokes this one over a service binding. So this file has no
// authentication in it at all: no whoami call, no introspection, no bearer
// challenge, no RFC 9728 metadata document, no CORS, no /healthz. All of those
// are the gateway's, and a second copy here could only drift from them.
//
// What arrives instead is an identity the gateway has already established,
// read by @lpfchan/gateway-identity (the shared parser every lost.plus
// service uses).
import { identityFrom } from "@lpfchan/gateway-identity";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

export interface Env {
  FETCH_TIMEOUT_MS: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

const TWEET_URL_RE = /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/;

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

// --- fxtwitter ---------------------------------------------------------------

/** The configured timeout, or the default when the var is missing or not a positive number. */
export function fetchTimeoutMs(env: Env): number {
  const parsed = Number.parseInt(env.FETCH_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FETCH_TIMEOUT_MS;
}

async function fxtwitter(env: Env, url: string): Promise<any> {
  const resp = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(fetchTimeoutMs(env)),
  });
  if (!resp.ok) throw new Error("fxtwitter HTTP " + resp.status);
  const data = (await resp.json()) as any;
  if (data.code !== 200) {
    throw new Error("fxtwitter API error: " + (data.message ?? "unknown"));
  }
  return data;
}

/**
 * The v2 conversation document. With `fallback`, a failed v2 call retries on
 * the v1 status endpoint and answers in v2's shape with no thread or replies.
 * fxtwitter answers 404 whenever its own fetch from X fails, not only when the
 * tweet is gone, and v1 is a lighter fetch that often still succeeds.
 * get_thread and get_replies do not take it: v1 has neither, and an empty list
 * would read as "none" rather than "unavailable".
 */
async function fetchConversation(env: Env, tweetUrl: string, fallback = false): Promise<any> {
  const match = TWEET_URL_RE.exec(tweetUrl);
  if (!match) throw new Error("Invalid tweet URL: " + tweetUrl);
  const statusId = match[2];
  try {
    return await fxtwitter(env, "https://api.fxtwitter.com/2/conversation/" + statusId);
  } catch (v2Error) {
    if (!fallback) throw v2Error;
    try {
      const { tweet } = await fxtwitter(env, "https://api.fxtwitter.com/status/" + statusId);
      return { code: 200, fallback: "v1", status: tweet, author: tweet.author, thread: null, replies: null };
    } catch (v1Error) {
      throw new Error(`${(v2Error as Error).message} (v1 fallback: ${(v1Error as Error).message})`);
    }
  }
}

// --- MCP server --------------------------------------------------------------

const tweetUrlParam = z.string().describe("Twitter/X.com status URL");

function text(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

export const TOOL_NAMES = [
  "fetch_tweet",
  "get_tweet_text",
  "get_tweet_media",
  "get_tweet_author",
  "get_tweet_stats",
  "get_thread",
  "get_replies",
] as const;

export function buildServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "tweet-fetch", version: "0.1.0" },
    {
      // Only 2026-07-28 clients see these; 2025-era responses are unaffected.
      // The tool list is the same for every caller today, but `private` is the
      // safe default and costs nothing.
      cacheHints: {
        "tools/list": { ttlMs: 300_000, cacheScope: "private" },
        "server/discover": { ttlMs: 300_000, cacheScope: "private" },
      },
    },
  );

  server.registerTool(
    "fetch_tweet",
    {
      description:
        "Fetch tweet data from a Twitter/X.com URL using the fxtwitter API. Accepts x.com and twitter.com URLs including /photo/N suffixes. Returns the full v2 conversation response (status, thread, replies, author, cursor). If v2 fails, falls back to the v1 status endpoint: `fallback: \"v1\"` is set and thread and replies are null.",
      inputSchema: z.object({ tweet_url: tweetUrlParam }),
    },
    async ({ tweet_url }) => text(await fetchConversation(env, tweet_url, true)),
  );

  server.registerTool(
    "get_tweet_text",
    {
      description: "Extract just the tweet text from a Twitter/X.com URL. Returns the clean text body without metadata.",
      inputSchema: z.object({ tweet_url: tweetUrlParam }),
    },
    async ({ tweet_url }) => {
      const data = await fetchConversation(env, tweet_url, true);
      return text(data.status.text);
    },
  );

  server.registerTool(
    "get_tweet_media",
    {
      description:
        "Extract media URLs and metadata from a Twitter/X.com URL. Returns a list of media objects with type, url, width and height.",
      inputSchema: z.object({ tweet_url: tweetUrlParam }),
    },
    async ({ tweet_url }) => {
      const data = await fetchConversation(env, tweet_url, true);
      const all = data.status?.media?.all ?? [];
      return text(all.map((m: any) => ({ type: m.type, url: m.url, width: m.width, height: m.height })));
    },
  );

  server.registerTool(
    "get_tweet_author",
    {
      description:
        "Get the author/profile information from a Twitter/X.com tweet URL. Returns screen_name, name, followers, following, description, avatar, banner, joined date, verification status and location.",
      inputSchema: z.object({ tweet_url: tweetUrlParam }),
    },
    async ({ tweet_url }) => {
      const data = await fetchConversation(env, tweet_url, true);
      return text(data.author);
    },
  );

  server.registerTool(
    "get_tweet_stats",
    {
      description:
        "Get engagement statistics from a Twitter/X.com tweet URL. Returns likes, retweets, replies, bookmarks, quotes and views.",
      inputSchema: z.object({ tweet_url: tweetUrlParam }),
    },
    async ({ tweet_url }) => {
      const data = await fetchConversation(env, tweet_url, true);
      const s = data.status;
      return text({
        likes: s.likes ?? 0,
        // `||` rather than `??`: fxtwitter has shipped both `retweets` and
        // `reposts`, and a zero in the first should still fall through to the
        // second. This is what the Python did.
        retweets: s.retweets || s.reposts || 0,
        replies: s.replies ?? 0,
        bookmarks: s.bookmarks ?? 0,
        quotes: s.quotes ?? 0,
        views: s.views ?? 0,
      });
    },
  );

  server.registerTool(
    "get_thread",
    {
      description:
        "Get the author's self-reply thread from a Twitter/X.com tweet URL. Returns the full unrolled thread (the author's own reply chain, walking all the way to root).",
      inputSchema: z.object({ tweet_url: tweetUrlParam }),
    },
    async ({ tweet_url }) => {
      const data = await fetchConversation(env, tweet_url);
      return text(data.thread ?? []);
    },
  );

  server.registerTool(
    "get_replies",
    {
      description: "Get replies to a tweet from a Twitter/X.com tweet URL. Returns replies from other users, ranked by likes.",
      inputSchema: z.object({ tweet_url: tweetUrlParam }),
    },
    async ({ tweet_url }) => {
      const data = await fetchConversation(env, tweet_url);
      return text(data.replies ?? []);
    },
  );

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
    if (identityFrom(request.headers) === null) return refused();

    const url = new URL(request.url);

    // Only /mcp. The gateway routes nothing else here (`/` never arrives in
    // production), so nothing else is served.
    //
    // `/mcp/` as well as `/mcp`: the gateway forwards the path exactly as it
    // received it, its route covers both spellings, and clients have sent the
    // trailing slash before (the Python server rewrote it for that reason).
    if (url.pathname !== "/mcp" && url.pathname !== "/mcp/") {
      return new Response("not found", { status: 404 });
    }

    // Stateless: a fresh handler per request and no session. `createMcpHandler`
    // serves the 2026-07-28 revision natively (which is where `cacheHints`
    // take effect) and answers 2025-era clients through its stateless fallback
    // from the same factory, so both eras see the same tools. Not closed here:
    // the response body may still be streaming when `fetch` resolves, and a
    // per-request handler holds nothing that outlives the request.
    return createMcpHandler(() => buildServer(env)).fetch(request);
  },
};
