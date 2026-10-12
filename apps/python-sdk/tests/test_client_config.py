import os

import pytest

from infinitecontext.client import InfiniteContext


def test_base_url_required():
    old = os.environ.pop("INFINITECONTEXT_BASE_URL", None)
    try:
        with pytest.raises(ValueError, match="base_url is required"):
            InfiniteContext(api_key="ic_test_x")
    finally:
        if old is not None:
            os.environ["INFINITECONTEXT_BASE_URL"] = old


def test_base_url_from_env():
    os.environ["INFINITECONTEXT_BASE_URL"] = "http://127.0.0.1:8787/"
    client = InfiniteContext(api_key="ic_test_x")
    assert client._base_url == "http://127.0.0.1:8787"
