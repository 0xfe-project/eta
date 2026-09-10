# D0M — 下一代大一统前端框架架构

> **哲学:编译产物只剩一个抽象树。**
> D0M 的名字就是这句话:D0M 编译完 JSX/TSX 之后,除了必要的 scripting(反应图),剩下的只有一棵抽象的节点树 —— 我们叫它 **D0M tree**。这棵树被当作纯数据,喂给一个数据驱动的渲染后端:**web 上是浏览器的合成器(GPU),native 上是 wgpu / skia(GPU)**。同一个 bundle,两种后端,一套反应模型。
>
> 对标:`solidjs 2.0` 让 framework 做更少(async 进反应图);D0M 再进一步 —— 把"渲染后端"本身也变成可插拔的 host。framework 不再知道 DOM 长什么样,它只知道"这棵树上有哪些值、哪些会弹、样式原子是什么"。

---

## 目录

1. [为什么做](#1-为什么做)
2. [好处](#2-好处)
3. [革新点](#3-革新点)
4. [核心心智模型](#4-核心心智模型)
5. [三模块总览](#5-三模块总览)
6. [模块一:D0M 核心](#6-模块一d0m-核心)
7. [模块二:nagi 凪 0wind](#7-模块二nagi-凪-0wind)
8. [模块三:adapters 与 host 契约](#8-模块三adapters-与-host-契约)
9. [端到端数据流](#9-端到端数据流)
10. [已拍板的决策](#10-已拍板的决策)
11. [怎么做(里程碑)](#11-怎么做里程碑)
12. [风险与未决问题](#12-风险与未决问题)

---

## 1. 为什么做

现在的"跨平台前端"只有三条路,每条都缺一块:

| 路线 | 代表 | 缺的那块 |
|---|---|---|
| 浏览器套壳 | Electron / Tauri + WebView | 4 线程 2 进程、CSS 引擎、reflow 全背着,只为画几个 div;内存/冷启动都糟 |
| 编译到原生控件 | React Native / Flutter | 状态/布局/动画各走各的,写起来像前端、跑起来不像前端;动画要手写 |
| 原生 UI 框架 | SwiftUI / Compose / GPUI | 绑死在单平台,状态模型和 web 不通,团队两套心智 |

而且这几条路**都把"动画"当成后加的东西**:CSS transition 要手写 cubic-bezier,JS 动画库(motion.dev 之类)要每帧跑 JS,SwiftUI 的自动 spring 又不跨平台。**没有一个框架把"自动 spring + 自动 morph"当成一等公民做进反应模型本身。**

D0M 要的是:像 SwiftUI 一样**写状态,动画自己发生**;像 motion.dev 一样**手感可控**;像 Solid 一样**编译成精确的细粒度更新**;像 PocketJS 一样**原生后端只画像素、没有 DOM/CSS 引擎**;而且**一套代码同时跑 web 和 native**。

一句话:我们要一个**开发体验像前端、动画体验像 SwiftUI/motion.dev、运行时像游戏引擎、部署面像 web**的框架。

---

## 2. 好处

### 对用户(开发者)

- **动画零成本**:状态一变,布局/透明度/颜色/transform 自动 spring 过去,不写 transition、不写 keyframe、不写 `useEffect`。想要果冻感,什么都不用做(默认就有)。
- **morph 零成本**:两个界面之间,`id` 相同的元素自动从一个位置/形状"长"到另一个位置/形状,不用 FLIP、不用 shared-element-transition 库。
- **一套代码两个世界**:同一个 `.tsx` 编译到 web(真实 DOM)和 native(wgpu/skia 像素)。样式用 tailwind 子集写,一套原子表两边都用。
- **没有样式漂移**:Stylex 式原子 CSS,last-applied-wins,没有 cascade/specificity,没有"style at a distance"。

### 对性能

- **编译期做完能做的**:样式冲突消解、原子化、spring 参数烘焙,全在 build 时,运行时只剩查表。
- **native 端零 per-frame scripting**:spring/morph 的物理推进在 host core 里(不经过 JS),一帧动画 = 一次矩阵更新 + 一次 draw,没有 JS 参与。PocketJS 已经在 PSP 上证明了这个模型:2.2ms JS + 8.4ms CPU 就 hold 住 60fps。
- **web 端不额外加税**:同一份原子样式喂给浏览器,浏览器本来就 GPU 合成,不引入新引擎。

### 对工程

- **反应核心和渲染后端解耦**:一个 split-effect 接缝(下面讲),换后端只换接缝的另一半,反应图、编译、样式、动画全复用。
- **可测试**:帧时钟 + 纯函数(见 §4),动画能 golden-test、能回放,不用等真实时间。

---

## 3. 革新点

按重要性排序,这些是 D0M 区别于"又一个框架"的地方:

1. **动画是反应系统的属性,不是库。** spring 不是 `motion.div`,不是 CSS transition。任何一个可动画值,它的"信号值"就是目标值,渲染值是弹簧朝目标收敛的过程。这跟 Solid 2.0 说"async 是图的属性"是同一句话:我们让 **motion 成为图的属性**。

2. **morph 是身份稳定节点的几何弹簧。** 同 `id` 的节点在树重构时不被销毁;core 拿到旧 layout box 和新 layout box,tween。**morph 不需要第二套动画系统,它是 spring 在"几何"上的特例。** SwiftUI 的 `matchedGeometryEffect` 要显式声明,D0M 里只要 `id` 相同就自动发生。

3. **编译产物 = 抽象树 + 三张表(style / motion / mutation)。** framework 不产出 DOM,产出的是数据。web 和 native 消费同一份数据,各自物化成不同的东西。这是"大一统"的技术支点。

4. **host 契约(隐藏的第四模块)。** 三个模块之外,真正让跨平台成立的是一个 wire protocol:mutation stream + style table + motion intent + frame。它等价于 PocketJS 的 `contracts/spec`,是我们最核心、也最需要先冻结的东西。

5. **帧时钟 + async 落地在帧边界。** 异步数据(网络回复、server function)什么时候到都行,但**在下一个帧边界以 FIFO 应用**。这样你同时得到:async(吞吐不降)和可选的确定性(回放/时间旅行调试,生产可关)。见 §10 决策 5。

6. **构建期冲突消解(nagi)。** 借鉴 shadcn 的 `cn`,把 tailwind 的冲突表在 build 时编译进去,运行时 class 合并接近零成本;再借 StyleX 的原子化,类名冲突彻底消失。

---

## 4. 核心心智模型

### 4.1 编译产物:抽象树 + 三张表

```
D0M 编译产物(框架无关的中间表示,D0M IR)
├── tree    : 带 key 的节点树 + 增量 mutation stream
├── styles  : 原子 style 表(baked,last-applied-wins)
├── motion  : spring / keyframe 意图表(曲线参数 + 目标值)
└── script  : 必要的反应图(signal / memo / effect),这是唯一剩下的"scripting"
```

"D0M 的意思"就在这里:**除了必要的 scripting,编译出来只剩这棵树 + 三张表,然后由数据驱动的 GPU 跑。web 也一样 —— 浏览器本身就是数据驱动的 GPU 合成器。**

### 4.2 帧契约

```
state_{n+1} = F(state_n, input_n)
pixels_n    = G(state_n)
```

- **effects 落在帧边界**:半帧到达的网络回复排队,在下一帧开始、任何应用 hook 之前、按 FIFO 投递。没有 microtask race,没有 mid-frame callback。
- **时间 = 帧计数器**(不是墙钟):spring 的物理按帧推进,所以动画可回放、可 golden-test。墙钟只在"要不要生成下一帧"这个决策上用。
- 这是 PocketJS 的模型,我们整个采纳。它不降低吞吐(反而省掉调度开销),代价只是"长任务要切帧、不能随便 `setTimeout`"。

### 4.3 分层:framework 薄,hoster 厚

```
  ┌─────────────────────────────────────────────┐
  │  D0M framework (JS/TS)                      │
  │   signal graph · async graph · motion intent│
  │   compiler: JSX → D0M IR                    │
  └─────────────────────────────────────────────┘
                       │ host 契约(wire)
  ┌─────────────────────▼───────────────────────┐
  │  adapter (web / native)                     │
  │   layout · spring 物理 · morph · 像素       │
  └─────────────────────────────────────────────┘
```

关键结论:**framework 不知道几何**。它只发"这个节点的 y 是一根 ω=6、ζ=0.7 的弹簧"这种**意图**。真正的布局、弹簧物理、几何全在 adapter。这带来两个好处:

1. adapter 换布局引擎(taffy / yoga)、换渲染器(wgpu / skia)都不碰 framework;
2. 动画的每帧推进在 adapter 里,不经过 JS(决策 2 说 web 无所谓,所以 web adapter 用 rAF 推也行)。

### 4.4 接缝:split effect

Solid 2.0 的 `createEffect(compute, apply)` 是 D0M 的**命门**:

```ts
createEffect(
  compute: () => layout,   // 纯反应计算,读 signal 产出结构
  apply:   (v) => ...,     // 唯一碰 host 的地方:把 mutation 发给 adapter
)
```

`compute` 是纯函数(可测试、可重放),`apply` 是唯一有副作用、唯一感知"现在跑在 web 还是 native"的地方。**换 adapter = 只换 apply。** 这是我们整个架构的接缝,也是最需要保证纪律的地方:`compute` 里永远不许碰 host。

---

## 5. 三模块总览

| 模块 | 名字 | 职责 | 对应参考 |
|---|---|---|---|
| 1 | **D0M** | JSX/TSX 编译器 + signal 图 + async 图 + motion intent + stylex 式样式机制 | Solid 2.0(反应核)+ SwiftUI/motion.dev(动画语义)+ StyleX(样式) |
| 2 | **nagi(凪)0wind** | 把 tailwind 子集在构建期编译成 D0M 的原子样式表,零运行时冲突 | Tailwind + shadcn `cn`(冲突消解)+ StyleX(原子化) |
| 3 | **adapters** | 消费 host 契约,产出像素:web adapter + native adapter | PocketJS(host 架构)+ Blitz(taffy+stylo+vello)+ gpuix(已有 mutation 协议) |

`nagi` 取名"凪"(风平浪静),0wind = 编译期把 class 风浪全熨平,运行时一点风都没有。

---

## 6. 模块一:D0M 核心

### 6.1 编译器

- **输出**:每个组件编译成一段"如何从 signal 生成 D0M 子树"的代码,外加静态的 style/motion 表。JSX 里的 `className`、`style`、`id`、`no-animation` 等在编译期归位。

### 6.2 signal 图 + async 图

- signal 是唯一原语;memo 可以返回 Promise(async 在图里,下游自动理解),沿用 Solid 2.0 的模型 —— `isPending` / `latest` 读图的状态,不需要 `createResource` / `startTransition`。
- 状态写批量落在一个 microtask,`flush()` 强制立刻应用。

### 6.3 motion intent(自动 spring)

**这是 D0M 区别于一切框架的东西。** 一个可动画值(布局、opacity、color、transform)天然是"弹簧目标":

```ts
const x = createSignal(0);   // x 是目标值
// 渲染时:y = spring(x, { frequency: 6, damping: 0.7 })
// 开发者在 JSX 里什么都不写,默认就有 spring
```

- **默认全开(果冻感)**:我们拍板默认所有可动画值都自动 spring。想关就 `<div no-animation>`(可继承,opt-out 整棵子树)。
- **果冻参数是全局 design token**,不是散在每个节点:`frequency` / `damping`(或 response/damping)在主题里配,一个开关统一调手感。
- **两个必须守住的语义**:
  1. **appear 不弹,change 才弹**。初始挂载/路由切换/列表插入,元素从默认值"飞进来"会让整个 app 在 loading 后集体弹一遍。默认"出现 = 直接到位,变化 = spring"。(adapter 记录每个节点"是不是第一帧"来区分。)
  2. **settle 阈值**。弹簧永不严格收敛,必须 `velocity<ε && |Δ|<ε` 就判到位、停止请求下一帧,否则帧循环退不出来白烧 GPU。
- **曲线是共享 spec**:spring 用阻尼谐振子(Ryan Juckett / natura 的直译),闭式、稳定、无迭代。**TS 和 Rust 各实现一份,结果位级一致。** 这是 web 和 native 弹出来轨迹一致的唯一保证,也是跨端不露馅的前提。

### 6.4 morph(自动,同 id)

- 树重构时,`id` 相同的节点**不被销毁**,而是从旧几何 spring 到新几何。morph = 身份稳定节点的几何弹簧,复用 6.3 的同一套物理,没有第二套动画系统。
- 实现上靠 adapter:adapter 在 mutation stream 里看到"移除 id=A + 新增 id=A",就保留旧 box,把新 box 当弹簧目标。
- 打断:morph 进行中再次变化,从当前可见值继续,不跳变(和 motion.dev 一样)。

### 6.5 stylex 式样式机制

- 样式用对象语法定义,编译成**碰撞自由的原子 class**,last-applied-wins,无 cascade、无 specificity。
- 条件/组合/传 prop 全部编译期展开,运行时只剩查表合并。

---

## 7. 模块二:nagi(凪)0wind

**目标**:让开发者继续用 tailwind 的 class 写法,但编译成 D0M 的原子样式表,而不是生成 CSS。

```
"px-4 py-2 bg-blue-500"  ──nagi──►  D0M 原子表 { .a1 { padding-inline:1rem } .b7 { ... } }
                                         运行时查表,无 CSS 解析、无 cascade
```

- **子集不是写死的**(这是对 PocketJS 的超越):PocketJS 硬编码了一个固定 tailwind 子集;nagi 是**编译器**,拿你的 tailwind 配置/用到的 class 集合,编译成对应的原子表。
- **冲突消解在构建期**(借 shadcn `cn` 的思路):把 tailwind-merge 的冲突规则编译成 table,`cn("px-2 px-4")` 这类合并**在 build 时或查表时直接消解**,运行时零成本。动态拼接的 class 用 safelist 兜底(和 tailwind 本身一样)。
- 产出物同时喂两个 adapter:web 上这些原子就是 CSS class(浏览器原生合成),native 上它们就是 baked style table(直接进 style 表)。

---

## 8. 模块三:adapters 与 host 契约

### 8.1 host 契约(隐藏的第四模块)

这是三个模块之外、但必须**最先冻结**的东西。它定义 framework 和 adapter 之间唯一的语言:

```ts
interface HostContract {
  // 增量树变更(带身份,驱动 morph)
  applyMutations(batch: Mutation[]): void;

  // 样式原子表(只发一次,之后按 id 引用)
  installStyleAtoms(atoms: Record<string, StyleAtom>): void;

  // motion 意图(spring/keyframe 参数 + 目标值),物理推进在 host 内
  setMotion(intent: MotionIntent[]): void;

  // 帧:请求/提交一帧,效果落在帧边界
  frame(input: FrameInput): FrameOutput;
}
```

要点:
- **身份是第一等公民**:每个 mutation 带 `key`,morph 依赖它。
- **样式原子只装一次**:`installStyleAtoms` 幂等,之后 mutation 只引用原子 id(借鉴 gpuix 的 hash-cons 教训:样式在 host 侧去重,别在 wire 里重复塞)。
- **motion 是意图不是值**:framework 发"目标 + 曲线",adapter 自己推进物理,不回来问 JS。

### 8.2 web adapter

- **tree → 真实 DOM**;mutation stream 变成 `appendChild` / `setAttribute` / `textContent`。
- **styles → 原子 CSS class**(就是 nagi 的产出,浏览器原生解析/合成,不引入 CSS-in-JS 运行时)。
- **spring/morph → rAF 驱动 `transform` + `opacity`**。决策 2 说 web 无所谓零 per-frame JS,所以直接 rAF 推,不用 WAAPI 近似。layout 变化靠 FLIP:先量旧 box,再设新 box,再 transform 补差,然后 spring 到 0。
- **text/排版**:直接交给浏览器(决策 3)。web 上不追求和 native 像素级一致。

### 8.3 native adapter

**后端不可知**,不是绑死 Rust 一个生态。抽象成三个可替换的接口:

| 职责 | 接口 | 候选实现 |
|---|---|---|
| **layout** | 计算几何(box tree) | **taffy**(rust,flexbox/grid)· **yoga**(c++,RN 同款)· 自研 |
| **paint** | 把 box + 样式画成像素 | **wgpu**(经 vello/anyrender,2D 矢量)· **skia**(graphite 后端,SkSL→GPU) |
| **text** | 文本整形 + 光栅 | **parley / cosmic-text**(rust)· **skia text** · **swash+skrifa** |

所以"native"是个**组合拳**,不是单一依赖:

```
D0M IR ──► native adapter
              ├─ layout: taffy / yoga
              ├─ spring 物理(共享 spec 的 rust 实现,跑在 host 内)
              ├─ morph:box 身份 + 几何 tween
              ├─ paint: wgpu(vello) / skia
              └─ text: parley / skia text
```

- **参考 Blitz 的分层**(stylo+taffy+parley 各是独立 crate),我们照抄这个模块化,但把 stylo 换成自己的原子表(我们不需要完整 CSS,决策见 §12)。
- **参考 gpuix 的 mutation 协议**:React reconciler → JSON batch → Rust retained tree → 每帧 build → GPU。我们把它从"React 专用"抽象成"D0M 通用",并加上 motion/morph。
- **脚本运行时**:决策 4 已排除在本文讨论范围外(团队自有 JS 运行时,会在 host 侧对接)。
- **spring 的 host 推进**:一帧动画 = 更新矩阵 + draw,**没有 JS 参与**,这是 native 端的性能承诺(PocketJS 在 PSP 上验证过同款模型)。

### 8.4 web 与 native 如何"同一套代码"

两个 adapter 实现同一个 `HostContract`。framework 编译出的 IR 不区分目标;打包时选一个 adapter 进 bundle。差异只在 adapter 内部(浏览器 vs 像素),以及**text 排版不保证像素一致**(决策 3 的取舍)。

---

## 9. 端到端数据流

```
开发者写:
  function Profile(props) {
    const x = createSignal(0);
    return <div id="card" class="px-4 py-2">...</div>;
  }

        │ 模块一 D0M 编译(Ocx 基座)
        ▼
D0M IR:
  tree    { div#card, key=card }
  styles  { .a1: {padding-inline:1rem}, .a2:{padding-block:.5rem} }
  motion  { card.y: spring(ω=6, ζ=0.7) → target }
  script  { x 的 signal 图 }

        │ 模块二 nagi:class 已在编译期变成 .a1 .a2 原子
        ▼
host 契约 wire:  installStyleAtoms({...}) + applyMutations([...]) + setMotion([...])

        │ 模块三 adapter(web 或 native)
        ▼
web:  真实 DOM + 原子 CSS + rAF spring/FLIP morph   → 浏览器 GPU 合成
native: retained scene + taffy/yoga layout + 内部 spring + vello/skia paint → wgpu/skia GPU

用户点击 / 网络回复 ──► 事件回发到 signal 图 ──► 新 mutation + 新 motion 目标 ──► 下一帧应用
```

---

## 10. 已拍板的决策

记录我们已经定死的方向(新增决策请追加到这张表,不要散落在聊天里):

| # | 决策 | 内容 | 影响 |
|---|---|---|---|
| 1 | 动画默认全开 | 所有可动画值自动 spring(果冻感),`no-animation` opt-out(可继承) | appear 不弹、change 才弹;果冻参数是全局 token |
| 2 | web 不追求零 per-frame JS | web adapter 用 rAF 推 spring/transform | 实现简单,不引入 WAAPI 近似 |
| 3 | 排版交给 adapter | framework 不知道几何,只发 motion intent | layout 引擎(taffy/yoga)可换;web/native text 不保证像素一致 |
| 4 | 脚本运行时自备 | 不在本文讨论;host 侧对接自有 JS 运行时 | native adapter 只做 layout/paint/text/motion |
| 5 | 帧时钟 + async 落帧边界 | 确定性是时钟选择不是并发选择;async 数据 FIFO 落在下一帧 | 白拿批处理 + 可选回放;代价是不能随便 setTimeout |

---

## 11. 怎么做(里程碑)

> 顺序不能跳。每一步末尾是完成条件。原则:**先冻结契约,再 web 全链路,再 native。**

- [ ] **M0. host 契约 schema**。定义 `HostContract` 的 wire 格式(tree/identity + style atoms + motion intent + frame),写进一个独立 spec 文件(就是本文 §8.1,但要做成可验证的类型定义 + 一个最小 mock adapter)。完成条件:一个 web 假 adapter 和一个 native 假 adapter 都能消费同一份 sample IR 并各自打印出"我收到的树/样式/动画"。
- [ ] **M1. D0M 编译器最小集**。fork Solid 2.0 的 Oxc 编译器,改输出目标为 D0M IR。先只支持 signal + 静态树 + className→原子(不带 motion)。完成条件:`<div id="x">` 编译成 IR,web adapter 渲染出真实 DOM。
- [ ] **M2. web adapter 全链路**。mutation → DOM、原子样式、事件回发。完成条件:计数器 demo 在浏览器跑,点击更新只改那个 text 节点(devtools 可见)。
- [ ] **M3. nagi 接入**。tailwind 子集 → 原子表 + 构建期冲突消解。完成条件:`cn("px-2 px-4")` 语义在 build 时定死,运行时零冲突计算;demo 换 tailwind class 写法照常渲染。
- [ ] **M4. spring 进 host(先 web)**。spring-as-signal 落地:共享 spec 的弹簧算法(TS 一份),web adapter 用 rAF 推进。完成条件:一个 div 移动/变色是弹簧轨迹,`no-animation` 生效,settle 阈值生效(帧循环能停下来)。
- [ ] **M5. morph**。身份稳定节点的几何弹簧,先 web(FLIP)。完成条件:两个界面切换,同 `id` 元素平滑 morph,打断不跳变。
- [ ] **M6. native adapter(最小)**。layout(taffy 或 yoga)+ paint(wgpu 经 vello,或 skia)+ text(parley)。直接依赖 Blitz 的成熟 crate,**别自己写 layout/text**。完成条件:同一个计数器 demo 跑在 native 窗口,spring 由 host 内部推进(无 per-frame JS)。
- [ ] **M7. 跨端一致性验收**。同一 bundle 在 web 和 native 上,spring 轨迹位级一致(共享 spec 的验证点)。完成条件:golden 帧对比通过。

---

## 12. 风险与未决问题

1. **自动全弹的果冻感会不会过**。这是产品风险不是技术风险。缓解:全局 token 一个开关调手感、`prefers-reduced-motion` 一键关、appear 不弹。**上线前需要一版"克制默认值"**。
2. **text 永远做不到像素级一致**(决策 3 的直接后果)。如果未来要"一个 bundle 处处像素一样",就得自己处处排版(代价极大,像 PocketJS)。**先接受不一致,别现在承诺。**
3. **样式子集边界**。native 端不吃完整 CSS(我们没有 cascade/stylo),tailwind 子集之外的东西怎么降级(报错?忽略?)要定。**倾向:编译期报错,不留静默降级。**
4. **身份(morph)的语义边界**。`id` 在什么范围生效(同一父节点?全局?)未定。全局 morph 是 SwiftUI `matchedGeometryEffect` 的行为,但实现最重。**先做"同父节点内"的 morph,验证后再扩。**
5. **帧时钟的编排成本**。所有长任务要切帧、不能随便 `setTimeout`,团队要适应。这是决策 5 的代价,不是缺陷。
6. **native adapter 的组合爆炸**。taffy/yoga × wgpu/skia × parley/skia-text,别一开始全支持。**M6 先锁定一组(建议 taffy + vello/wgpu + parley),跑通再开第二组。**
