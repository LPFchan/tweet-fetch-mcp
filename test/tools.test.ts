import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTimeoutMs } from "../index";
import { legacy, modern } from "./helpers";

// Tool behavior, with fxtwitter replaced by a stub. These pin down what the
// Python server did -- the URL it built, the user-agent it sent, the shape of
// each tool's answer, and the message each failure produces -- so the port
// cannot drift from it without a test going red.

const CONVERSATION = {
  code: 200,
  message: "OK",
  status: {
    id: "1234567890",
    text: "hello world",
    likes: 10,
    retweets: 0,
    reposts: 3,
    replies: 2,
    bookmarks: 1,
    quotes: 4,
    views: 500,
    media: {
      all: [
        { type: "photo", url: "https://pbs.example/1.jpg", width: 100, height: 200, altText: "ignored" },
        { type: "video", url: "https://video.example/1.mp4", width: 1280, height: 720, duration: 12 },
      ],
    },
  },
  author: { screen_name: "someone", name: "Some One", followers: 5 },
  thread: [{ id: "1" }, { id: "2" }],
  replies: [{ id: "9", likes: 3 }],
};

type FetchCall = { url: string; init: RequestInit | undefined };
let calls: FetchCall[];
let reply: () => Response;

beforeEach(() => {
  calls = [];
  reply = () => Response.json(CONVERSATION);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return reply();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function call(name: string, tweet_url: unknown) {
  const { status, body } = await legacy("tools/call", { name, arguments: { tweet_url } });
  expect(status).toBe(200);
  return body.result;
}

function parsed(result: any): unknown {
  expect(result.isError).toBeUndefined();
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text);
}

describe("fxtwitter request", () => {
  const URL_FORMS: Array<[string, string]> = [
    ["x.com", "https://x.com/someone/status/1234567890"],
    ["twitter.com", "https://twitter.com/someone/status/1234567890"],
    ["www.twitter.com", "https://www.twitter.com/someone/status/1234567890"],
    ["http", "http://x.com/someone/status/1234567890"],
    ["/photo/N suffix", "https://x.com/someone/status/1234567890/photo/1"],
    ["query string", "https://x.com/someone/status/1234567890?s=20&t=abc"],
  ];

  for (const [label, url] of URL_FORMS) {
    it(`extracts the status id from a ${label} URL`, async () => {
      await call("fetch_tweet", url);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://api.fxtwitter.com/2/conversation/1234567890");
    });
  }

  it("sends the Safari user-agent the Python server sent", async () => {
    await call("fetch_tweet", "https://x.com/someone/status/1234567890");
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("user-agent")).toMatch(/^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10_15_7\).*Safari\/605\.1\.15$/);
  });

  it("attaches an abort signal so a hung upstream cannot hang the tool", async () => {
    await call("fetch_tweet", "https://x.com/someone/status/1234567890");
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("makes exactly one upstream request per tool call", async () => {
    await call("get_tweet_stats", "https://x.com/someone/status/1234567890");
    expect(calls).toHaveLength(1);
  });
});

describe("fetch timeout", () => {
  it("reads FETCH_TIMEOUT_MS", () => {
    expect(fetchTimeoutMs({ FETCH_TIMEOUT_MS: "2500" })).toBe(2500);
  });

  it("falls back to 15 seconds when the var is missing or not a positive number", () => {
    expect(fetchTimeoutMs({ FETCH_TIMEOUT_MS: "" })).toBe(15_000);
    expect(fetchTimeoutMs({ FETCH_TIMEOUT_MS: "abc" })).toBe(15_000);
    expect(fetchTimeoutMs({ FETCH_TIMEOUT_MS: "0" })).toBe(15_000);
    expect(fetchTimeoutMs({ FETCH_TIMEOUT_MS: "-5" })).toBe(15_000);
    expect(fetchTimeoutMs({} as any)).toBe(15_000);
  });

  it("surfaces an upstream timeout as a tool error, not a crash", async () => {
    reply = () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const result = await call("fetch_tweet", "https://x.com/someone/status/1234567890");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timeout/i);
  });
});

