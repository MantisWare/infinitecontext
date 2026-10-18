"""HTTP request-path tests using httpx MockTransport (no network)."""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Generator, List
from unittest.mock import patch

import httpx
import pytest

from infinitecontext.client import AsyncInfiniteContext, InfiniteContext
from infinitecontext.exceptions import InfiniteContextHttpError

_RealSyncClient = httpx.Client
_RealAsyncClient = httpx.AsyncClient

def _sync_client() -> InfiniteContext:
    return InfiniteContext(api_key="ic_test_key", base_url="http://mock.test")


def _async_client() -> AsyncInfiniteContext:
    return AsyncInfiniteContext(api_key="ic_test_key", base_url="http://mock.test")


@contextmanager
def _patch_sync_transport(transport: httpx.MockTransport) -> Generator[None, None, None]:
    with patch(
        "infinitecontext.client.httpx.Client",
        side_effect=lambda *args, **kwargs: _RealSyncClient(
            transport=transport,
            timeout=kwargs["timeout"],
        ),
    ):
        yield


@contextmanager
def _patch_async_transport(transport: httpx.MockTransport) -> Generator[None, None, None]:
    with patch(
        "infinitecontext.client.httpx.AsyncClient",
        side_effect=lambda *args, **kwargs: _RealAsyncClient(
            transport=transport,
            timeout=kwargs["timeout"],
        ),
    ):
        yield


def test_create_posts_json_body() -> None:
    captured: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        assert request.method == "POST"
        assert request.url.path == "/contexts"
        assert request.headers["Authorization"] == "Bearer ic_test_key"
        assert json.loads(request.read()) == {"metadata": {"team": "qa"}}
        return httpx.Response(
            200,
            json={"id": "ctx_1", "created_at": "2026-01-01T00:00:00Z", "metadata": {"team": "qa"}},
        )

    transport = httpx.MockTransport(handler)
    client = _sync_client()

    with _patch_sync_transport(transport):
        result = client.create(metadata={"team": "qa"})

    assert result["id"] == "ctx_1"
    assert len(captured) == 1


def test_get_list_uses_limit_query() -> None:
    captured: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        assert request.method == "GET"
        assert request.url.path == "/contexts"
        assert request.url.params["limit"] == "5"
        return httpx.Response(200, json={"data": []})

    transport = httpx.MockTransport(handler)
    client = _sync_client()

    with _patch_sync_transport(transport):
        result = client.get(limit=5)

    assert result["data"] == []
    assert len(captured) == 1


def test_http_error_raises_infinite_context_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="unauthorized")

    transport = httpx.MockTransport(handler)
    client = _sync_client()

    with _patch_sync_transport(transport):
        with pytest.raises(InfiniteContextHttpError) as exc_info:
            client.get("ctx_missing")

    assert exc_info.value.status == 401


@pytest.mark.asyncio
async def test_async_append_posts_messages() -> None:
    captured: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        assert request.method == "POST"
        assert request.url.path == "/contexts/ctx/1"
        assert "ctx%2F1" in str(request.url)
        body = request.read()
        assert b'"role":"user"' in body
        return httpx.Response(
            200,
            json={
                "data": [{"id": "m1", "index": 0, "role": "user", "content": "hi"}],
                "version": 2,
            },
        )

    transport = httpx.MockTransport(handler)
    client = _async_client()

    with _patch_async_transport(transport):
        result = await client.append("ctx/1", {"role": "user", "content": "hi"})

    assert result["version"] == 2
    assert len(captured) == 1
