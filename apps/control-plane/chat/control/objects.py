"""Checkpoint objects in S3.

Runtimes never hold storage credentials: they get short-lived presigned URLs.
"""

import hashlib
from functools import cache

from django.conf import settings

BUCKET = "axp-checkpoints"
URL_SECONDS = 3600


@cache
def _client():
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=settings.AXP_S3_ENDPOINT,
        region_name="us-east-1",
        aws_access_key_id=settings.AXP_S3_ACCESS_KEY_ID,
        aws_secret_access_key=settings.AXP_S3_SECRET_ACCESS_KEY,
        # SigV4 URLs do not sign Content-Type, which runtimes do not control.
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def ensure_bucket() -> None:
    client = _client()
    try:
        client.head_bucket(Bucket=BUCKET)
    except client.exceptions.ClientError:
        client.create_bucket(Bucket=BUCKET)


def _presign(method: str, key: str) -> str:
    return _client().generate_presigned_url(
        method, Params={"Bucket": BUCKET, "Key": key}, ExpiresIn=URL_SECONDS
    )


def upload_url(key: str) -> str:
    return _presign("put_object", key)


def download_url(key: str) -> str:
    return _presign("get_object", key)


def verify(key: str | None, checksum: str) -> bool:
    if not key:
        return False
    client = _client()
    try:
        body = client.get_object(Bucket=BUCKET, Key=key)["Body"]
    except client.exceptions.NoSuchKey:
        return False
    digest = hashlib.sha256()
    for chunk in iter(lambda: body.read(1 << 20), b""):
        digest.update(chunk)
    return digest.hexdigest() == checksum


def checkpoint_key(agent_id, checkpoint_id) -> str:
    return f"agents/{agent_id}/checkpoints/{checkpoint_id}.tar.gz"
