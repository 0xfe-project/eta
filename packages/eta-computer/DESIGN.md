# @eta/computer：低延迟 Computer Use

本文记录这套端侧感知与投机执行的**技术选型理由**与**实测结论**。性能测试分两台机器完成：早期选型在 Intel Core Ultra 9 285H / 16 核 / 无独显 上跑（ONNX Runtime 1.30.0 CPU EP），当前的 Provider 适配结论在 Intel Core i7-13700K / 24 线程 / NVIDIA RTX 3080 上重测（ONNX Runtime 1.22.0，CUDA 12.9 + cuDNN 9）。两台机器读数不同，下文表格都标注了机器。

---

## 1. 要解决的问题

常规 Computer Use 是串行同步闭环：

```
全屏截图 → 编码上传 → 云端 VLM 推理 → 单步动作 → 等渲染 → 再全屏截图
```

单步 2.5–8 秒。三个结构性浪费：全屏图 token 开销、每一步都重新理解屏幕、固定 `sleep` 等动画。

本包只做一件事：**把无需云端语义决策的那 80% 工作压到端侧 10–60ms 内完成**，只有在预测失败或触及风险时才唤醒云端慢模型。

## 2. 双层架构

```
┌─────────────────────────────────────────────────┐
│ Slow：云端 VLM —— 子目标规划 / 异常重规划          │  ~0.6–1.8s
└───────────────▲──────────────────┬──────────────┘
                │ 仅高 Surprise 时 │ 下发带预期断言的动作微图
┌───────────────┴──────────────────▼──────────────┐
│ Fast：Rust 原生线程（不经过 Bun 事件循环）        │  ~0.6–60ms
│  采集 → 差分 → ort 感知 → 融合 → Jev 决策 → 注入  │
└─────────────────────────────────────────────────┘
```

关键约束：**整个投机闭环运行在 Rust 独立线程池**。Bun 只是通过 `bun:ffi` 投递任务（<0.05ms），否则单线程事件循环会被 15ms 推理拖出可见卡顿。

## 3. 技术选型及理由

### 3.1 Rust + `bun:ffi`，而不是子进程 sidecar

沿用仓库既有的 `packages/llm-gateway`（Go cdylib + `bun:ffi`）与 `@ast-grep/napi` 先例。子进程方案要在每一步付 IPC 序列化 + Base64 或 stdio 拷贝；`bun:ffi` 能直接把 Rust 侧帧缓冲与结构化结果的指针交给 JS。

### 3.2 用 `ort` crate 绑定 ONNX Runtime，把「用哪个 Provider」变成运行时可判定的事

第一版是自己按槽位号手绑 C-API 虚表（`OrtGetApiBase()` → `GetApi(n)` → 取函数指针）。它确实快：零 crate 依赖、编译 3 秒。但它只能有一个 Provider 故事：**CPU**。槽位号一旦写错是段错误而不是报错，且要在 Windows 上挂 CUDA 时，还得自己 dlopen provider DLL、自己拼 EP options 结构体。机器换成有独显的之后这条路不再划算，于是换回 `ort` crate（`2.0.0-rc.15`，对齐 ONNX Runtime 1.22 / `api-22`）。

`ort` 带来的不是「更少代码」，而是三件原来做不了的事：

1. **Provider 是一等公民**，`ep::CUDA` / `ep::DirectML` / `ep::CoreML` / `ep::CPU` 各自有类型化的配置项，不用手拼 `provider_options` 字符串；
2. **注册失败是可捕获的错误**，而不是静默回退，于是可以「先探测、再决定」；
3. **输入仍是零拷贝**：`TensorRef::from_array_view` 借我们的 `Vec<f32>` 建 `OrtValue`，只有输出侧付一次 `memcpy` 回到预分配缓冲（GPU 上这条路径本来就要 D2H，省不掉）。

#### Provider 链：逐模型探测，按模型落位

`EdgeModelTriad::load()` 里对每个模型跑一条候选链（默认 Windows = `cuda → directml → cpu`，macOS = `coreml → cpu`，Linux = `cuda → cpu`）。每个候选都以 `error_on_failure()` 提交会话——提交会话才是真正加载 provider DLL 的时刻，所以缺 CUDA/cuDNN 就在这一步暴露，而不是在第一帧崩。失败原因会被原样带进 `providerChain`：

```json
"provider": "cpu",
"providerChain": ["cuda", "cpu",
  "cuda: ... CUDA failure 100: no CUDA-capable device is detected ..."]
```

这带来一个反直觉但很重要的结论：**三个模型不该跑在同一个 Provider 上**。检测器与 OCR 是卷积/矩阵密集型，GPU 上快 2–4.5 倍；而 151M 的 INT8 决策编码器只有 48 个 token，GPU 上反而慢 1.6 倍（kernel launch 与量化/反量化开销盖过了 GEMM 收益，见 §9⑤）。因此编码器默认被钉在 CPU，除非 `ETA_COMPUTER_ENCODER_PROVIDER` 明确要求 GPU：

