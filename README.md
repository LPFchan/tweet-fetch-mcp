# tweet-fetch-mcp

MCP server that converts Twitter/X.com tweet URLs into fxtwitter API JSON.

The HTTP endpoint uses the official MCP Python SDK v2 and supports the
`2026-07-28` stateless protocol via `server/discover`, with a stateless legacy
fallback for clients that still use `initialize`.

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
