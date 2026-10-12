import os

from infinitecontext.client import InfiniteContext
from infinitecontext.constants import HOSTED_API_BASE_URL


def test_default_hosted_base_url():
    old = os.environ.pop("INFINITECONTEXT_BASE_URL", None)
    try:
        client = InfiniteContext(api_key="ic_test_x")
        assert client._base_url == HOSTED_API_BASE_URL
    finally:
        if old is not None:
            os.environ["INFINITECONTEXT_BASE_URL"] = old


def test_base_url_from_env():
    os.environ["INFINITECONTEXT_BASE_URL"] = "http://127.0.0.1:8787/"
    client = InfiniteContext(api_key="ic_test_x")
    assert client._base_url == "http://127.0.0.1:8787"
