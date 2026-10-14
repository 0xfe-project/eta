# EmbeddingGemma 2：memory 服务的内存与召回实验

2026-10-14，CPU：Intel Core i7-11800H。用户提到的 Gemma 4 embedding 对应
[EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2)。本次只加载
270M 参数的文本部分，输出 768 维；视觉和音频 encoder 不下载、不加载。
生产默认模型仍是本 PR 的 Jina INT8，Gemma 是实验候选。

## 结果

主比较统一限制 512 tokens，与 Jina 实际 tokenizer 限制相同。Gemma 使用官方
SearchQuery / Document 前缀，分别重建每个模型的文档和查询向量。

| 模型       | 首条查询后 RSS / MiB | 完整测试后 RSS / MiB | 记忆 Hit@1 | 记忆 Hit@5 | 中文 Hit@1 / Hit@5 | 记忆查询 p50 / ms |
| ---------- | -------------------: | -------------------: | ---------: | ---------: | ------------------ | ----------------: |
| Jina FP32  |                 1016 |                 1091 |      30/40 |      38/40 | 32/40 / 40/40      |             26.98 |
| Jina INT8  |                  410 |                  489 |      28/40 |      36/40 | 28/40 / 39/40      |              9.01 |
| Gemma FP32 |                  805 |                 1248 |      37/40 |      39/40 | 28/40 / 40/40      |             33.49 |
| Gemma INT8 |                  577 |                  783 |      37/40 |      39/40 | 28/40 / 40/40      |             77.25 |
| Gemma INT4 |                  446 |                  592 |      36/40 |      38/40 | 28/40 / 40/40      |             20.76 |

在这组小样本上，Gemma INT4 比当前 Jina INT8 的记忆检索更好，尤其是 Top-1；
内存约高 36 MiB（首条查询后）或 103 MiB（完整测试后），查询耗时约 2.3 倍。
如果优先降低 memory 服务的内存和延迟，Jina INT8 更合适；如果优先改善记忆召回，
Gemma INT4 值得继续用真实记忆验证。Gemma 对公开中文样本的 Top-1 没有超过 Jina FP32。

Gemma INT8 在这台 CPU 和这个 ONNX 导出上比 FP32、INT4 慢；不能把量化位数直接
当作速度排序。INT8 与 FP32 的 80 个查询排名全部一致，659 个文档/查询向量的
平均配对余弦为 0.999939；INT4 为 0.983509，记忆 Top-5 只少一个命中。

例如「我喜欢怎样的回答组织方式？」在 Jina INT8 中相关记忆排第 7，在 Gemma INT4
中排第 1；「界面里自己写的记忆还要交给大模型总结吗？」从第 6 到第 1。
但「两个智能体会读到彼此的长期记忆吗？」仍排第 7，说明这个结果也有明确漏召回。

## 内存的实际含义

Gemma tokenizer 从约 169 MiB 的服务依赖基线加载到约 413 MiB，加载峰值约
522 MiB。权重文件小，不能直接推算整个 Python 服务的内存。FP32 / INT8 / INT4
ONNX 权重加 graph 的磁盘大小分别约 1034 / 300 / 166 MiB；表中使用实际进程 RSS。
输出维度缩到 128 或 256 可以减少向量存储，不能减少模型权重的加载量。

Gemma 默认支持 8K tokens。一次 INT4、8192-token 上限的完整公共语料索引实验，
在约 200 个文本后 RSS 达到 **6780 MiB（约 6.6 GiB）**，超过服务现有 2 GiB 限制，
因此停止，没有报告这次未完成实验的召回成绩。它与上表完整的 512-token 实验分开记录。
长上下文的注意力和 runtime 缓冲区可能比权重更占内存；服务采用它时需要显式限制输入。

表中「首条查询后」接近短请求启动状态；「完整测试后」包含保留的测试向量和经过
长文档推理后的 runtime 内存。Gemma INT4 完成短记忆语料后约 479 MiB，经过
公共语料后约 592 MiB。它不是整个产品、数据库或容器的总内存。