| 变量                            | 作用                                                           |
| ------------------------------- | -------------------------------------------------------------- |
| `ETA_COMPUTER_PROVIDER`         | 感知链（检测器 + OCR）的候选，逗号分隔，如 `cuda,directml,cpu` |
| `ETA_COMPUTER_ENCODER_PROVIDER` | 决策编码器单独的候选；GPU 机器默认 `cpu`                       |
| `ETA_COMPUTER_DEVICE_ID`        | CUDA/DirectML 设备号，默认 0                                   |
| `ETA_COMPUTER_THREADS`          | ORT intra-op 线程数，默认逻辑核数的一半（上限 12）             |
| `ETA_COMPUTER_ORT_VARIANT`      | `gpu` / `cpu`，覆盖构建时的显卡探测                            |
| `ETA_ORT_RUNTIME_DIR`           | 用现成的 ONNX Runtime 目录（其下须有 `lib/`），跳过下载        |

#### 运行时从哪来

`scripts/build.ts` 按「有没有 `nvidia-smi`」决定下载 CPU 还是 CUDA 版 ONNX Runtime 1.22（Windows/Linux 有 CUDA 版，macOS 只有 CoreML 版），解到 `native/target/ort-runtime/`，用 `ORT_LIB_LOCATION` + `ORT_PREFER_DYNAMIC_LINK=1` 让 `ort-sys` **只链 import lib**，再把 `onnxruntime.dll` 与各 provider DLL 复制到 `lib/` 一起发布。

为什么不用 `ort-sys` 自带的 `download-binaries`：它给 Windows 提供的是**静态** ORT（`onnxruntime.lib` 383 MB），静态库里的 MSVC STL 符号要求 VS 17.14+，在 VS 17.10 上链接直接报一堆 `__std_search_1` 未解析；而且那份构建固定 CUDA 13，而本机是 CUDA 12.9。改成链运行时 DLL 后，工具链要求归零，Provider 组合也由「换哪个 ORT 构建」决定——这正是 Provider 适配应有的边界。

代价是首次构建要下 ~310 MB 的 GPU 运行时（只下一次，之后命中 `native/target/ort-runtime/` 缓存），且 CUDA 版运行时要求机器上有 CUDA 12.x + cuDNN 9；缺了不报错，只是探测把 `cuda` 记进 `providerChain` 并落到 CPU。

### 3.3 三个模型，而不是一个端到端 VLM

| 角色                    | 模型                                                                   | 体积      |
| ----------------------- | ---------------------------------------------------------------------- | --------- |
| 视觉锚点 + 64d 局部表征 | Microsoft OmniParser 的 YOLOv8 `icon_detect_640x640` + 嫁接的 64d 分支 | 11.73 MB  |
| 文本识别                | PaddleOCR 英文识别头（438 类）                                         | 7.47 MB   |
| 结构化决策              | OpenJev/Verdict 151.4M RLCD ModernBERT（INT8）                         | 145.65 MB |

合计 **166.91 MB**（含 BPE 词表 2.1 MB）。

这样拆分的理由是三者**更新频率与硬件需求完全不同**：检测器每帧跑、OCR 只在无 A11y 标签时跑、决策模型每步跑一次但可以缓存。合成一个模型会让每次界面微动都付出全量代价。

**为什么是这三个**：

- **OmniParser 的检测器**（`onnx-community/OmniParser-icon_detect_640x640`）是当前纯视觉 UI 检测的强基线，MIT 可商用。原版管线里还有个 Florence-2 做图标语义描述——那是自回归模型，单帧 400–800ms，必须砍掉；图标语义改由 A11y 标签 + OCR + 检测器自身的细分类承担。
- **PaddleOCR 的识别头**而非检测头：检测由 OmniParser 代劳，OCR 只需要认文字。英文头仅 7.47 MB、438 类。
- **OpenJev/Verdict**（`heman10x/rlcd-modernbert-151m`）是社区按 `Jev` 思路做的开源复现：151.4M 参数的 ModernBERT，用 **RLCD（Reinforcement Learning for Calibrated Decisions）** 训练，损失是 `CE + Brier`，因此输出概率是**校准过的**——这直接决定了能不能拿它当投机门控的阈值。它同时带一个显式的 `__insufficient_evidence__` 弃权槽位，正好对应「该叫慢模型了」。

### 3.4 为什么坚持 Jev 式的「0 Token 生成」决策

传统 LLM 即使只判一个是非题，也要逐 token 解码，几百毫秒起，且 logprobs 严重过度自信。Jev 的范式是 `(State, Questions[]) → 单次前向并行输出`，三种原语全部带校准概率：

- `Choice`：从动态候选里选 1（最多 255 个，我们用 4 个）
- `Noul`：二元概率
- `Score`：有序分值

实测 `heman10x/rlcd-modernbert-151m` 在 seq_len 32 时 INT8 仅 **12.4ms**（Python/4 线程），且三类判例判定与 FP16 完全一致。这是「能不能每步都跑一次语义决策」的关键。

## 4. 核心设计：UI-JEPA 前向预测 + 投机执行

灵感来自五篇工作，融合成一套端侧可实现的机制：

