"""Forward Anthropic Messages requests to the upstream (real Anthropic or mock).

Owner: Agent A.
"""
from __future__ import annotations

import os
from typing import Any, Mapping, Optional

import httpx

UPSTREAM = os.environ.get("TRIPWIRE_UPSTREAM", "http://localhost:8788").rstrip("/")
# Real Claude models (claude-*) always go here, so mock and real runs share one dashboard.
REAL_UPSTREAM = os.environ.get("TRIPWIRE_REAL_UPSTREAM", "https://api.anthropic.com").rstrip("/")
PASS_HEADERS = ("x-api-key", "authorization", "anthropic-version", "anthropic-beta")
TIMEOUT = float(os.environ.get("TRIPWIRE_UPSTREAM_TIMEOUT", "300"))

_client: Optional[httpx.AsyncClient] = None


def is_real_anthropic(url: str = UPSTREAM) -> bool:
    return "api.anthropic.com" in url


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(TIMEOUT, connect=10.0))
    return _client


async def close() -> None:
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


def upstream_for(model: str) -> str:
    return REAL_UPSTREAM if str(model).startswith("claude") else UPSTREAM


def build_headers(incoming: Mapping[str, str], url: str = UPSTREAM) -> dict[str, str]:
    lower = {k.lower(): v for k, v in incoming.items()}
    headers = {k: lower[k] for k in PASS_HEADERS if k in lower}
    headers["content-type"] = "application/json"
    if is_real_anthropic(url):
        if "x-api-key" not in headers and "authorization" not in headers:
            key = os.environ.get("ANTHROPIC_API_KEY", "")
            if key:
                headers["x-api-key"] = key
        headers.setdefault("anthropic-version", "2023-06-01")
    return headers


async def forward(body: dict[str, Any], incoming_headers: Mapping[str, str]) -> httpx.Response:
    """POST body to {upstream_for(model)}/v1/messages. Raises httpx.HTTPError on transport failure."""
    url = upstream_for(body.get("model", ""))
    return await get_client().post(f"{url}/v1/messages", json=body, headers=build_headers(incoming_headers, url))
