# Memory embedding comparison

See [EmbeddingGemma 2 comparison](gemma-report.md) for the Gemma 4 based
text-only model, including matched 512-token runs and an 8K memory stress case.

This experiment changes the embedding model inside an isolated benchmark. It
does not modify the service's default model or write to the live memory store.

Measured on 2026-10-14:

| Variant                         | Startup RSS (MiB) |   Warm query p50 (ms) | Memory Hit@1 / Hit@5 | Public Chinese Hit@1 / Hit@5 |
| ------------------------------- | ----------------: | --------------------: | -------------------- | ---------------------------- |
| Jina v2 zh FP32                 |           1013.59 |                 26.98 | 75% / 95%            | 80% / 100%                   |
| Jina v2 zh INT8                 |            407.34 |                  9.01 | 70% / 90%            | 70% / 97.5%                  |
| BGE small zh v1.5               |            306.10 |                  3.08 | 65% / 87.5%          | 60% / 100%                   |
| Mock API returning Jina vectors |            171.52 | 2.22 (loopback cache) | 75% / 95%            | 80% / 100%                   |

All four conditions include the same existing service imports. The API
condition reduces startup RSS by about 83%; this moves model inference and
its memory to the external service. Its cached loopback timings exclude
external network transit and remote model computation.

INT8 lowers startup RSS by about 60% and short-query p50 by about 67%, with
two additional Top-5 misses out of 40 memory queries and one additional
miss out of 40 public Chinese queries. BGE is smaller and faster, but its
English-to-Chinese memory Hit@5 is 4/8, versus 8/8 for both Jina variants.
These small samples support a tradeoff discussion, not a statistical claim
about the models' overall quality.

The exported INT8 and FP32 vectors have mean paired cosine similarity
0.7518 over the 659 evaluated texts; row hashes were checked for alignment.
Quantized queries against the existing FP32 index achieve memory Hit@5
92.5% and public Chinese Hit@5 100% in this diagnostic. This is not enough
to establish general compatibility. Keep the old index during migration
validation and re-embed when changing the embedding model.

Transport verification checked exact equality of all 659 mock API vectors
with the FP32 baseline. Pooling verification checked that the custom mean
pooling wrapper used for INT8 reproduces the built-in FP32 outputs for
three probe texts, and that all tokenizer files are identical. The numerical
differences therefore remain visible rather than being attributed to a
different tokenizer or pooling implementation.

See [summary.json](results/summary.json) for the compact measured results.
Running the scripts generates per-variant JSON files with per-query rankings,
RSS stages, dependency versions and model revisions.

`benchmark.py` imports the existing service dependencies, then loads one real
embedding adapter in a fresh process. It measures Linux process RSS before
and after initialization and after single-text inference. Query latency is the
median and 95th percentile of three warm passes, with 120 requests per suite.
Models run sequentially, with the installed fastembed/ONNX defaults, on CPU.

The two independently searched corpora are:

- 48 synthetic memory statements and 40 hand-labelled queries. Categories
  cover Chinese paraphrases, English queries against Chinese facts, and
  distinctions between related facts. These are diagnostic cases, not actual
  user memories or a representative production sample.
- The first 40 dev queries from
  [C-MTEB/T2Reranking](https://huggingface.co/datasets/C-MTEB/T2Reranking),
  with all their positive passages and up to six negative passages per query
  pooled into 531 distinct documents. This is a bounded retrieval diagnostic,
  not the full C-MTEB reranking benchmark or leaderboard evaluation. The
  downloaded row cache is fingerprinted in each result.

Documents and queries are re-embedded for every model. Retrieval uses exact
cosine similarity, rather than the service's mem0 BM25/entity hybrid scoring.
Hit@k means at least one labelled relevant document appears in the first k
results; it is not the fraction of all relevant documents retrieved. MRR@10
uses the rank of the first relevant result, with zero beyond rank 10.

The baseline model is Jina v2 base zh (768 dimensions). Its official quantized
ONNX graph uses the same mean pooling and normalization. BGE small zh v1.5
(512 dimensions) uses fastembed's built-in model and CLS pooling. No query
instruction is added, matching the current mem0 fastembed adapter. The exact
model revisions, dependencies and actual tokenizer limits are in the results.
The INT8 result also evaluates quantized query vectors against the original
FP32 document vectors, as a limited compatibility diagnostic.

The mock API runs in a separate loopback process and returns precomputed Jina
vectors through an OpenAI-compatible `/v1/embeddings` endpoint. The client uses
mem0's actual `OpenAIEmbedding` adapter. The mock server's RSS is not included
in the client's RSS. The API condition measures client overhead and transport
correctness; its quality is fixed by the returned Jina vectors, and its local
latency does not predict WAN latency or a hosted model's compute time.

RSS includes the benchmark harness, dataset, service imports and retained
vectors. The `embedder_ready` measurement isolates startup from indexing.
This does not start the actual database connections, HTTP/MCP server, LLM
extraction or the production application. Model files are disk sizes, not RAM
estimates. The dataset and model caches stay in `/tmp`, outside the checkout.

From the repository root, using the memory service's existing Python environment:

```sh
bundles/memory/service/.venv/bin/python bundles/memory/service/benchmarks/benchmark.py prepare --work-dir /tmp/axp-embedding-bench
bundles/memory/service/.venv/bin/python bundles/memory/service/benchmarks/benchmark.py run --work-dir /tmp/axp-embedding-bench --variant jina --output bundles/memory/service/benchmarks/results/jina.json
bundles/memory/service/.venv/bin/python bundles/memory/service/benchmarks/benchmark.py run --work-dir /tmp/axp-embedding-bench --variant jina-int8 --output bundles/memory/service/benchmarks/results/jina-int8.json
bundles/memory/service/.venv/bin/python bundles/memory/service/benchmarks/benchmark.py run --work-dir /tmp/axp-embedding-bench --variant bge-small --output bundles/memory/service/benchmarks/results/bge-small.json
```

`prepare` downloads the pinned FP32 Jina, INT8 Jina and BGE models and the
public diagnostic rows when missing. A pre-existing FP32 Jina build cache is
also accepted. Network access is only needed for preparation; local model
runs enforce offline mode.

To test the API condition, start this in a separate terminal after the Jina run:

```sh
bundles/memory/service/.venv/bin/python bundles/memory/service/benchmarks/benchmark.py serve-mock --work-dir /tmp/axp-embedding-bench --port 18321
```

Then run the API client and stop the mock server afterwards:

```sh
bundles/memory/service/.venv/bin/python bundles/memory/service/benchmarks/benchmark.py run --work-dir /tmp/axp-embedding-bench --variant api --api-url http://127.0.0.1:18321/v1 --output bundles/memory/service/benchmarks/results/api.json
```