describe("failures", () => {
  it("rejects a URL that is not a tweet, before touching the network", async () => {
    for (const bad of ["https://example.com/a/status/1", "https://x.com/someone", "not a url", ""]) {
      const result = await call("fetch_tweet", bad);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Invalid tweet URL: " + bad);
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-string tweet_url with a validation error", async () => {
    const result = await call("fetch_tweet", 123);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/tweet_url/);
    expect(calls).toHaveLength(0);
  });

  it("reports an upstream HTTP failure by status", async () => {
    reply = () => new Response("nope", { status: 503 });
    const result = await call("fetch_tweet", "https://x.com/someone/status/1234567890");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("fxtwitter HTTP 503");
  });

  it("reports an fxtwitter-level error by its message", async () => {
    reply = () => Response.json({ code: 404, message: "NOT_FOUND" });
    const result = await call("fetch_tweet", "https://x.com/someone/status/1234567890");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("fxtwitter API error: NOT_FOUND");
  });

  it("says 'unknown' when fxtwitter gives no message", async () => {
    reply = () => Response.json({ code: 500 });
    const result = await call("fetch_tweet", "https://x.com/someone/status/1234567890");
    expect(result.content[0].text).toBe("fxtwitter API error: unknown");
  });

  it("does not crash on a non-JSON upstream body", async () => {
    reply = () => new Response("<html>", { status: 200 });
    const result = await call("fetch_tweet", "https://x.com/someone/status/1234567890");
    expect(result.isError).toBe(true);
  });
});

describe("tool answers", () => {
  const URL = "https://x.com/someone/status/1234567890";

  it("fetch_tweet returns the whole conversation document", async () => {
    expect(parsed(await call("fetch_tweet", URL))).toEqual(CONVERSATION);
  });

  it("get_tweet_text returns the bare text, not JSON", async () => {
    const result = await call("get_tweet_text", URL);
    expect(result.content[0].text).toBe("hello world");
  });

  it("get_tweet_media keeps only type, url, width and height", async () => {
    expect(parsed(await call("get_tweet_media", URL))).toEqual([
      { type: "photo", url: "https://pbs.example/1.jpg", width: 100, height: 200 },
      { type: "video", url: "https://video.example/1.mp4", width: 1280, height: 720 },
    ]);
  });

  it("get_tweet_media is [] when the tweet has no media", async () => {
    reply = () => Response.json({ ...CONVERSATION, status: { ...CONVERSATION.status, media: undefined } });
    expect(parsed(await call("get_tweet_media", URL))).toEqual([]);

    reply = () => Response.json({ ...CONVERSATION, status: { ...CONVERSATION.status, media: { all: null } } });
    expect(parsed(await call("get_tweet_media", URL))).toEqual([]);
  });

  it("get_tweet_author returns the author object", async () => {
    expect(parsed(await call("get_tweet_author", URL))).toEqual(CONVERSATION.author);
  });

  it("get_tweet_stats falls through from retweets to reposts, and zero-fills", async () => {
    // retweets is 0 in the fixture and reposts is 3: the Python used `or`, so
    // 3 wins. `??` would have answered 0.
    expect(parsed(await call("get_tweet_stats", URL))).toEqual({
      likes: 10,
      retweets: 3,
      replies: 2,
      bookmarks: 1,
      quotes: 4,
      views: 500,
    });

    reply = () => Response.json({ ...CONVERSATION, status: { text: "x" } });
    expect(parsed(await call("get_tweet_stats", URL))).toEqual({
      likes: 0,
      retweets: 0,
      replies: 0,
      bookmarks: 0,
      quotes: 0,
      views: 0,
    });
  });

  it("get_thread and get_replies return the arrays, or [] when absent", async () => {
    expect(parsed(await call("get_thread", URL))).toEqual(CONVERSATION.thread);
    expect(parsed(await call("get_replies", URL))).toEqual(CONVERSATION.replies);

    reply = () => Response.json({ ...CONVERSATION, thread: null, replies: undefined });
    expect(parsed(await call("get_thread", URL))).toEqual([]);
    expect(parsed(await call("get_replies", URL))).toEqual([]);
  });

  it("serves the same tool to a 2026-07-28 client", async () => {
    const { status, body } = await modern("tools/call", { name: "get_tweet_text", arguments: { tweet_url: URL } });
    expect(status).toBe(200);
    expect(body.result.content[0].text).toBe("hello world");
    expect(calls).toHaveLength(1);
  });
});
