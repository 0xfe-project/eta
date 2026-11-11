# Mobile

`apps/mobile` is a native client written with Native Shell (nsh): TSX runs on QuickJS, and the UI uses native UIKit and Android views. The design file is the Paper file 「Eta mobile」, and the product judgment is written on the overview page: do the work on the computer, make the decisions on the phone.

## Connection

The phone is just a screen: connect once to a host machine, and you can use all the machines behind it. Like the Web, it uses only a single `/ws` connection; for the rules on frames, subscriptions, and reconnection, see [wire protocol](wire-protocol.md). `src/wire/wire.ts` is the version of the Web file with the same name switched to signals.

- The token goes in the `X-Eta-Token` handshake header ([access control](access.md)): nsh's WebSocket does not allow the handshake to carry `Authorization`. When `--host` is not loopback, the token gate opens automatically.
- Scan code: in Web, Settings → Machines → Connect phone uses `machines.phoneLink` to generate `eta://connect?address=…&token=…`; the phone connects directly after scanning it. Pasting this link into the address bar also works.
- `hello` carries a snapshot of eager targets only once; the phone subscribes to them as soon as the connection is established, otherwise it will not receive later pushes.

## Native modules

`apps/mobile/native` is a Rust crate (`eta/native`) for things TSX cannot touch: camera scanning (`Scanner`) and the system share sheet (`Sharing`, used for downloading private artifacts; on iOS, only Rust can write files).

It depends on `longbridge/nsh` `v0.4.0` on GitHub, not crates.io: `nsh-platform-ios 0.4.0` on crates.io references files outside the package with `#[path]`, so it does not compile.

## Packaging

`nsh.json` does not write the Info.plist keys, but the mobile app needs two: the camera usage description, and permission to use plaintext http to connect to hosts on the tailnet or LAN. `apps/mobile/scripts/package-ios.sh` writes them after packaging and then re-signs; both the simulator and real devices go through it.

## Testing

`src/testing/fake-host.ts` is a fake host running in the app's own VM, with frames identical to the real ones; `DevApp.tsx` uses it to run in the simulator and under `nsh test`.

```sh
nsh check                            # Type check (including Rust crate)
nsh test                             # Headless tests
nsh test <file> --target ios         # Drive the real UI in the simulator; app.screenshot can take screenshots
```

The iOS target requires setting `BINDGEN_EXTRA_CLANG_ARGS="-isysroot $(xcrun --sdk iphonesimulator --show-sdk-path)"` first. These commands are not part of `bun run check`: CI does not have nsh.
