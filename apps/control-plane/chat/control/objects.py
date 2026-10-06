"""Checkpoint object storage.

Runtimes never hold storage credentials: they get a short-lived URL. The
filesystem backend serves those URLs from the internal API; the S3 backend
uses presigned URLs.
"""

import hashlib
from functools import cache
from pathlib import Path

from django.conf import settings


class FilesystemStore:
    def __init__(self, root: Path):
        self.root = root

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if self.root.resolve() not in path.parents:
            raise ValueError("invalid object key")
        return path

    def upload_target(self, key: str, checkpoint_id) -> dict:
        base = settings.AXP_INTERNAL_URL
        return {"url": f"{base}/internal/v1/checkpoints/{checkpoint_id}/object"}

    def download_target(self, key: str, checkpoint_id) -> dict:
        return self.upload_target(key, checkpoint_id)

    def write(self, key: str, stream, chunk_size: int = 1 << 20) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".partial")
        with open(tmp, "wb") as handle:
            while chunk := stream.read(chunk_size):
                handle.write(chunk)
        tmp.replace(path)

    def open(self, key: str):
        return open(self._path(key), "rb")

    def verify(self, key: str | None, checksum: str) -> bool:
        if not key:
            return False
        try:
            digest = hashlib.sha256()
            with self.open(key) as handle:
                while chunk := handle.read(1 << 20):
                    digest.update(chunk)
        except FileNotFoundError:
            return False
        return digest.hexdigest() == checksum


class S3Store:
    def __init__(self, bucket: str):
        import boto3

        self.bucket = bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.AXP_S3_ENDPOINT or None,
            region_name=settings.AXP_S3_REGION,
            aws_access_key_id=settings.AXP_S3_ACCESS_KEY_ID or None,
            aws_secret_access_key=settings.AXP_S3_SECRET_ACCESS_KEY or None,
        )

    def _presign(self, method: str, key: str, **params) -> str:
        return self.client.generate_presigned_url(
            method, Params={"Bucket": self.bucket, "Key": key, **params}, ExpiresIn=3600
        )

    def upload_target(self, key: str, checkpoint_id) -> dict:
        return {"url": self._presign("put_object", key)}

    def download_target(self, key: str, checkpoint_id) -> dict:
        return {"url": self._presign("get_object", key)}

    def verify(self, key: str | None, checksum: str) -> bool:
        if not key:
            return False
        digest = hashlib.sha256()
        try:
            body = self.client.get_object(Bucket=self.bucket, Key=key)["Body"]
        except self.client.exceptions.NoSuchKey:
            return False
        for chunk in iter(lambda: body.read(1 << 20), b""):
            digest.update(chunk)
        return digest.hexdigest() == checksum


@cache
def object_store():
    if settings.AXP_OBJECT_STORE == "s3":
        return S3Store(settings.AXP_S3_CHECKPOINT_BUCKET)
    return FilesystemStore(Path(settings.AXP_OBJECT_DIR))


def checkpoint_key(agent_id, checkpoint_id) -> str:
    return f"agents/{agent_id}/checkpoints/{checkpoint_id}.tar.gz"
