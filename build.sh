#!/bin/bash
# 一键构建 /Applications/任务管理器.app
# 前置：node 22+、swiftc、npm 可用
set -e
cd "$(dirname "$0")"

echo "[1/5] 编译 CPU 助手（Mach API 每核采样）..."
mkdir -p bin
swiftc -O cpucores.swift -o bin/cpucores

echo "[2/5] 安装 Electron..."
if [ ! -d node_modules/electron/dist ]; then
  env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE \
    "$(command -v node || echo node)" "$(npm root -g 2>/dev/null)/../npm/bin/npm-cli.js" install electron@37 --no-fund --no-audit 2>/dev/null \
    || npm install electron@37 --no-fund --no-audit
fi

ELECTRON_DIST="$(pwd)/node_modules/electron/dist/Electron.app"
BUILD="/tmp/任务管理器.app"
rm -rf "$BUILD"

echo "[3/5] 组装 APP 壳..."
cp -R "$ELECTRON_DIST" "$BUILD"
mkdir -p "$BUILD/Contents/Resources/app/bin"
cp main.js preload.js index.html renderer.js package.json "$BUILD/Contents/Resources/app/"
cp bin/cpucores "$BUILD/Contents/Resources/app/bin/"
/usr/libexec/PlistBuddy -c "Set :CFBundleName 任务管理器" \
  -c "Set :CFBundleDisplayName 任务管理器" \
  -c "Set :CFBundleIdentifier com.local.mactaskmanager" \
  "$BUILD/Contents/Info.plist"

echo "[4/5] Ad-hoc 签名 + 清除隔离属性..."
codesign --force --deep -s - "$BUILD"
xattr -cr "$BUILD"

echo "[5/5] 安装到 /Applications..."
pkill -f "任务管理器.app/Contents/MacOS" 2>/dev/null || true
sleep 1
rm -rf "/Applications/任务管理器.app"
mv "$BUILD" /Applications/任务管理器.app
open "/Applications/任务管理器.app"
echo "✅ 已安装并启动"
