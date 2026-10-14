"""EmbeddingGemma 2 text-only CPU comparison on the existing fixed corpus.

Runs in a fresh process per variant, with the same service imports and ONNX
runtime as the Jina benchmark. Query/document prompts follow the model card.
The graph already includes projection, mean pooling and L2 normalization.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import sys
import time
from pathlib import Path

import benchmark

REPO = "onnx-community/embeddinggemma-2-ONNX"
REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0"
GRAPHS = {
    "gemma-fp32": "model.onnx",
    "gemma-int8": "model_quantized.onnx",
    "gemma-int4": "model_q4.onnx",
}
PREFIXES = {
    "query": "task: search result | query: ",
    "document": "title: none | text: ",
}


def prepare(args):
    from huggingface_hub import snapshot_download

    benchmark.SERVICE = args.service_dir
    benchmark.prepare(args.work_dir)
    graphs = list(GRAPHS.values())
    snapshot_download(
        REPO,
        revision=REVISION,
        local_dir=args.work_dir / "models/gemma-2-onnx",
        allow_patterns=[
            "*.json",
            *["onnx/" + graph for graph in graphs],
            *["onnx/" + graph + "_data" for graph in graphs],
        ],
        max_workers=4,
    )


def load_gemma(args):
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer

    directory = args.work_dir / "models/gemma-2-onnx"
    tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
    tokenizer.enable_truncation(max_length=args.max_tokens)
    token_lengths = {"query": [], "document": []}
    graph = directory / "onnx" / GRAPHS[args.variant]
    files = [graph, graph.with_name(graph.name + "_data")]
    checksums = {}
    for path in files:
        with path.open("rb") as stream:
            checksums[path.name] = hashlib.file_digest(stream, "sha256").hexdigest()
    tokenizer_memory = benchmark.profile("tokenizer_ready")
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    if args.threads:
        options.intra_op_num_threads = args.threads
        options.inter_op_num_threads = args.threads
    session = ort.InferenceSession(
        str(graph), sess_options=options, providers=["CPUExecutionProvider"]
    )
    empty_features = np.empty((0, 512), dtype=np.float32)
    expected = {
        "input_ids",
        "attention_mask",
        "image_features",
        "video_features",
        "audio_features",
    }
    assert {value.name for value in session.get_inputs()} == expected
    assert "sentence_embedding" in {value.name for value in session.get_outputs()}

    def embed(text, kind):
        prefix = "" if args.no_prefix else PREFIXES[kind]
        encoding = tokenizer.encode(prefix + text.replace("\n", " "))
        assert encoding.ids[0] == 2, "BOS missing"
        assert encoding.ids[-1] == 1, "EOS missing"
        token_lengths[kind].append(len(encoding.ids))
        values = {
            "input_ids": np.asarray([encoding.ids], dtype=np.int64),
            "attention_mask": np.asarray([encoding.attention_mask], dtype=np.int64),
            "image_features": empty_features,
            "video_features": empty_features,
            "audio_features": empty_features,
        }
        vector = session.run(["sentence_embedding"], values)[0][0]
        assert vector.shape == (768,)
        assert np.all(np.isfinite(vector))
        assert abs(float(np.linalg.norm(vector)) - 1) < 1e-3
        return vector.tolist()

    return (
        embed,
        {
            "source": "google/embeddinggemma-2",
            "export": REPO,
            "revision": REVISION,
            "dims": 768,
            "text_only": True,
            "model_file_bytes": sum(path.stat().st_size for path in files),
            "sha256": checksums,
            "max_tokens": args.max_tokens,
            "prefixes": {} if args.no_prefix else PREFIXES,
            "pooling": (
                "ONNX sentence_embedding: projection, masked mean pooling, "
                "L2 normalization"
            ),
            "threads_option": args.threads,
            "tokenizer_memory": tokenizer_memory,
        },
        token_lengths,
    )


def run(args):
    work = args.work_dir
    dataset = json.loads((work / "dataset.json").read_text())
    if args.memory_only:
        dataset["suites"] = {"memory": dataset["suites"]["memory"]}
    os.chdir(work)
    os.environ.update(
        MEM0_TELEMETRY="false", MEM0_DIR=str(work / "mem0"), HF_HUB_OFFLINE="1"
    )
    sys.path.insert(0, str(args.service_dir))
    benchmark.SERVICE = args.service_dir
    stages = [benchmark.profile("python")]
    started = time.perf_counter()
    import axp_memory.__main__  # noqa: F401

    stages.append(benchmark.profile("service_imports"))
    if args.variant in GRAPHS:
        embed, details, token_lengths = load_gemma(args)
    else:
        raw_embed, details = benchmark.load_embedder(
            args.variant, work, "", threads=args.threads or None
        )
        details["threads_option"] = args.threads

        def embed(text, kind):
            return raw_embed(text.replace("\n", " "))

        token_lengths = {}
    setup_seconds = time.perf_counter() - started
    stages.append(benchmark.profile("embedder_ready"))
    embed(dataset["suites"]["memory"]["queries"][0]["text"], "query")
    stages.append(benchmark.profile("first_query"))
    if args.startup_only:
        benchmark.save(
            args.output, {"variant": args.variant, "model": details, "memory": stages}
        )
        return

    import numpy as np

    vectors = {}
    results = {}
    indexing_started = time.perf_counter()
    for name, suite in dataset["suites"].items():
        for key, kind in (("documents", "document"), ("queries", "query")):
            for item in suite[key]:
                text = item["text"].replace("\n", " ")
                cache_key = (kind, text)
                if cache_key not in vectors:
                    vectors[cache_key] = embed(text, kind)
                    if len(vectors) % 100 == 0:
                        print(
                            json.dumps({"indexed": len(vectors), "suite": name}),
                            flush=True,
                        )
        stages.append(benchmark.profile("after_" + name + "_indexing"))
    indexing_seconds = time.perf_counter() - indexing_started
    stages.append(benchmark.profile("after_indexing"))
    latencies = {name: [] for name in dataset["suites"]}
    for round_index in range(3):
        for name, suite in dataset["suites"].items():
            for query in suite["queries"]:
                started = time.perf_counter()
                embed(query["text"], "query")
                latencies[name].append((time.perf_counter() - started) * 1000)
        print(json.dumps({"latency_round": round_index + 1}), flush=True)
    stages.append(benchmark.profile("after_queries"))
    for name, suite in dataset["suites"].items():
        documents = np.asarray(
            [
                vectors[("document", item["text"].replace("\n", " "))]
                for item in suite["documents"]
            ],
            dtype=np.float32,
        )
        queries = np.asarray(
            [
                vectors[("query", item["text"].replace("\n", " "))]
                for item in suite["queries"]
            ],
            dtype=np.float32,
        )
        results[name] = benchmark.evaluate(suite, documents, queries)
        results[name]["latency_ms"] = {
            "samples": len(latencies[name]),
            "p50": round(float(np.percentile(latencies[name], 50)), 2),
            "p95": round(float(np.percentile(latencies[name], 95)), 2),
        }
        benchmark.save(
            args.output.parent / (args.output.stem + f"-{name}-dims.json"),
            {
                str(dim): benchmark.evaluate(
                    suite, documents[:, :dim], queries[:, :dim]
                )
                for dim in [128, 256, 512, 768]
            },
        )
        np.savez_compressed(
            args.output.parent / (args.output.stem + f"-{name}-vectors.npz"),
            documents=documents,
            queries=queries,
        )
    benchmark.save(
        args.output,
        {
            "variant": args.variant,
            "scope": (
                "Same original service imports + ONNX CPU, batch=1. "
                "No DB, LLM extraction, hybrid ranking, production data, WAN "
                "or vision/audio. RSS includes retained vectors/harness "
                "after indexing."
            ),
            "host": {"platform": platform.platform(), "cpu_count": os.cpu_count()},
            "versions": {
                name: importlib.metadata.version(name)
                for name in [
                    "fastembed",
                    "onnxruntime",
                    "tokenizers",
                    "mem0ai",
                    "numpy",
                ]
            },
            "dataset": dataset["sources"],
            "model": details,
            "memory": stages,
            "setup_seconds": round(setup_seconds, 2),
            "indexing_seconds": round(indexing_seconds, 2),
            "token_lengths": {
                kind: {
                    "max": max(lengths),
                    "p50": float(np.percentile(lengths, 50)),
                    "p95": float(np.percentile(lengths, 95)),
                    "at_limit": sum(length == args.max_tokens for length in lengths),
                }
                for kind, lengths in token_lengths.items()
            },
            "retrieval": results,
        },
    )
    print(
        json.dumps(
            {
                name: {
                    key: value
                    for key, value in result.items()
                    if key not in ["cases", "by_category"]
                }
                for name, result in results.items()
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--variant", choices=[*GRAPHS, "jina", "jina-int8"])
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--service-dir", type=Path, default=benchmark.SERVICE)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--max-tokens", type=int, default=512)
    parser.add_argument("--threads", type=int, default=0)
    parser.add_argument("--no-prefix", action="store_true")
    parser.add_argument("--startup-only", action="store_true")
    parser.add_argument("--memory-only", action="store_true")
    args = parser.parse_args()
    args.work_dir = args.work_dir.resolve()
    args.work_dir.mkdir(parents=True, exist_ok=True)
    args.service_dir = args.service_dir.resolve()
    if args.output:
        args.output = args.output.resolve()
    if args.prepare:
        prepare(args)
    else:
        if not args.variant or not args.output:
            parser.error("--variant and --output are required for a model run")
        run(args)
