# tweet-fetch-mcp

MCP server that converts Twitter/X.com tweet URLs into fxtwitter API JSON.

A Cloudflare Worker (`tweet-fetch`) with no route of its own. It is reached
only through the service binding `TWEET_FETCH` that the `auth-gateway` Worker
declares, and holds no state: no D1, KV, R2, or Durable Object. Every tool call
is one outbound request to `api.fxtwitter.com`.

Until 2026-09-18 the same server ran as a Python container on OCI behind the
machine gateway; that code was removed once the Worker was verified live.

## Authentication, and why there is none in this repo

There is no authentication code here, on purpose. `tweet.lost.plus` belongs to
the gateway Worker, which validates the caller's credential against Common Auth
and then invokes this Worker over a service binding. By the time a request
arrives, someone has already decided the caller may have it.

What arrives is an identity, in five headers the gateway sets:
`x-lost-plus-sub`, `-email`, `-name`, `-role`, and `x-lost-plus-encoding:
percent-utf8`. The first four are percent-encoded; the shared
[`@lost-plus/gateway-identity`](https://github.com/LPFchan/gateway-identity)
package decodes them.
The credential itself is stripped by the gateway and never reaches this Worker,
so there is nothing here to validate and nothing to replay elsewhere.

**Missing or unreadable identity headers are refused with a 500.** This Worker
is not reachable except through the gateway, so their absence means the
deployment is wrong — and a service that quietly serves unauthenticated traffic
when its front door is misconfigured is the exact failure the gateway
arrangement exists to prevent.

The gateway also owns, for this host: the `WWW-Authenticate` challenge, the RFC
9728 protected-resource metadata at
`/.well-known/oauth-protected-resource/mcp`, CORS and preflight, and `/healthz`.
None of those are served here.

Scope is `tweet-fetch`, registered in the gateway's route table
(`auth/gateway/config/cloudflare.gateway.json`), not in this repo.

## Tools

- `fetch_tweet(tweet_url)` — Returns the full fxtwitter v2 conversation response (status, thread, replies, author, cursor).
- `get_tweet_text(tweet_url)` — Returns just the tweet body text.
- `get_tweet_media(tweet_url)` — Returns a list of media attachments with URLs and dimensions.
- `get_tweet_author(tweet_url)` — Returns the author's profile info (name, handle, followers, avatar, bio, etc.).
- `get_tweet_stats(tweet_url)` — Returns engagement metrics (likes, retweets, replies, bookmarks, quotes, views).
- `get_thread(tweet_url)` — Returns the author's full self-reply thread (the unrolled thread).
- `get_replies(tweet_url)` — Returns replies from other users, ranked by likes.

The endpoint is stateless and speaks MCP 2026-07-28 as well as the 2025-era
revisions. 2026 clients are told to cache `tools/list` and `server/discover`
for five minutes (`cacheScope: private`).

## Usage

```json
{
  "mcpServers": {
    "tweet-fetch": {
      "type": "remote",
      "url": "https://tweet.lost.plus/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

## Development

```
npm run check    # tsc --noEmit
npm test         # vitest: refusal path, protocol eras, every tool with fxtwitter stubbed
```

## Deploy

```
npm run deploy   # wrangler deploy
```

Needs a Cloudflare API token in the environment (`CLOUDFLARE_API_TOKEN`). The
only configuration is `FETCH_TIMEOUT_MS` in `wrangler.toml`; there are no
secrets.

`wrangler.toml` declares no routes and `workers_dev = false`. Keep it that way:
the four `tweet.lost.plus` patterns are held by `auth-gateway`, and a deploy
that adds routes here would take them from the gateway and expose this Worker
without authentication.

**Rollback** is `git revert` (or checkout of the last good commit) and `npm run
deploy` again; there is no state to roll back with it. A broken gateway is the
auth repo's rollback, not this one's.
