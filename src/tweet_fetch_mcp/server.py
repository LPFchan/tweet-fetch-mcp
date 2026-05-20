from __future__ import annotations

import contextlib
import fnmatch
import json
import os
import re
from urllib.parse import parse_qs, urlparse

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.responses import JSONResponse
import uvicorn


_service: FxTwitterClient | None = None


def _build_transport_security() -> TransportSecuritySettings:
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
    )


class _CORSMiddleware:
    def __init__(self, app):
        self.app = app
        raw = os.environ.get("ALLOWED_ORIGINS", os.environ.get("ALLOWED_ORIGIN", "https://chat.lost.plus"))
        self.allowed_origins = [o.strip() for o in raw.split(",") if o.strip()]
        self.cors_methods = b"GET, POST, DELETE, OPTIONS"
        self.cors_headers = b"Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID"

    def _match_origin(self, origin: str | None) -> str | None:
        if not origin:
            return None
        for pattern in self.allowed_origins:
            if fnmatch.fnmatch(origin, pattern):
                return origin
        return None

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        origin = headers.get(b"origin")
        matched = self._match_origin(origin.decode() if origin else None)

        if scope["method"] == "OPTIONS":
            resp_headers = [
                (b"access-control-allow-methods", self.cors_methods),
                (b"access-control-allow-headers", self.cors_headers),
                (b"access-control-max-age", b"86400"),
                (b"access-control-expose-headers", b"Mcp-Session-Id"),
            ]
            if matched:
                resp_headers.insert(0, (b"access-control-allow-origin", matched.encode()))
            await send({"type": "http.response.start", "status": 204, "headers": resp_headers})
            await send({"type": "http.response.body", "body": b""})
            return

        async def send_with_cors(message):
            if message["type"] == "http.response.start":
                hlist = list(message.get("headers", []))
                if matched:
                    hlist.append((b"access-control-allow-origin", matched.encode()))
                hlist.append((b"access-control-expose-headers", b"Mcp-Session-Id"))
                message["headers"] = hlist
            await send(message)

        await self.app(scope, receive, send_with_cors)


class _AuthMiddleware:
    def __init__(self, app, tokens: list[str] | None):
        self.app = app
        self.tokens = set(tokens) if tokens else None

    async def __call__(self, scope, receive, send):
        if self.tokens is None:
            await self.app(scope, receive, send)
            return

        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path == "/healthz":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        auth_header = headers.get(b"authorization", b"").decode()

        if auth_header.startswith("Bearer ") and auth_header[7:] in self.tokens:
            await self.app(scope, receive, send)
            return

        token_values = parse_qs(scope.get("query_string", b"").decode()).get("token", [])
        if self.tokens & set(token_values):
            await self.app(scope, receive, send)
            return

        first_segment = path.strip("/").split("/")[0] if path.strip("/") else ""
        if first_segment in self.tokens:
            scope["path"] = "/" + "/".join(path.strip("/").split("/")[1:])
            await self.app(scope, receive, send)
            return

        body = json.dumps({"error": "Unauthorized"}).encode()
        await send({"type": "http.response.start", "status": 401, "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": body})


_TWEET_URL_RE = re.compile(
    r"https?://(?:www\.)?(?:twitter\.com|x\.com)/(\w+)/status/(\d+)"
)


_DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"
)


class FxTwitterClient:
    def __init__(self, timeout_seconds: float = 15):
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds),
            http2=True,
            headers={"User-Agent": _DEFAULT_USER_AGENT},
        )

    async def fetch_tweet(self, tweet_url: str) -> dict:
        match = _TWEET_URL_RE.search(tweet_url)
        if not match:
            raise ValueError(f"Invalid tweet URL: {tweet_url}")

        username = match.group(1)
        status_id = match.group(2)
        api_url = f"https://api.fxtwitter.com/{username}/status/{status_id}"

        resp = await self._client.get(api_url)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 200:
            raise RuntimeError(f"fxtwitter API error: {data.get('message', 'unknown')}")
        return data

    async def aclose(self) -> None:
        await self._client.aclose()


@contextlib.asynccontextmanager
async def mcp_lifespan(_: FastMCP):
    global _service
    _service = FxTwitterClient(
        timeout_seconds=float(os.environ.get("FETCH_TIMEOUT_SECONDS", "15")),
    )
    try:
        yield
    finally:
        if _service is not None:
            await _service.aclose()
        _service = None


mcp = FastMCP(
    "tweet-fetch",
    host=os.environ.get("HOST", "0.0.0.0"),
    port=int(os.environ.get("PORT", "8000")),
    streamable_http_path="/mcp",
    json_response=True,
    stateless_http=True,
    lifespan=mcp_lifespan,
    transport_security=_build_transport_security(),
)


@mcp.tool()
async def fetch_tweet(tweet_url: str) -> dict:
    """Fetch tweet data from a Twitter/X.com URL using the fxtwitter API.
    Accepts both x.com and twitter.com URLs, including ones with /photo/N suffixes.
    """
    return await _require_service().fetch_tweet(tweet_url)


def _require_service() -> FxTwitterClient:
    if _service is None:
        raise RuntimeError("Tweet fetch service is not ready")
    return _service


async def index(_: object) -> JSONResponse:
    return JSONResponse(
        {
            "name": "tweet-fetch-mcp",
            "mcp_path": "/mcp",
            "healthz": "/healthz",
            "tools": ["fetch_tweet"],
        }
    )


async def healthz(_: object) -> JSONResponse:
    return JSONResponse({"ok": True})


@mcp.custom_route("/", methods=["GET"], include_in_schema=False)
async def root_route(request):
    del request
    return await index(None)


@mcp.custom_route("/healthz", methods=["GET"], include_in_schema=False)
async def health_route(request):
    del request
    return await healthz(None)


_raw_tokens = os.environ.get("TWEET_FETCH_AUTH_TOKEN")
_auth_tokens: list[str] | None = None
if _raw_tokens:
    _auth_tokens = [t.strip() for t in _raw_tokens.split(",") if t.strip()]

app = _CORSMiddleware(
    _AuthMiddleware(
        mcp.streamable_http_app(),
        _auth_tokens,
    )
)


def main() -> None:
    uvicorn.run(
        app,
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8000")),
    )


if __name__ == "__main__":
    main()
