# ESM-REFR: 激进重构方案

## 🎯 核心目标

- 删除所有死代码
- 合并 eta-esm-mode → eta-harness
- 只保留 3 个工具：`esmrun` / `esmrunandkeep` / `ask_user`
- Prompt 改为代码视角
- 实现能力 delta 通知

---

## 🗑️ 删除清单

### eta-harness

- ✅ `tools/read.ts` / `tools/write.ts` / `tools/bash.ts`
- ✅ `tools/state.ts` / `tools/edit-diff.ts` / `tools/file-mutation-queue.ts`
- ✅ `tools/subagents.ts`
- ✅ `subagent.ts` / `subagent-plan.ts`
- ✅ `btw.ts`
- ⚠️ `open.ts` - 删除 btw 残留
- ⚠️ `open.ts` - 删除 SubagentManager 创建
- ⚠️ `open.ts` - 删除旧工具注册

### eta-core

- `kernel/goal.ts` - 整个 goal 系统
- `types/entries.ts` - `GoalEntry` 类型
- `session/*` - goal 相关逻辑
- 搜索所有 `goal` 关键词，全删

### eta-server

- `subagent.ts`
- `manager.ts` - 移除 SubagentManager 逻辑

### client-contracts

- `types.ts` - `SessionViewBtwThread` / `SessionViewSubagent`
- `types.ts` - `sideThread` / `subagents` 字段
- `operations.ts` - `btw*` 操作

### 移入 TOBEREFR/

- ✅ `eta-mcp`
- ✅ `eta-plugin-*`（akhook / git / sdk / ssh）
- ✅ `eta-ssh`

---

## 🔄 合并 eta-esm-mode → eta-harness

### 文件移动

```bash
# 源码
cp -r eta-esm-mode/src/* eta-harness/src/esm/

# 测试
cp -r eta-esm-mode/test/* eta-harness/test/esm/

# 依赖合并
# eta-harness/package.json 加上 ripgrep
```

### 导出改写

```ts
// eta-harness/src/index.ts
export { Agent } from "./esm/agent";
export { EnvFile, EnvLayers } from "./esm/layers";
export type { Capability, CapabilityMeta } from "./esm/env-file";
```

### open.ts 改写

```ts
// 导入 esm-mode Agent
import { Agent } from "./esm/agent";

// 创建 Agent（不是 Kernel）
const agent = await Agent.create({
  root: sessionDir,
  project: projectDir,
  global: globalDir,
});

// 工具只有 3 个
const tools = [
  // esmrun / esmrunandkeep 在 agent.realm 里
  createAskUserTool(...),
];
```

---

## 🛠️ 工具面改造

### 删除的工具

- ❌ `read` / `write` / `bash` / `glob` / `grep`
- ❌ `update_state` / `check_state` / `list_state`
- ❌ `Agent` / `get_subagent_result` / `steer_subagent`
- ❌ `edit` (旧的 edit-diff)
- ❌ `btw*`
- ❌ `goal*`

### 保留的工具

- ✅ `esmrun` - 执行代码
- ✅ `esmrunandkeep` - 执行并持久化
- ✅ `ask_user` - 问人

### 可选快捷工具

- `view_memory` - 读 MEMORY.md（可选）
- `list_capabilities` - 列已持久化能力（可选）
- `read_state` - 读 eta.state（可选）

---

## 📝 Prompt 改写

### 旧 Prompt（工具列表）

```
你有以下工具：
- read - 读文件
- write - 写文件
- bash - 执行命令
...
```

### 新 Prompt（代码环境）

```
你在一个 JavaScript realm 里工作。

全局可用：
- $`...` - 执行 shell 命令（zx lite）
- search(pattern, options?) - 搜索文件内容
- view(path, options?) - 查看文件（带行号）
- edit(path, oldText, newText) - 精确替换
- eta.define(name, fn) - 定义能力（持久化）
- eta.ask(prompt) - 递归调用自己
- eta.state - 唯一的写穿变量容器
- platform.llm.chat(...) - 裸 LLM 调用

规则：
- 执行的代码会持久化
- eta.define 写到项目层，别人能用
- 文件操作优先用 search/view/edit，不用 $ grep/sed
- eta.ask 无限递归，≥10 层只 warning
```

---

## 🔔 Delta 通知

### 实现位置

- `eta-harness/src/esm/delta.ts`

### 功能

```ts
// 计算变化
const delta = computeDelta(prevSnapshot, currSnapshot);

// 格式化
const deltaText = `
## 能力变化

