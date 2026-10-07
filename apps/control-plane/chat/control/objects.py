"""Agent snapshots in S3: one object per agent, replaced after every turn.

Runtimes never hold storage credentials: they get short-lived presigned URLs
for their own agent's object only.
"""

from functools import cache

from django.conf import settings

BUCKET = "axp-agents"
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


def _key(agent_id) -> str:
    return f"agents/{agent_id}/snapshot.tar.zst"


def _presign(method: str, agent_id) -> str:
    return _client().generate_presigned_url(
        method, Params={"Bucket": BUCKET, "Key": _key(agent_id)}, ExpiresIn=URL_SECONDS
    )


def snapshot_exists(agent_id) -> bool:
    client = _client()
    try:
        client.head_object(Bucket=BUCKET, Key=_key(agent_id))
    except client.exceptions.ClientError as exc:
        if exc.response["Error"]["Code"] in ("404", "NoSuchKey"):
            return False
        raise
    return True


def upload_url(agent_id) -> str:
    return _presign("put_object", agent_id)


def download_url(agent_id) -> str:
    return _presign("get_object", agent_id)
