import json

import httpx
import pytest
from openai import OpenAI

from axp_memory import embedding


def api(monkeypatch, respond):
    requests = []

    def handle(request):
        body = json.loads(request.content)
        requests.append(body)
        return respond(body)

    monkeypatch.setattr(
        embedding,
        "OpenAI",
        lambda **kwargs: OpenAI(
            **kwargs, http_client=httpx.Client(transport=httpx.MockTransport(handle))
        ),
    )
    return requests


def vectors(body, dimensions=3):
    return httpx.Response(
        200,
        json={
            "data": [
                {"index": i, "embedding": [1.0] + [0.0] * (dimensions - 1)}
                for i in reversed(range(len(body["input"])))
            ]
        },
    )


def test_external_api_detects_native_dimensions_without_loading_local_model(
    monkeypatch,
):
    requests = api(monkeypatch, vectors)
    monkeypatch.setattr(
        embedding, "model_directory", lambda: pytest.fail("local model was loaded")
    )
    model = embedding.Embedding(
        url="http://example.com/v1", model="native", api_key="secret"
    )
    assert model.config.embedding_dims == 3
    assert model.embed_batch(["第一条\n记忆", "另一条"]) == [[1.0, 0.0, 0.0]] * 2
    assert requests[-1]["input"] == ["第一条 记忆", "另一条"]
    assert all("dimensions" not in request for request in requests)
    other = embedding.Embedding(
        url="http://example.com/v1/", model="native", api_key="rotated"
    )
    assert other.fingerprint == model.fingerprint


def test_rejects_changed_dimensions_and_invalid_indexes(monkeypatch):
    requests = api(
        monkeypatch, lambda body: vectors(body, 3 if len(requests) == 1 else 2)
    )
    model = embedding.Embedding(url="http://example.com/v1", model="native")
    with pytest.raises(ValueError, match="invalid vector"):
        model.embed("query")

    api(monkeypatch, lambda body: httpx.Response(200, json={"data": []}))
    with pytest.raises(ValueError, match="indexes"):
        embedding.Embedding(url="http://example.com/v1", model="native")


def test_api_errors_do_not_echo_credentials_or_provider_body(monkeypatch):
    api(
        monkeypatch,
        lambda body: httpx.Response(401, json={"error": {"message": "secret-value"}}),
    )
    with pytest.raises(RuntimeError, match="status 401") as error:
        embedding.Embedding(
            url="http://example.com/v1", model="native", api_key="secret-value"
        )
    assert "secret-value" not in str(error.value)


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.com",
        "http://user:secret@example.com",
        "http://example.com?key=secret",
    ],
)
def test_invalid_api_urls_are_rejected(url):
    with pytest.raises(ValueError, match="base URL"):
        embedding.Embedding(url=url, model="model")
