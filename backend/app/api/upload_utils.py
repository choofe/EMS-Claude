"""Shared upload plumbing for the Excel/CSV import endpoints (equipment, personnel): the declared Content-Length is
checked BEFORE the body is read, and the bytes read are bounded again. Chunked uploads are refused with 411."""
from fastapi import Request, UploadFile
from fastapi.routing import APIRoute

from app.core.config import get_settings
from app.core.errors import DomainError

_MULTIPART_OVERHEAD = 64 * 1024


class UploadRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request: Request):
            limit = get_settings().import_max_bytes
            length = request.headers.get("content-length")
            if length is None or not length.isdigit():
                raise DomainError("length_required", 411)
            if int(length) > limit + _MULTIPART_OVERHEAD:
                raise DomainError("file_too_large", 413, max_bytes=limit)
            return await original(request)

        return handler


async def read_upload(file: UploadFile) -> bytes:
    limit = get_settings().import_max_bytes
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise DomainError("file_too_large", 413, max_bytes=limit)
    return data
