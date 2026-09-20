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

echo "[3/6] 生成应用图标（Swift 程序化绘制 → icns）..."
swiftc -O icon.swift -o /tmp/icongen
/tmp/icongen /tmp/icon_1024.png
rm -rf /tmp/AppIcon.iconset /tmp/AppIcon.icns
mkdir -p /tmp/AppIcon.iconset
for size in 16 32 64 128 256 512 1024; do
  sips -z $size $size /tmp/icon_1024.png --out "/tmp/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
done
# 补齐 @2x 命名
cp /tmp/AppIcon.iconset/icon_32x32.png /tmp/AppIcon.iconset/icon_16x16@2x.png
cp /tmp/AppIcon.iconset/icon_64x64.png /tmp/AppIcon.iconset/icon_32x32@2x.png 2>/dev/null || sips -z 64 64 /tmp/icon_1024.png --out /tmp/AppIcon.iconset/icon_32x32@2x.png >/dev/null
cp /tmp/AppIcon.iconset/icon_256x256.png /tmp/AppIcon.iconset/icon_128x128@2x.png
cp /tmp/AppIcon.iconset/icon_512x512.png /tmp/AppIcon.iconset/icon_256x256@2x.png
cp /tmp/AppIcon.iconset/icon_1024x1024.png /tmp/AppIcon.iconset/icon_512x512@2x.png
iconutil -c icns /tmp/AppIcon.iconset -o /tmp/AppIcon.icns

echo "[4/6] 组装 APP 壳..."
cp -R "$ELECTRON_DIST" "$BUILD"
mkdir -p "$BUILD/Contents/Resources/app/bin"
cp main.js preload.js index.html renderer.js package.json "$BUILD/Contents/Resources/app/"
cp bin/cpucores "$BUILD/Contents/Resources/app/bin/"
cp /tmp/AppIcon.icns "$BUILD/Contents/Resources/AppIcon.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleName 任务管理器" \
  -c "Set :CFBundleDisplayName 任务管理器" \
  -c "Set :CFBundleIdentifier com.local.mactaskmanager" \
  -c "Set :CFBundleIconFile AppIcon" \
  "$BUILD/Contents/Info.plist"

echo "[5/6] Ad-hoc 签名 + 清除隔离属性..."
codesign --force --deep -s - "$BUILD"
xattr -cr "$BUILD"

echo "[6/6] 安装到 /Applications..."
pkill -f "任务管理器.app/Contents/MacOS" 2>/dev/null || true
sleep 1
rm -rf "/Applications/任务管理器.app"
mv "$BUILD" /Applications/任务管理器.app
open "/Applications/任务管理器.app"
echo "✅ 已安装并启动"
