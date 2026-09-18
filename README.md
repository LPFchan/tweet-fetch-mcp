# tweet-fetch-mcp

MCP server that converts Twitter/X.com tweet URLs into fxtwitter API JSON.

Two runtimes:

- **Cloudflare Workers** (root) — the primary runtime. A route-less Worker,
  reachable only through the service binding the `auth-gateway` Worker declares.
- **Python** (`python/`) — legacy OCI backend, kept as fallback. Runs behind the
  machine auth gateway on loopback.

## Authentication, and why there is none in this repo

There is no authentication code here, on purpose. `tweet.lost.plus` belongs to
the gateway Worker, which validates the caller's credential against Common Auth
and then invokes this Worker over a service binding. By the time a request
arrives, someone has already decided the caller may have it.

What arrives is an identity, in five headers the gateway sets:
`x-lost-plus-sub`, `-email`, `-name`, `-role`, and `x-lost-plus-encoding:
percent-utf8`. The first four are percent-encoded; `identity.ts` decodes them.
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

Scope is `tweet-fetch`, and it now lives in the gateway's route table rather
than in this repo's configuration.

## Tools

- `fetch_tweet(tweet_url)` — Returns the full fxtwitter v2 conversation response (status, thread, replies, author, cursor).
- `get_tweet_text(tweet_url)` — Returns just the tweet body text.
- `get_tweet_media(tweet_url)` — Returns a list of media attachments with URLs and dimensions.
- `get_tweet_author(tweet_url)` — Returns the author's profile info (name, handle, followers, avatar, bio, etc.).
- `get_tweet_stats(tweet_url)` — Returns engagement metrics (likes, retweets, replies, bookmarks, quotes, views).
- `get_thread(tweet_url)` — Returns the author's full self-reply thread (the unrolled thread).
- `get_replies(tweet_url)` — Returns replies from other users, ranked by likes.

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
npm test         # vitest: identity header parsing, and the refusal path
```

Deploying this Worker is sequenced with the gateway's routes. The order, and
what breaks if it is wrong, is written out in `auth/gateway/wrangler.toml`.