新增：
- format(text) - 格式化文本

修改：
- shout(msg) - 现在支持颜色
`;

// 插入到 user message 前
messages.unshift({
  role: "user",
  content: deltaText,
});
```

### 触发时机

- 每次模型调用前
- 如果 delta 为空，不插入

---

## 🧪 验收标准

### 代码层面

- ✅ 旧工具全删（read/write/bash/state/edit-diff/subagents）
- ✅ Subagent 系统全删
- ✅ Btw 系统全删
- ✅ Goal 系统全删
- ✅ eta-esm-mode 合并到 eta-harness
- ✅ 工具表只有 3 个
- ✅ Prompt 是代码视角
- ✅ Delta 通知工作

### 测试层面

- ✅ `bun test` 全绿
- ✅ `bun run typecheck` 全绿
- ✅ 前端不红
- ✅ 能启动服务器并创建会话

---

## 📋 执行顺序

### 1. 清理 eta-harness（当前进行中）

- ✅ 删除工具文件
- ✅ 删除 subagent / btw 文件
- ⚠️ 清理 open.ts 残留
- ⚠️ 清理 index.ts 导出

### 2. 清理 eta-core

```bash
rm packages/eta-core/src/kernel/goal.ts
# 搜索并删除所有 goal 引用
```

### 3. 清理 eta-server

```bash
rm packages/eta-server/src/subagent.ts
# manager.ts 移除 SubagentManager
```

### 4. 清理 client-contracts

```ts
// types.ts - 删除 btw / subagent 类型
// operations.ts - 删除 btw 操作
```

### 5. 合并 eta-esm-mode

```bash
mkdir -p packages/eta-harness/src/esm
cp -r packages/eta-esm-mode/src/* packages/eta-harness/src/esm/
cp -r packages/eta-esm-mode/test/* packages/eta-harness/test/esm/
rm -rf packages/eta-esm-mode
```

### 6. 改写 open.ts

- 导入 `Agent` from `./esm/agent`
- 创建 Agent 而不是 Kernel
- 只注册 3 个工具
- 删除 goal / subagent / btw 逻辑

### 7. 改写 prompt

- `prompts/base.ts` - 改为代码视角
- 删除工具列表
- 加上 realm 全局函数说明

### 8. 实现 delta

- `src/esm/delta.ts` - 计算和格式化
- `open.ts` - 在消息组装时插入 delta

### 9. 验证

```bash
cd packages/eta-harness
bun test
bun run typecheck

cd ../eta-server
bun test
bun run typecheck

cd ../../apps/web
bun run typecheck
```

---

## 🚀 预计工作量

- 清理 eta-harness：**30 分钟**（已完成 70%）
- 清理 eta-core：**20 分钟**
- 清理 eta-server：**10 分钟**
- 清理 client-contracts：**10 分钟**
- 合并 eta-esm-mode：**30 分钟**
- 改写 open.ts：**40 分钟**
- 改写 prompt：**20 分钟**
- 实现 delta：**20 分钟**
- 测试和修复：**30 分钟**

**总计**：约 3.5 小时

---

## 🎉 完成后的世界

### 包结构

```
packages/
├── TOBEREFR/           # 待重构
│   ├── eta-mcp
│   ├── eta-plugin-*
│   └── eta-ssh
├── eta-core            # 内核（无 goal）
├── eta-harness         # 会话管理 + esm-mode
│   └── src/
│       ├── esm/        # 原 eta-esm-mode
│       ├── open.ts     # 简化版
│       └── prompts/    # 代码视角
├── eta-server          # 服务端（无 subagent）
├── eta-compaction      # 压缩
├── eta-storage-jsonl   # 存储
├── client-contracts    # 契约（无 btw/subagent）
└── client-wire-proto   # 传输
```

### 工具面

```
只有 3 个工具：
- esmrun
- esmrunandkeep
- ask_user

其他都在 realm 里：
- search / view / edit
- eta.define / eta.ask / eta.state
- platform.llm.chat
- $ (zx)
```

### Prompt

```
简洁、代码视角、meta
不列工具，讲环境
```

### Delta

```
每次调用前告知能力变化
模型能看到自己定义了什么
```

---

## ⚡ 下一步

继续执行当前进度：

1. 清理 open.ts 的 btw 残留
2. 验证 eta-harness typecheck 通过
3. 开始清理 eta-core 的 goal 系统
