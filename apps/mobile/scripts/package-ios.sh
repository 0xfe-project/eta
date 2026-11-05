#!/bin/sh
# Package Eta for iOS. `nsh.json` has no key for Info.plist, and the app needs two entries there: why
# it wants the camera (scanning the desktop's code) and leave to speak plain http to a host on a
# tailnet or LAN, where the WireGuard or the network is the encryption. So: package, add them, sign.
#
#   scripts/package-ios.sh simulator
#   scripts/package-ios.sh device "Apple Development: …" Dev.mobileprovision
set -eu

cd "$(dirname "$0")/.."
mode="${1:-simulator}"
# bindgen does not find the SDK's headers by itself when it builds the runner for iOS.
sdk="$([ "$mode" = simulator ] && echo iphonesimulator || echo iphoneos)"
export BINDGEN_EXTRA_CLANG_ARGS="-isysroot $(xcrun --sdk "$sdk" --show-sdk-path)"

add_keys() {
  plist="$1/Info.plist"
  /usr/libexec/PlistBuddy \
    -c "Delete :NSCameraUsageDescription" "$plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy \
    -c "Delete :NSAppTransportSecurity" "$plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy \
    -c "Add :NSCameraUsageDescription string 扫描电脑上的二维码来连接主机。" \
    -c "Add :NSAppTransportSecurity dict" \
    -c "Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool true" \
    "$plist"
}

case "$mode" in
  simulator)
    nsh package App.tsx --target ios-simulator
    add_keys .nsh/out/Eta.app
    codesign --force --sign - .nsh/out/Eta.app
    xcrun simctl install booted .nsh/out/Eta.app
    xcrun simctl launch booted dev.eta.mobile
    ;;
  device)
    identity="$2"
    profile="$3"
    nsh package App.tsx --target ios
    app=.nsh/out/Eta.app
    add_keys "$app"
    cp "$profile" "$app/embedded.mobileprovision"
    entitlements="$(mktemp)"
    security cms -D -i "$profile" >"$entitlements.plist"
    /usr/libexec/PlistBuddy -x -c "Print :Entitlements" "$entitlements.plist" >"$entitlements"
    codesign --force --sign "$identity" --entitlements "$entitlements" "$app"
    rm -rf .nsh/out/Payload
    mkdir .nsh/out/Payload
    cp -R "$app" .nsh/out/Payload/
    (cd .nsh/out && zip -qr Eta.ipa Payload && rm -rf Payload)
    echo ".nsh/out/Eta.ipa"
    ;;
  *)
    echo "usage: $0 simulator | device <identity> <profile>" >&2
    exit 2
    ;;
esac