## 补充检查

- 直接省略 Gemma 的查询/文档前缀：记忆 Hit@1 为 35/40，Hit@5 为 38/40，
  相比正确前缀的 36/40、38/40 略低。这是普通 API 接法的诊断，不代表所有 API
  服务端都使用相同预处理。最佳效果需要根据 add/search 区分文档与查询。
- 限制两个 ONNX CPU 线程：Gemma INT4 的记忆排名不变，p50 反而升到 43.36 ms；
  Jina INT8 为 9.91 ms。这个环境下不建议为了短查询把 Gemma 线程数限制为 2。
- Jina INT8 独立短语料复测：Hit@1 / Hit@5 仍为 28/40、36/40，p50 9.04 ms，
  与此前完整实验的 9.01 ms 接近。短语料 RSS 有运行间变化，复测约 388 MiB。
- 检查了模型 graph 与外部权重的 SHA-256，均匹配 Hugging Face LFS 元数据；
  Google 原始 tokenizer 与 ONNX 导出 tokenizer 的 SHA-256 相同。
- 每次推理检查 BOS/EOS、输出 768 维、有限数值和单位范数。graph 自带投影、
  masked mean pooling 与 L2 normalization，使用 FP32 激活，不使用 FP16。

## 样本与复现

48 条合成记忆、40 个标注查询（24 中文、8 英文查询中文事实、8 细节区分）；
公开语料使用 C-MTEB/T2Reranking dev 的前 40 条，正例和每条最多 6 个负例
合并成 531 条文档。每个语料单独做精确余弦检索，Hit@k 表示前 k 条中至少一个
正确文档。每个模型均重新编码文档和查询，默认 CPU 线程、batch=1、顺序运行，
每套查询预热后测三轮，共 120 次延迟采样。

这里没有真实用户记忆、数据库启动、LLM 提炼或 Mem0 的混合排序；40 个问题上
一个命中就是 2.5 个百分点。数据不足以宣称 Gemma 在所有生产记忆或中文检索中更好。
完整指标、逐查询相关文档排名、RSS 阶段、模型版本、校验和、降维诊断和未完成的
8K 压力测试记录见 [gemma-comparison.json](results/gemma-comparison.json)。

模型导出固定为
[onnx-community/embeddinggemma-2-ONNX@daa72c5](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/tree/daa72c51243991dfcaf9f9137d2c573d8f7790c0)。
模型输入处理参照 [Transformers.js 实现](https://github.com/huggingface/transformers.js/blob/main/packages/transformers/src/models/embedding_gemma2/modeling_embedding_gemma2.js)：
纯文本输入的三个多模态 features 均为空矩阵，直接读取 `sentence_embedding` 输出。

在仓库根目录用 memory 的 Python 环境运行，下载的数据和模型放在临时目录：

```sh
bundles/memory/service/.venv/bin/python bundles/memory/service/benchmarks/gemma_benchmark.py --prepare --work-dir /tmp/axp-embedding-bench
bundles/memory/service/.venv/bin/python bundles/memory/service/benchmarks/gemma_benchmark.py --variant gemma-int4 --max-tokens 512 --work-dir /tmp/axp-embedding-bench --output bundles/memory/service/benchmarks/results/gemma-int4-512.json
```

用 `gemma-int8`、`gemma-fp32`、`jina-int8`、`jina` 分别替换 variant 顺序运行；
`--memory-only` 可以只跑短记忆，`--no-prefix` 测试普通 API 预处理，
`--threads 2` 测试两个线程。准备阶段共下载约 2.3 GiB 模型，下载耗时和进程
不参与推理 RSS / 延迟结果。模型、数据和向量缓存不进入镜像或 Git。

本次所有条件均通过 `--service-dir /home/akrc/Developer/axp/bundles/memory/service`
导入同一份原始服务依赖，避免实现改动影响比较。模型来源、runtime 版本和公共
数据缓存指纹在结果 JSON 中。所有实验在独立 worktree 执行，没有写入现有记忆库。
