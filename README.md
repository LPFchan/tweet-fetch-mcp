# tweet-fetch-mcp

MCP server that converts Twitter/X.com tweet URLs into fxtwitter API JSON.

## Tools

- `fetch_tweet(tweet_url)` — Accepts an x.com or twitter.com tweet URL, returns the fxtwitter API JSON response.

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
