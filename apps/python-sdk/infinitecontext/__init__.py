"""InfiniteContext - The context API for AI agents."""

from .client import AsyncInfiniteContext, InfiniteContext
from .exceptions import InfiniteContextError, InfiniteContextHttpError
from .types import (
    AppendResponse,
    Context,
    CreateContextResponse,
    DeleteManyResponse,
    DeleteManyResult,
    DeleteResponse,
    GetContextResponse,
    ListContextsResponse,
    Message,
    PermanentDeleteResponse,
    UpdateResponse,
    Version,
)

__version__ = "1.0.1"
__all__ = [
    # clients
    "InfiniteContext",
    "AsyncInfiniteContext",
    # exceptions
    "InfiniteContextError",
    "InfiniteContextHttpError",
    # types
    "Context",
    "Message",
    "Version",
    "CreateContextResponse",
    "ListContextsResponse",
    "GetContextResponse",
    "AppendResponse",
    "UpdateResponse",
    "DeleteResponse",
    "PermanentDeleteResponse",
    "DeleteManyResult",
    "DeleteManyResponse",
]
