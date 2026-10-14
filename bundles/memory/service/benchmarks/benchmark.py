"""Compare embedding memory, latency and retrieval without changing the live store.

Run with the memory service's Python environment. Models/dataset/vector caches
belong in --work-dir; --output is a reviewable JSON result. Each run must use a
fresh process, and variants must run sequentially for meaningful RSS/latency.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import statistics
import sys
import time
from pathlib import Path

SERVICE = Path(__file__).resolve().parents[1]
JINA_REVISION = "c1ff9086a89a1123d7b5eff58055a665db4fb4b9"
BGE_REVISION = "46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59"
DATASET_URL = "https://datasets-server.huggingface.co/rows"


def save(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def prepare(work: Path) -> None:
    import httpx
    from huggingface_hub import snapshot_download

    tokenizer_files = (
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
    )
    for repo, revision, name, graph in (
        (
            "jinaai/jina-embeddings-v2-base-zh",
            JINA_REVISION,
            "jina-fp32",
            "onnx/model.onnx",
        ),
        (
            "jinaai/jina-embeddings-v2-base-zh",
            JINA_REVISION,
            "jina-int8",
            "onnx/model_quantized.onnx",
        ),
        (
            "Qdrant/bge-small-zh-v1.5",
            BGE_REVISION,
            "bge-small-zh",
            "model_optimized.onnx",
        ),
    ):
        directory = work / "models" / name
        if not all((directory / file).exists() for file in (*tokenizer_files, graph)):
            snapshot_download(
                repo_id=repo,
                revision=revision,
                allow_patterns=[*tokenizer_files, graph],
                local_dir=directory,
            )

    path = work / "t2-reranking-rows.json"
    if not path.exists():
        response = httpx.get(
            DATASET_URL,
            params={
                "dataset": "C-MTEB/T2Reranking",
                "config": "default",
                "split": "dev",
                "offset": 0,
                "length": 40,
            },
            timeout=90,
        )
        response.raise_for_status()
        save(path, response.json())
    rows = json.loads(path.read_text())["rows"]
    documents = {}
    cases = []
    for row in rows:
        data = row["row"]
        relevant = []
        for text in data["positive"] + data["negative"][:6]:
            doc_id = "t2-" + hashlib.sha256(text.encode()).hexdigest()[:20]
            documents[doc_id] = {"id": doc_id, "text": text}
            if text in data["positive"]:
                relevant.append(doc_id)
        cases.append(
            {
                "id": f"t2-q{row['row_idx']}",
                "text": data["query"],
                "category": "public_zh",
                "relevant": list(dict.fromkeys(relevant)),
            }
        )
    memory = json.loads((SERVICE / "benchmarks/memory-cases.json").read_text())
    dataset = {
        "sources": {
            "memory": memory["description"],
            "public": (
                "C-MTEB/T2Reranking, dev rows 0-39, all positive passages "
                "and the first six negative passages per query, "
                "pooled into one corpus"
            ),
            "public_rows_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        },
        "suites": {
            "memory": {
                "documents": memory["documents"],
                "queries": memory["queries"],
            },
            "public_zh": {"documents": list(documents.values()), "queries": cases},
        },
    }
    save(work / "dataset.json", dataset)
    print(
        json.dumps(
            {
                key: {
                    "documents": len(suite["documents"]),
                    "queries": len(suite["queries"]),
                }
                for key, suite in dataset["suites"].items()
            }
        ),
        flush=True,
    )


def profile(stage: str) -> dict:
    status = dict(
        line.split(":", 1)
        for line in Path("/proc/self/status").read_text().splitlines()
        if ":" in line
    )
    result = {
        "stage": stage,
        "rss_mib": round(int(status["VmRSS"].split()[0]) / 1024, 2),
        # /proc resets on exec; getrusage can include the launcher's old peak.
        "peak_rss_mib": round(int(status["VmHWM"].split()[0]) / 1024, 2),
        "threads": int(status["Threads"]),
    }
    print(json.dumps(result), flush=True)
    return result


def load_embedder(variant: str, work: Path, api_url: str, threads=None):
    if variant == "api":
        from mem0.configs.embeddings.base import BaseEmbedderConfig
        from mem0.embeddings.openai import OpenAIEmbedding

        provider = OpenAIEmbedding(
            BaseEmbedderConfig(
                model="mock-jina-v2-zh",
                api_key="local-benchmark",
                embedding_dims=768,
                openai_base_url=api_url,
            )
        )
        return provider.embed, {"dims": 768, "model_file_bytes": 0, "endpoint": api_url}

    from fastembed import TextEmbedding
    from fastembed.common.model_description import ModelSource, PoolingType

    if variant == "jina":
        name = "jinaai/jina-embeddings-v2-base-zh"
        directory = (
            SERVICE
            / "out/models/models--jinaai--jina-embeddings-v2-base-zh/snapshots"
            / JINA_REVISION
        )
        if not (directory / "onnx/model.onnx").exists():
            directory = work / "models/jina-fp32"
        model_file = "onnx/model.onnx"
        dims = 768
        revision = JINA_REVISION
    elif variant == "jina-int8":
        name = "benchmark/jina-v2-zh-int8"
        directory = work / "models/jina-int8"
        model_file = "onnx/model_quantized.onnx"
        dims = 768
        revision = JINA_REVISION
        TextEmbedding.add_custom_model(
            model=name,
            pooling=PoolingType.MEAN,
            normalization=True,
            sources=ModelSource(hf="jinaai/jina-embeddings-v2-base-zh"),
            dim=dims,
            model_file=model_file,
        )
    else:
        name = "BAAI/bge-small-zh-v1.5"
        directory = work / "models/bge-small-zh"
        model_file = "model_optimized.onnx"
        dims = 512
        revision = BGE_REVISION
    model = TextEmbedding(
        model_name=name,
        specific_model_path=str(directory),
        local_files_only=True,
        threads=threads,
    )
    details = {
        "dims": dims,
        "revision": revision,
        "model_file_bytes": (directory / model_file).stat().st_size,
        "tokenizer_truncation": model.model.tokenizer.truncation,
        "query_prefix": "",
    }

    def embed(text):
        return next(iter(model.embed(text))).tolist()

    return embed, details


def metrics(rankings) -> dict:
    return {
        "queries": len(rankings),
        "hit_at_1": statistics.mean(rank <= 1 for rank in rankings),
        "hit_at_5": statistics.mean(rank <= 5 for rank in rankings),
        "mrr_at_10": statistics.mean(
            1 / rank if rank <= 10 else 0 for rank in rankings
        ),
    }


def evaluate(suite, document_vectors, query_vectors) -> dict:
    import numpy as np

    def normalize(vectors):
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        assert np.all(norms > 0), "zero embedding"
        return vectors / norms

    scores = normalize(query_vectors) @ normalize(document_vectors).T
    all_ranks = []
    categories = {}
    cases = []
    for query, values in zip(suite["queries"], scores, strict=True):
        order = np.argsort(-values, kind="stable")
        relevant = set(query["relevant"])
        rank = next(
            index + 1
            for index, doc_index in enumerate(order)
            if suite["documents"][doc_index]["id"] in relevant
        )
        all_ranks.append(rank)
        categories.setdefault(query["category"], []).append(rank)
        cases.append(
            {
                "id": query["id"],
                "category": query["category"],
                "first_relevant_rank": rank,
                "top_5": [
                    {
                        "id": suite["documents"][index]["id"],
                        "cosine": round(float(values[index]), 6),
                    }
                    for index in order[:5]
                ],
            }
        )
    return {
        "documents": len(suite["documents"]),
        **metrics(all_ranks),
        "by_category": {key: metrics(ranks) for key, ranks in categories.items()},
        "cases": cases,
    }


def run(args) -> None:
    work = args.work_dir
    dataset = json.loads((work / "dataset.json").read_text())
    # Imports sometimes create runtime files; keep them out of the checkout.
    os.chdir(work)
    os.environ["MEM0_TELEMETRY"] = "false"
    os.environ["MEM0_DIR"] = str(work / "mem0")
    os.environ["HF_HUB_OFFLINE"] = "1"
    sys.path.insert(0, str(SERVICE))
    stages = [profile("python")]
    started = time.perf_counter()
    import axp_memory.__main__  # noqa: F401

    stages.append(profile("service_imports"))
    embed, details = load_embedder(args.variant, work, args.api_url)
    setup_seconds = time.perf_counter() - started
    stages.append(profile("embedder_ready"))
    # Identical preprocessing to mem0's fastembed/OpenAI adapters.
    suites = dataset["suites"]
    texts = list(
        dict.fromkeys(
            item["text"].replace("\n", " ")
            for suite in suites.values()
            for key in ("documents", "queries")
            for item in suite[key]
        )
    )
    embed(suites["memory"]["queries"][0]["text"])
    stages.append(profile("first_query"))
    vectors = {}
    indexing_started = time.perf_counter()
    for index, text in enumerate(texts):
        vectors[text] = embed(text)
        if (index + 1) % 100 == 0:
            print(json.dumps({"indexed": index + 1, "total": len(texts)}), flush=True)
    indexing_seconds = time.perf_counter() - indexing_started
    stages.append(profile("after_indexing"))

    import numpy as np

    matrix = np.asarray([vectors[text] for text in texts], dtype=np.float32)
    assert matrix.shape == (len(texts), details["dims"])
    assert np.all(np.isfinite(matrix))
    np.savez_compressed(
        work / f"vectors-{args.variant}.npz",
        text_hashes=np.asarray(
            [hashlib.sha256(text.encode()).hexdigest() for text in texts]
        ),
        vectors=matrix,
    )
    results = {}
    latencies = {key: [] for key in suites}
    for round_index in range(3):
        for name, suite in suites.items():
            for query in suite["queries"]:
                started = time.perf_counter()
                embed(query["text"].replace("\n", " "))
                latencies[name].append((time.perf_counter() - started) * 1000)
        print(json.dumps({"latency_round": round_index + 1}), flush=True)
    stages.append(profile("after_queries"))
    for name, suite in suites.items():
        documents = np.asarray(
            [vectors[doc["text"].replace("\n", " ")] for doc in suite["documents"]],
            dtype=np.float32,
        )
        queries = np.asarray(
            [vectors[query["text"].replace("\n", " ")] for query in suite["queries"]],
            dtype=np.float32,
        )
        results[name] = evaluate(suite, documents, queries)
        results[name]["latency_ms"] = {
            "samples": len(latencies[name]),
            "p50": round(float(np.percentile(latencies[name], 50)), 2),
            "p95": round(float(np.percentile(latencies[name], 95)), 2),
        }
        if args.variant == "jina-int8":
            reference = load_vectors(work / "vectors-jina.npz")
            old_documents = np.asarray(
                [
                    reference[
                        hashlib.sha256(
                            doc["text"].replace("\n", " ").encode()
                        ).hexdigest()
                    ]
                    for doc in suite["documents"]
                ]
            )
            results[name]["int8_queries_against_fp32_index"] = evaluate(
                suite, old_documents, queries
            )
    result = {
        "variant": args.variant,
        "scope": (
            "Existing service imports + real embedding adapter. "
            "No database/server startup, LLM extraction, mem0 hybrid ranking, "
            "production memories or WAN latency. RSS includes one-text "
            "inference, retained corpus vectors and benchmark harness."
        ),
        "host": {
            "platform": platform.platform(),
            "processor": platform.processor(),
            "cpu_count": os.cpu_count(),
        },
        "versions": {
            name: importlib.metadata.version(name)
            for name in ("fastembed", "onnxruntime", "mem0ai", "openai", "numpy")
        },
        "model": details,
        "setup_seconds": round(setup_seconds, 2),
        "indexing_seconds": round(indexing_seconds, 2),
        "dataset": dataset["sources"],
        "memory": stages,
        "retrieval": results,
    }
    save(args.output, result)
    print(
        json.dumps(
            {
                "output": str(args.output),
                "summary": {
                    key: {
                        k: v
                        for k, v in value.items()
                        if k
                        not in (
                            "cases",
                            "by_category",
                            "int8_queries_against_fp32_index",
                        )
                    }
                    for key, value in results.items()
                },
            }
        ),
        flush=True,
    )


def load_vectors(path: Path) -> dict:
    import numpy as np

    with np.load(path) as cache:
        hashes = (
            cache["text_hashes"].tolist()
            if "text_hashes" in cache
            else [
                hashlib.sha256(text.encode()).hexdigest()
                for text in cache["texts"].tolist()
            ]
        )
        return dict(zip(hashes, cache["vectors"], strict=True))


def serve_mock(work: Path, port: int) -> None:
    import socket
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    vectors = load_vectors(work / "vectors-jina.npz")

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def setup(self):
            super().setup()
            # Avoid artificial delayed-ACK latency between headers and body.
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

        def log_message(self, *_args):
            pass

        def do_POST(self):
            if self.path != "/v1/embeddings":
                self.send_error(404)
                return
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            inputs = body["input"]
            if isinstance(inputs, str):
                inputs = [inputs]
            hashes = [hashlib.sha256(text.encode()).hexdigest() for text in inputs]
            missing = [key for key in hashes if key not in vectors]
            if missing or body.get("dimensions", 768) != 768:
                self.send_error(400, "unknown input or dimensions")
                return
            payload = json.dumps(
                {
                    "object": "list",
                    "model": body["model"],
                    "data": [
                        {
                            "object": "embedding",
                            "index": index,
                            "embedding": vectors[key].tolist(),
                        }
                        for index, key in enumerate(hashes)
                    ],
                    "usage": {"prompt_tokens": 0, "total_tokens": 0},
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            self.wfile.flush()

    with ThreadingHTTPServer(("127.0.0.1", port), Handler) as server:
        print(
            json.dumps(
                {
                    "mock_api": f"http://127.0.0.1:{server.server_port}/v1",
                    "texts": len(vectors),
                }
            ),
            flush=True,
        )
        server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("prepare", "run", "serve-mock"):
        child = sub.add_parser(command)
        child.add_argument("--work-dir", type=Path, required=True)
        if command == "run":
            child.add_argument(
                "--variant",
                choices=("jina", "jina-int8", "bge-small", "api"),
                required=True,
            )
            child.add_argument("--output", type=Path, required=True)
            child.add_argument("--api-url", default="http://127.0.0.1:18321/v1")
        elif command == "serve-mock":
            child.add_argument("--port", type=int, default=18321)
    args = parser.parse_args()
    args.work_dir = args.work_dir.resolve()
    args.work_dir.mkdir(parents=True, exist_ok=True)
    if args.command == "prepare":
        prepare(args.work_dir)
    elif args.command == "run":
        args.output = args.output.resolve()
        run(args)
    else:
        serve_mock(args.work_dir, args.port)


if __name__ == "__main__":
    main()
