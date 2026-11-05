# 手机端

`apps/mobile` 是 Native Shell（nsh）写的原生客户端：TSX 跑在 QuickJS 上，界面是 UIKit 和 Android 的原生视图。设计稿在 Paper 文件「Eta mobile」，产品判断写在总览页：电脑上干活，手机上拍板。

## 连接

手机只是一块屏：连一次主机，就能用它后面的所有机器。它和 Web 一样只走 `/ws` 一条线，帧、订阅和重连的规则见[线协议](wire-protocol.md)，`src/wire/wire.ts` 是 Web 同名文件换成 signal 的版本。

- 令牌走 `X-Eta-Token` 握手头（[访问控制](access.md)）：nsh 的 WebSocket 不让握手带 `Authorization`。`--host` 不是回环时令牌门自动打开。
- 扫码：Web 的 设置 → 机器 → 连接手机 用 `machines.phoneLink` 生成 `eta://connect?address=…&token=…`，手机扫到后直接连。粘贴这个链接到地址栏同样可以。
- `hello` 只带一次 eager target 的快照，手机建好连接就订阅它们，否则之后的推送收不到。

## 原生模块

`apps/mobile/native` 是一个 Rust crate（`eta/native`），放 TSX 碰不到的东西：相机扫码（`Scanner`）和系统分享面板（`Sharing`，私有产物下载用，iOS 上文件也只有 Rust 能写）。

它依赖 GitHub 上 `longbridge/nsh` 的 `v0.4.0`，不是 crates.io：crates.io 上的 `nsh-platform-ios 0.4.0` 用 `#[path]` 引用了包外的文件，编不过。

## 打包

`nsh.json` 没有写 Info.plist 的键，而手机端需要两项：相机用途说明，以及用明文 http 连 tailnet 或局域网上的主机。`apps/mobile/scripts/package-ios.sh` 打完包后写入它们再重新签名，模拟器和真机都走它。

## 测试

`src/testing/fake-host.ts` 是跑在 app 自己 VM 里的假 host，帧和真的一样，`DevApp.tsx` 用它在模拟器和 `nsh test` 里运行。

```sh
nsh check                            # 类型检查（含 Rust crate）
nsh test                             # 无头测试
nsh test <file> --target ios         # 在模拟器里驱动真实界面，app.screenshot 能截图
```

iOS 目标要先设 `BINDGEN_EXTRA_CLANG_ARGS="-isysroot $(xcrun --sdk iphonesimulator --show-sdk-path)"`。这几个命令不在 `bun run check` 里：CI 没有 nsh。