| 论文                                                | 借的是什么                                                |
| --------------------------------------------------- | --------------------------------------------------------- |
| **UI-JEPA** (arXiv:2409.04081)                      | 在**表征空间**预测下一状态，不在像素空间生成              |
| **WMA** (arXiv:2410.13232, ICLR'25)                 | 只预测动作引起的**状态差分**，不预测全量状态              |
| **Discriminative World Models** (2026)              | 用**判别式打分**（能量/匹配度）而非生成式重建来校验       |
| **Speculative Actions** (arXiv:2510.04371, ICLR'26) | 快模型先推进，验证一致就 commit，否则 rollback            |
| **Jev-Mobile** (arXiv:2609.30186)                   | 慢模型规划 + 快模型执行，实测执行时间 −32.7%、成本 −73.4% |

### 4.1 混合状态表征

```
S_t = (G_t, Z_t, f_t)
```

- `G_t`：A11y/UIA/CDP 节点与视觉检测框 IoU 融合后的锚点图
- `Z_t`：每个锚点 64 维 L2 归一化视觉特征（按钮禁用态、勾选、变红这类 A11y 漏报的变化）
- `f_t`：焦点锚点 + **系统光标形态**（`Arrow`/`IBeam`/`Wait` 是极低成本的硬件前向信号）

### 4.2 三元 Surprise 能量

动作注入并达到视觉稳态后计算：

```
E = 0.45·结构误差 + 0.35·脏矩形逃逸度 + 0.20·潜空间残差
```

其中「脏矩形逃逸度」= `1 - IoU(R_actual, R_pred)`。这一项专门抓**局部打字时突然弹全屏弹窗**——预期变化区只在输入框附近，实际脏矩形却是全屏，IoU 骤降。

### 4.3 三级门控

| 门控                     | 条件                                     | 动作                                    |
| ------------------------ | ---------------------------------------- | --------------------------------------- |
| `fast_commit`            | 后置条件成立、无阻断、选择置信度高       | 端侧直接下一步，零网络                  |
| `local_micro_correction` | 目标仍在但位置漂移                       | 用持久锚点 ID 取新坐标继续              |
| `slow_escalation`        | 出现意外 Modal / 后置条件失败 / 进展停滞 | 回滚可逆步 + 只上传异常 ROI 与结构 diff |

另有 `safety_intercept`（不可逆风险）与 `wait_settle`（检测到 Loading）两个旁路。

## 5. 大面积变化怎么办

滚屏、切 Tab、整页跳转时 50–100% 元素变化，朴素 Diff 会有三个后果：脏矩形退化成全屏、候选锚点暴增、正常换页被误判成异常。四类分流：

1. **刚体平移抵消**：滚屏时存量锚点只是统一平移。用子树哈希/块匹配算出 `(Δx, Δy)`，存量节点原地更新坐标**不重跑检测**，只对新滑入视口的边缘条带做推理。
2. **层次中央凹折叠**：整页换页时按宏观容器（Nav/Sidebar/Main/Modal）聚类，只展开与 `subgoal` 最相关的容器，其余折叠成一行摘要，保证活跃锚点 ≤64。
3. **两阶段语义稳态**：识别周期性小脏块（Spinner）或低文本密度（骨架屏）时延长等待，直到真实内容填充再触发决策。
4. **顶层 Z-Plane 隔离**：检测到 `zLayer > 0` 的 dialog/alert 时，把背景节点整体标记为不可点，只把弹窗内锚点交给决策。

**锚点 ID 跨帧持久化**是这里的关键：ID 绝不按每帧序号重排，而是按 `(Role + TextHash + 父容器 + IoU + 64d 余弦)` 匹配继承。展开面板把「保存」按钮从 `y=180` 挤到 `y=290` 后，它仍然叫 `#2`，投机队列里的 `click:#2` 依然指向正确的实时坐标。

## 6. 六个真实坑点

| # | 坑                                                                 | 化解                                                                    |
| - | ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 1 | A11y/UIA 全树遍历在复杂应用上 200–2000ms 甚至死锁                  | 后台影子树 + `ElementFromPoint` 局部反查，硬超时 8ms 后降级为纯视觉     |
| 2 | `ort` 动态 Shape 触发 GPU/NPU 算子重编译（300–1500ms 尖峰）        | 固定 3 档输入尺寸 + 多 ROI 拼进 640×640 Atlas，只做一次前向             |
| 3 | 混合 DPI 下截图坐标与注入坐标差几十像素                            | 单一归一化真值坐标系 + 显示器变换矩阵                                   |
| 4 | 输入法劫持（打 `eta` 变成拼音）与 Hover 依赖（瞬移点击被前端吞掉） | `KEYEVENTF_UNICODE` 直通 / 原子剪贴板事务；滑入 10ms + 悬停 16ms 再按下 |
| 5 | 网络滞后导致「幽灵双连击」与 Jev OOD 盲目自信                      | 同锚点 300ms 幂等锁 + `wait_settle`/`escalate` 哨兵选项                 |
| 6 | Bun 单线程事件循环被阻塞、零拷贝内存撕裂                           | 闭环下沉 Rust 线程池 + 无锁三缓冲                                       |

## 7. 落地后的三层缓存

热态之所以能到 0.6ms，靠的是三层命中：

1. **OCR 行级指纹**：相对控件内缩 15% 采样 6×3 个亮度格，`:focus` 边框变色不会击穿缓存。
2. **决策缓存**：同一 token 序列直接复用 25 维 logits（FNV 哈希做 key，512 条上限）。
3. **检测结果复用**：结构签名（role+label+尺寸）+ 脏区 <3% 时，跳过整段卷积。

外加第 0 层：**A11y 已给文本的控件不再跑 OCR**（`labeled_boxes`）。

## 8. 实测数据

### 8.1 单模型延迟：一台机器上的两种 Provider

i7-13700K / RTX 3080 / ONNX Runtime 1.22.0，各 21 次取中位数。CPU 列为 12 线程：

| 模型（输入形状）       |    CUDA |         CPU | 比值 |
| ---------------------- | ------: | ----------: | ---: |
| 检测器 `[1,3,640,640]` |  6.5 ms |     22.4 ms | 3.5× |
| OCR `[1,3,48,320]`     |  2.6 ms |      6.4 ms | 2.5× |
| OCR `[4,3,48,320]`     |  3.6 ms |     17.4 ms | 4.8× |
| OCR `[8,3,48,320]`     |  6.9 ms |     30.8 ms | 4.5× |
| 决策 `[1,32]`          | 19.4 ms | **11.9 ms** | 0.6× |
| 决策 `[1,48]`          | 24.8 ms | **15.8 ms** | 0.6× |
| 决策 `[1,64]`          | 32.6 ms | **19.3 ms** | 0.6× |

`cargo run --release --example provider-bench` 可复现（见 `native/examples/provider-bench.rs`）。

### 8.2 整步延迟：三种 Provider 策略

1280×720 合成界面，`bun run bench`，各 9 次取中位数：

| 策略                                            |  首帧 |      冷启动 |     p95 |        热态 |   重复决策 |
| ----------------------------------------------- | ----: | ----------: | ------: | ----------: | ---------: |
| 默认（检测+OCR 走 CUDA，编码器留 CPU）          | 50 ms | **22.4 ms** | 25.0 ms | **15.1 ms** | **0.6 ms** |
| 全 CUDA（`ETA_COMPUTER_ENCODER_PROVIDER=cuda`） | 58 ms |     30.4 ms | 32.0 ms |     26.1 ms |     0.6 ms |
| 全 CPU（`ETA_COMPUTER_PROVIDER=cpu`）           | 66 ms |     47.5 ms | 61.7 ms |     16.5 ms |     0.6 ms |

三档对应的口径：**冷启动**是每步都要重跑检测与新决策；**热态**是控件集合未变、检测被跳过，只重算决策；**重复决策**是同一 token 序列命中缓存。

两个跨机器对比的结论：

- 与 285H（无独显）的 60.5 ms 冷启动相比，GPU 只把冷启动压到 22.4 ms——**瓶颈已经从检测器转到了编码器**（22.4 ms 里 15–16 ms 是编码器）。要继续降，方向是编码器本身（更短 prompt、蒸馏、或专门的 INT8 GPU kernel），而不是换更强的 GPU。
- 热态在三种策略下几乎一样（15–17 ms；全 CUDA 是 26 ms），因为热态本来就只剩编码器在跑。

首帧比冷启动多 25–30 ms，且只多一次：Bun 进程内首次 OCR 前向会额外付一次开销（与是否预热无关，重复调用不复现）。加载时的预热已经把 3 个模型、OCR 的 1–8 各档 batch、编码器的 32/64 两种长度都跑过一遍，所以这一项只影响第一帧。

缺 CUDA / cuDNN 时不会崩，探测会把原因原样记进 `providerChain`（本机去掉 CUDA 与 cuDNN 的 PATH 后实测）：

```json
"providerChain": [
  "cuda", "directml", "cpu",
  "cuda: … Error loading \"…onnxruntime_providers_cuda.dll\" which depends on \"cublasLt64_12.dll\" which is missing. (Error 126)",
  "directml: DirectML is not supported in this build of ONNX Runtime"
]
```

### 8.3 真实 Eta 页面（285H，ONNX Runtime 1.30 CPU EP）

1244×1631 截图 + 20 个实时 DOM 节点：

| 场景                    |   单步总计 | 判定                             |
| ----------------------- | ---------: | -------------------------------- |
| 冷启动（含 OCR 52.8ms） | **103 ms** | `click:#20 Inspect` p=1.000      |
| 热态（结构未变）        |  **19 ms** | `type:#14 Message Input` p=0.995 |
| 重复决策                | **1.0 ms** | 同上                             |

### 8.4 纯视觉桌面 Grounding 层：`WeVisOne-VL-2B`（`onnxruntime-genai` 0.17 + ORT 1.30 CPU EP）

针对完全无 A11y/DOM 树的纯视觉桌面控制（远程桌面、Canvas、中文复杂软件），在 `scripts/prepare-wevisone-oga.py` 与 `native/src/oga_grounding.rs` 中将 `tencent/WeVisOne-VL-2B`（原始 BF16 **4.69 GB**）裁剪并量化为 **1.44 GB** 的 `onnxruntime-genai` 三阶段模型包（`models/wevisone_vl_2b_oga/`）：

| 优化项                                                        | 原始体积 / 形态           | 瘦身/量化后                                | 收益                                                                                                                |
| ------------------------------------------------------------- | ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1. 剥离 `mask_decoder.pt` + 1024×1024 CNN 二次前向            | 36.4 MB + Teacher-Forcing | **0 MB**（直接移除）                       | 省去二次前向与高分辨率分割分支                                                                                      |
| 2. 24 层 Qwen3-VL ViT + 3 层 DeepStack Merger (`vision.onnx`) | 1,552.7 MB (FP32)         | **400.9 MB** (Dynamic INT8)                | 单图无分支导出，输出 8192 维 `[pooler, ds_0, ds_1, ds_2]`                                                           |
| 3. 输入词表查表 + 视觉特征散布 (`embedding.onnx`)             | 625.4 MB (BF16)           | **186.4 MB** (INT4 `GatherBlockQuantized`) | 复用量化词表（原模型 `embed_tokens` 与 `lm_head` 余弦相似度 0.9999）                                                |
| 4. 28 层 Qwen3-VL Decoder + RoPE 截断 + `lm_head` 1012 类裁剪 | ~3,080 MB (BF16)          | **844.3 MB** (INT4 `MatMulNBits`)          | RoPE 缓存从 262K 截断至 4096（-126 MB）；`lm_head` 仅保留 `<0>`..`<1000>` 坐标与 `none` 等 1012 个 token（-185 MB） |
| **总计**                                                      | **4,693.7 MB**            | **1,443.0 MB**                             | **体积缩小 3.25×**，天然语法约束解码（只输出合法坐标或 `none`）                                                     |

#### CPU 实测延迟（i7-13700K，8 P-Core 线程，224×128 / 28 视觉 Token）

通过 `OgaGenerator_RewindTo` 跨查询复用视觉 Prefix KV Cache（同一屏幕或 ROI 多次查询无需重跑 ViT 与视觉 Prefill），并结合前缀强制解码（`<ref>{query}</ref><point>` 仅需解码 2 个坐标 token）：

| 场景                                                        | ViT + 视觉 Prefill | Query Prefill |     Decode | **端到端总耗时** | 输出示例                                                                     |
| ----------------------------------------------------------- | -----------------: | ------------: | ---------: | ---------------: | ---------------------------------------------------------------------------- |
| **冷启动 Point**（首帧新画面 + 定位点击坐标）               |           351.4 ms |      140.8 ms |    30.6 ms |     **523.1 ms** | `<ref>the blue button...</ref><point><289><413>` → `(185, 149)`              |
| **热缓存 Point**（同画面二次查询，`OgaGenerator_RewindTo`） |         **0.0 ms** |      126.8 ms |    27.1 ms |     **154.0 ms** | `<ref>the blue button...</ref><point><289><413>` → `(185, 149)`              |
| **热缓存 Box**（同画面框选目标，4 个坐标 token）            |         **0.0 ms** |      192.1 ms |    82.9 ms |     **275.0 ms** | `<box><537><353><784><460>` → `{x:344, y:127, w:158, h:39}`                  |
| **热缓存 Reject**（目标不存在，1 个 `none` token 即停）     |         **0.0 ms** |      201.2 ms | **0.1 ms** |     **201.3 ms** | `<box>none` → `rejected: true`（零幻觉拒识）                                 |
| **4K 两阶段中央凹精修**（3840×2160 全局 28t + 局部 24t）    |           325.7 ms |      213.9 ms |   478.5 ms |   **1,018.1 ms** | 粗定位 `(2903, 1509)` → 1:1 精修 **`(2890.8, 1530.6)`**（真值 `2890, 1528`） |
| **System-1 接力追踪**（WeVisOne 注入持久锚点后的下一帧）    |             0.0 ms |        0.0 ms |     0.0 ms |      **17.9 ms** | `PersistentAnchorTracker` 继承语义标签，回到 15ms 投机闭环                   |

#### 多分辨率与 4K 中央凹（Foveated）自适应策略

为避免真实屏幕（从 1366×768、21:9 带鱼屏到 4K 3840×2160）因固定尺寸下采样丢失小字号/小图标细节，同时避免 4K 全量送入 ViT 产生 ~8,100 个视觉 Token（CPU >20s），采用三级自适应路由：

1. **保长宽比 Smart-Resize（`smart_resize_qwen3_vl`）**：按输入画面或 ROI 的真实长宽比计算最接近的 `32` 倍数网格（`patch_size=16 × merge=2`），在 `maxVisualTokens` 预算内保持比例无畸变；OmniParser YOLOv8 同步改为等比例 Letterbox 缩放。
2. **脏矩形 1:1 原生裁剪（Dirty-ROI Native Crop）**：当 `dirtyAreaRatio` 位于 `(0.002, 0.35)`（如弹出菜单、对话框、悬停提示）时，直接裁剪 `dirty.union_dirty`（外扩 48px）以 1:1 原生像素送入 `WeVisOne-VL-2B`。
3. **两阶段粗到细中央凹放大（Coarse-to-Fine Foveated Zoom）**：高分屏（`>=1600×900`）全屏查找时，Stage 1 先用 28 个视觉 Token 全局粗定位（~325ms），Stage 2 以粗定位点为中心从 4K 原图裁剪 1:1 高清窗口（24 个视觉 Token，~478ms）精修坐标，并在精修后自动恢复 Stage 1 的全局 KV Cache。

## 9. 五个反直觉的实测发现

**① INT8 量化是决定性的。** ModernBERT 151M：FP32 578MB → FP16 290MB → QInt8 146MB；seq_len 32 时 27.7ms → **12.4ms**，三类判例判定完全不变（正常匹配 0.998→0.9965、越界弃权 0.913→0.669、歧义 0.9938→0.9765）。弃权概率从 0.913 降到 0.669 是唯一可见变化，仍远高于阈值。

**② ORT 线程不是越多越好，但「拐点」是机器相关的。** 285H 上（Bun 进程内）4 线程编码器 24.6ms、6 线程 19.8ms、8 线程 70ms、16 线程 236ms，于是默认取 `cores/4` 且上限 6。13700K 上重测却是单调变好：编码器 [1,48] 在 6/8/12 线程下是 18.7/17.3/15.8 ms，OCR batch 8 是 50/38/31 ms。默认因此改成「逻辑核数的一半、上限 12」，`ETA_COMPUTER_THREADS` 保留为逃生口——线程数是本机专属参数，不该硬编码。

**③ 64d 视觉分支几乎免费。** 在 OmniParser 图上嫁接 64d L2 归一化分支后，检测器 17.69ms vs 原始 17.81ms（285H CPU）——它复用 Neck 的同一份特征图，不是新增一次前向。做法是直接对 ONNX ModelProto 做 protobuf wire 编辑，追加 `Conv → Add → LpNormalization` 三个节点与一个新输出。

**④ DPI 坑在真实环境复现了。** 实测浏览器截图 1244×1631（含 DPR 与整页高度），而 `getBoundingClientRect()` 返回 1038×858 CSS px。不做 `CSS px → device px` 变换就融合，A11y 标签整体错位，OCR 跳过逻辑随之失效。接真实采集层时这是第一件要处理的事。

**⑤ 小模型搬上 GPU 会更慢，「全 GPU」不是目标。** 151M 的 INT8 编码器在 RTX 3080 上是 24.8 ms（[1,48]），CPU 上是 15.8 ms。原因是它每个 token 的算量太小：kernel launch、量化/反量化的开销超过了 GEMM 省下的时间，而且 INT8 权重在 CUDA 上要过 `QuantizeLinear`/`DequantizeLinear`（ORT 的 CUDA INT8 GEMM 覆盖不到这个形状）。这就是「按模型选 Provider」的来源——三个模型的硬件最优解并不一致，引擎必须允许它们分道。

## 10. 公开基准：ScreenSpot-v2 上的实测（纯视觉路径）

`scripts/eval-screenspot.ts` 跑 ScreenSpot-v2 全量 1241 个样本（desktop 334 / web 437 / mobile 470）。数据集不传 `structuralNodes`，即**只有像素、没有无障碍树**——这是最难的路径，也是本包唯一能被公开基准公平打分的路径。

评分口径与官方一致：预测框中心落在 GT 框内即算命中。另算 `recall@0.5`（GT 元素是否出现在检测提议里），因为它是准确率的**硬上限**。

| split    | recall@.5 | point-acc | 仅按置信度 | 仅按标签词重叠 | 中位耗时 |
| -------- | --------: | --------: | ---------: | -------------: | -------: |
| desktop  |     46.1% |     14.1% |       7.5% |          16.5% |   215 ms |
| web      |     50.3% |     15.8% |       8.2% |          22.9% |   239 ms |
| mobile   |     48.5% |     10.6% |      11.1% |          17.2% |   186 ms |
| **全部** | **48.5%** | **13.4%** |   **9.1%** |      **19.0%** |   225 ms |

### 三个结论，都是负面的

**① 检测器召回只有 48.5%，这是天花板。** 1075 个未命中里有 608 个（57%）根本没有被提议出来——不是选错，是没看见。后续任何决策改进都不能突破这条线。

**② 151M 决策头目前是在减分的。** 13.4% 低于「只按标签词重叠选」的 19.0%。也就是说在这个任务上，一个零成本的字符串匹配比整个编码器更准。

**③ 加候选没用，反而更差。** 把候选从 4 提到 12：desktop 准确率 14.1% → 12.3%，Jev 延迟 45 → 70 ms。瓶颈不是候选集大小，是判别本身——所以那个开关没有留下。

### 为什么

- **没有 A11y，标签就没有信息。** 纯视觉下标签来自 OCR 或被压成 `button:#3f2a` 这种哈希。`close this window` 要和标题栏那个 `×` 对上，需要的是图标语义，而检测器只输出宽扁比启发式的 `button`/`input` 两类。
- **提案粒度不匹配。** 典型错误是把一张卡片拆成子区域（`y=450,h=230` 被切成 `y=580,h=109`），IoU 掉到 0.48。
- **指令是省略式的。** "minimize this window" 里没有任何词出现在屏幕上，靠的是对窗口按钮布局的先验。

### 这说明什么

纯视觉 grounding 需要一个真正的视觉语言模型：OmniParser 的检测框 + 分类头做不到，一个字符串匹配甚至比它更好。这组数字是 `WeVisOne-VL-2B` 的**验收下限**。

反过来，带无障碍树的路径不受这些限制：树给出了 role、label、focused、层级，上面那套融合与持久锚点才有意义。ScreenSpot 测不到这条路径，这是基准本身的局限，不是实现的问题。

---

## 10.1 WeVisOne-VL-2B 接入后的对比

`scripts/eval-screenspot.ts --engine wevisone` 用**完全相同的评分口径**跑同一个数据集。desktop 与 web 两个 split 已跑完，mobile 因单次调用约 7 秒、总耗时过长而中止在 175/501。

| split   | OmniParser 路径 |  WeVisOne | 提升 | 样本 |
| ------- | --------------: | --------: | ---: | ---: |
| desktop |           14.1% | **68.0%** | 4.8x |  325 |
| web     |           15.8% | **53.4%** | 3.4x |  425 |
| mobile  |           10.6% | **73.1%** | 6.9x |  175 |

代价是延迟：一次 grounding 在中位 1920×1080 帧上约 **7.3 秒**（CPU，每模型 8 线程）。这不是每步动作的开销——它只该在 System-1 拿不准、需要纯视觉兜底时调用一次。

### 接入时发现的两个 bug，让这个模型此前几乎不可用

刚接入时 WeVisOne 在 ScreenSpot 上只有 **0–4%**，看起来像是模型本身不行。实际是两个配置错误：

**① `max_length` 被硬编码为 512。** 这个上限约束的是**整条序列**（视觉 token + 提示 + 解码出的坐标）。1920×1080 的截图在原生分辨率下需要约 510 个视觉 token，512 的额度直接让 prefill 被拒绝。现在改为默认 2048（`ETA_WEVISONE_MAX_LEN` 可覆盖），模型准备的 RoPE cache 本就按 4096 位切好。

**② 视觉 token 预算默认只有 32。** 更隐蔽的是 TS 层写了 `input.maxVisualTokens ?? 32`，于是「调用方没意见」被当成**字面量 32** 传给原生层，把原生的默认值彻底遮住——原生改默认值时完全不起作用。现在 TS 传 0 表示「用原生默认」，原生把 0 当作未指定，默认 512（即原生分辨率）。

两个 bug 叠加的效果：截图被降采样到 28 个视觉 token，等于给模型看一张马赛克，`close this window` 自然指向不了标题栏的 `×`。修完之后同一批样本从 0/12 变成 7/12，全量 desktop 到 68.0%。

这个教训值得记着：**一个「默认值」出现在两层里，就一定会有一层悄悄失效。**

---

## 11. Intel OpenVINO EP：把感知搬到 iGPU / NPU

### 为什么值得单独一条路

这套硬件的算力分布很偏：Meteor Lake 的 NPU（`8086:7d1d` rev05）与 Arc iGPU 都闲着，而 detector 的卷积栈要吃掉整步一半的时间。ONNX Runtime 里唯一能同时摸到 Intel CPU / iGPU / NPU 的执行后端是 `OpenVINOExecutionProvider`。

### 一个绕不开的版本陷阱

官方只有 `onnxruntime-openvino` 这个 PyPI 包带 `OpenVINOExecutionProvider`，而它**止步于 1.24.1**。默认构建用的是 ORT 1.30.0。这带来两个硬性后果：

1. **必须换运行时，不是加 feature。** `ETA_COMPUTER_ORT_VARIANT=openvino`（或只要设了 `ETA_OPENVINO_DEVICE`）会让 `scripts/build.ts` 去 PyPI 拉 1.24.1 的 wheel、把 `capi/` 下的 `.so` 与四个 OpenVINO 插件摊成一个普通运行时目录，再照常链接。见 [build.ts](./scripts/build.ts) 的 `provisionOpenVinoOrtRuntime()`。
2. **同一进程只能有一份 `libonnxruntime.so.1`**，所以 OpenVINO 构建与默认构建**不能共存**。切回默认要重新 `bun run build`。

### 实测：iGPU（Arc，非 NPU）

285H，`ETA_OPENVINO_DEVICE=GPU`，1280×720，缓存全部击穿（每轮标签文本与控件位置都变），12 轮取中位数：

| 阶段 | CPU EP | OpenVINO GPU EP | 倍率 |
| --- | --- | --- | --- |
| detector（含 64d 分支） | 49.9 ms | 13.6 ms | **3.7×** |
| OCR rec（逐 anchor） | 19.4 ms | 12.7 ms | 1.5× |
| 整步（无 A11y 节点） | 106.8 ms | 73.3 ms | 1.46× |
| 整步（有 A11y 节点，OCR 被跳过） | 82.6 ms | 44.4 ms | 1.86× |

三个反直觉处：

- **首次 OCR 反而慢 6 倍**（113 ms vs 18 ms）。那不是推理而是 iGPU 图编译。第二帧起就反过来（12.7 vs 19.4 ms）。所以「第一次跑得慢」不能当成 EP 变慢的证据。
- **blob 缓存是真的有用。** 默认写到 `$XDG_CACHE_HOME/eta-computer/openvino`（`ETA_OPENVINO_CACHE` 可改，置空则关掉）。暖缓存后 detector 14.9→12.3 ms，冷步 p95 121→73 ms，一次编译产出 348 个 blob。
- **INT8 encoder 在 OpenVINO GPU 上直接算错。** 它返回非有限 logits，softmax 一路 NaN 下去，最后吐给调用方的 JSON 里出现裸 `NaN`——`JSON.parse` 当场炸。两层都补了：`encoder_chain()` 把 OpenVINO 从 encoder 的候选链里剔掉（只有 `ETA_COMPUTER_ENCODER_PROVIDER=openvino` 能强行指定），`predictor.rs` 在 softmax 前把非有限 logit 折成弃权。

### 为什么 WeVisOne 用不了这条路

`WeVisOne-VL-2B` 跑在 `onnxruntime-genai` 上，而它的 decoder 用了 `com.microsoft::MRotaryEmbedding`——ORT **1.26 之后**才注册的 contrib op。1.24.1 加载它直接失败：

```
Fatal error: com.microsoft:MRotaryEmbedding(-1) is not a registered function/op
```

OGA 本身还会先打两行 `The requested API version [26]/[25] is not available` 再退让。因此 OpenVINO 构建下 Grounding 层不可用，`eval-screenspot.ts --engine wevisone` 与实验 9 都会跳过。要两者兼得只有两条路：把 decoder 转成 OpenVINO IR 走 OpenVINO 原生 API（脱离 ORT 版本约束），或者让 Grounding 跑在独立进程里。

### NPU：代码到位，机器没通

`/sys/class/accel/accel0` 存在（261:0），`intel_vpu` 已加载，但 `/dev/accel/accel0` 这个设备节点不存在；即便它存在，权限也是 `root:render 660`，而当前用户只在 `mikanrico input wheel` 组。所以 `ETA_OPENVINO_DEVICE=NPU` 的实测结果是：

```
[OpenVINO] Device NPU is not available
[eta-computer] execution provider `openvino` unavailable, falling back
```

回退路径本身是好的——不会崩，只是退回 CPU。要真正跑通 NPU 需要 root：

```bash
sudo mknod /dev/accel/accel0 c 261 0
sudo chgrp render /dev/accel/accel0 && sudo chmod 660 /dev/accel/accel0
sudo usermod -aG render "$USER"   # 之后重新登录
```

### 顺带修的一件事

原生层以前完全没有「这个运行时长什么样」的自省接口，判断能力只能靠构造一个引擎再偷看 step 里的字段。现在有 `EtaComputerRuntimeInfo()` / `runtimeInfo()`，返回 `{ortVersion, providers}`；`weVisOneSupported()` 基于它判断（ORT ≥ 1.26）。`provider_chain()` 也改成先问 `GetAvailableProviders` 再决定候选——以前在纯 CPU 构建上每条会话都会白打一行 CUDA 回退日志。

## 12. 尚未落地

- **真实采集/注入层**（Linux PipeWire/XShm + `uinput`、Windows DXGI + `SendInput`、Playwright CDP）。当前只有合成帧与静态截图。
- **Harness 工具与插件**：`computer_act` / `computer_observe`，以及 `@eta/plugin-computer`。
- **物理熔断**：全局热键与鼠标晃动监听。
- **A11y 采集**：目前结构节点由调用方传入，影子树尚未实现。
- **DirectML / CoreML 只到「能被探测」的程度。** 探测与回退路径都有，但只有 CUDA 在有显卡的机器上真跑过；DirectML 需要一份带 DML provider 的 ONNX Runtime（官方 GPU 包不含），CoreML 需要 Apple 硬件。
- **Provider 组合是「换哪个 ORT 构建」决定的**，不是插拔的。同一进程里只能有一份 `onnxruntime.dll`，所以 CUDA / DirectML / OpenVINO 三者不能同时可用；要换就得重跑 `bun run build`。
- **NPU 从未真正跑过一次推理。** 见 §11：设备节点与 `render` 组权限两道关都在 root 手里。
- **OpenVINO 构建下没有 Grounding 层**（ORT 1.24.1 缺 `MRotaryEmbedding`），除非把 decoder 转成 OpenVINO IR 换掉 OGA。

## 参考文献

- UI-JEPA: arXiv:2409.04081
- Web Agents with World Models (WMA): arXiv:2410.13232, ICLR 2025
- Speculative Actions: arXiv:2510.04371, ICLR 2026
- Jev-Mobile: arXiv:2609.30186
- OpenJev-RLCD: arXiv:2609.38850
- OmniParser V2: arXiv:2502.16161
- Executable Agentic Memory for GUI Agent: ICML 2026
