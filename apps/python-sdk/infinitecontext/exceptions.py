"""InfiniteContext exceptions."""

from typing import Optional


class InfiniteContextError(Exception):
    """Base exception for InfiniteContext."""

    pass


class InfiniteContextHttpError(InfiniteContextError):
    """HTTP error from InfiniteContext API."""

    def __init__(self, message: str, status: int, url: str, body: Optional[str] = None):
        super().__init__(message)
        self.status = status
        self.url = url
        self.body = body
