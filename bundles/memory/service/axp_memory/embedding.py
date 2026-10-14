"""INT8 CPU embeddings, or an OpenAI-compatible external embedding API."""

import hashlib
import json
import math
import os
import shutil
from pathlib import Path
from urllib.parse import urlsplit

from mem0.configs.embeddings.base import BaseEmbedderConfig
from mem0.embeddings.base import EmbeddingBase
from openai import APIError, OpenAI

MODEL = "axp/jina-embeddings-v2-base-zh-int8"
REPOSITORY = "jinaai/jina-embeddings-v2-base-zh"
REVISION = "c1ff9086a89a1123d7b5eff58055a665db4fb4b9"
MODEL_FILE = "onnx/model_quantized.onnx"
DIMS = 768


def model_directory() -> Path:
    cache = Path(os.environ.get("FASTEMBED_CACHE_PATH", "/tmp/fastembed_cache"))
    return cache / REVISION


def download() -> None:
    from huggingface_hub import snapshot_download

    source = Path(
        snapshot_download(
            repo_id=REPOSITORY,
            revision=REVISION,
            allow_patterns=[
                MODEL_FILE,
                "config.json",
                "tokenizer.json",
                "tokenizer_config.json",
                "special_tokens_map.json",
            ],
        )
    )
    # Reuse Hugging Face's download cache across builds and worktrees. Ship
    # regular files, not cache links or stale FP32 models, in the image.
    for name in (
        MODEL_FILE,
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
    ):
        target = model_directory() / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, target)
    # Prepare ONNX's cache links at build time, while the directory is writable.
    Embedding()


class Embedding(EmbeddingBase):
    def __init__(self, *, url="", model="", api_key=""):
        super().__init__(BaseEmbedderConfig())
        self.client = None
        self.dense_model = None
        if url:
            parsed = urlsplit(url)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError("Invalid embedding API base URL")
            if not model.strip():
                raise ValueError("An external embedding model is required")
            self.client = OpenAI(
                base_url=url.rstrip("/") + "/",
                api_key=api_key or "unused",
                timeout=30,
                max_retries=1,
            )
            self.config.model = model
            # Use native dimensions; compatible APIs need not accept OpenAI's
            # optional dimensions parameter. Check every subsequent response.
            self.config.embedding_dims = len(self._api(["memory embedding"])[0])
            identity = ["api", url.rstrip("/"), model, self.config.embedding_dims]
        else:
            from fastembed import TextEmbedding
            from fastembed.common.model_description import ModelSource, PoolingType

            if not any(
                m["model"] == MODEL for m in TextEmbedding.list_supported_models()
            ):
                TextEmbedding.add_custom_model(
                    model=MODEL,
                    pooling=PoolingType.MEAN,
                    normalization=True,
                    sources=ModelSource(hf=REPOSITORY),
                    dim=DIMS,
                    model_file=MODEL_FILE,
                )
            self.dense_model = TextEmbedding(
                model_name=MODEL,
                specific_model_path=str(model_directory()),
                local_files_only=True,
            )
            self.config.model = MODEL
            self.config.embedding_dims = DIMS
            identity = ["local", REPOSITORY, REVISION, MODEL_FILE, DIMS, "mean", 512]
        self.fingerprint = hashlib.sha256(json.dumps(identity).encode()).hexdigest()

    @classmethod
    def from_environment(cls):
        return cls(
            url=os.environ.get("MEMORY_EMBEDDING_URL", ""),
            model=os.environ.get("MEMORY_EMBEDDING_MODEL", ""),
            api_key=os.environ.get("MEMORY_EMBEDDING_API_KEY", ""),
        )

    def _api(self, texts):
        try:
            response = self.client.embeddings.create(
                input=texts, model=self.config.model, encoding_format="float"
            )
        except APIError as error:
            # Provider error bodies can echo credentials or user text.
            status = getattr(error, "status_code", None)
            raise RuntimeError(
                f"Embedding API request failed (status {status})"
            ) from None
        items = sorted(response.data, key=lambda item: item.index)
        if [item.index for item in items] != list(range(len(texts))):
            raise ValueError("Embedding API returned invalid result indexes")
        vectors = [item.embedding for item in items]
        expected = self.config.embedding_dims
        for vector in vectors:
            if (
                not 1 <= len(vector) <= 16000
                or (expected is not None and len(vector) != expected)
                or any(not math.isfinite(value) for value in vector)
                or not any(vector)
            ):
                raise ValueError("Embedding API returned an invalid vector")
        return vectors

    def embed(self, text, memory_action=None):
        return self.embed_batch([text], memory_action)[0]

    def embed_batch(self, texts, memory_action=None):
        texts = [text.replace("\n", " ") for text in texts]
        if self.client is None:
            # Bound CPU activations, including during startup re-embedding.
            return [
                vector.tolist()
                for vector in self.dense_model.embed(texts, batch_size=1)
            ]
        vectors = []
        for offset in range(0, len(texts), 32):
            vectors.extend(self._api(texts[offset : offset + 32]))
        return vectors


if __name__ == "__main__":
    download()
