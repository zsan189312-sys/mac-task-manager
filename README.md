# Mac 任务管理器（mac-task-manager）

为 Apple Silicon Mac 打造的 Electron 任务管理器，模仿 Windows 11 任务管理器的布局逻辑，采用 macOS 原生视觉（毛玻璃 vibrancy / SF Pro / hairline）。

## 特性

- **性能核心 / 能效核心分离**：自动识别 P/E 核心数量（如 M4 = 4P + 6E），双面板独立曲线 + 每核实时小图块
- **每核实时监测**：内置 Swift 助手直读 Mach `host_processor_info`，逐核 tick 差分计算占用率（macOS 27 已移除 `kern.cp_time/cp_times`，此为最可靠方案），无需 sudo
- **内存**：统一内存占用、App/Wired/压缩/非活跃构成、Swap、压缩器压力
- **磁盘**：`iostat` 内核级 1 秒窗口吞吐 + IOPS + APFS 全部卷容量
- **网络**：Wi-Fi SSID、收发双曲线、开机累计流量、全部 en 接口
- **电池**：电量曲线、充放电状态、剩余时间
- **进程**：300 进程、真实 2 秒窗口 CPU 差分、搜索、PID 排序、一键强制退出（带确认）
- 快捷键：`⌘1` 性能 / `⌘2` 进程 / `Esc` 清空搜索

## 构建

依赖：macOS + Xcode Command Line Tools（swiftc）+ Node.js 22+

```bash
./build.sh   # 编译助手 → npm 安装 Electron → 打包 → ad-hoc 签名 → 安装到 /Applications 并启动
```

## 手动开发运行

```bash
npm install electron@37
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
```

> 注：从终端启动需加 `--no-sandbox`（受宿主沙箱环境影响时）；从 Finder/启动台正常打开无需任何参数。

## 结构

```
main.js        # Electron 主进程：窗口 + 全部系统数据采集（2 秒轮询）
preload.js     # contextBridge 安全桥
index.html     # 布局与 macOS 风格设计系统
renderer.js    # 渲染进程：侧栏卡片 / P+E 核面板 / 图表 / 进程表
cpucores.swift # 每核 CPU tick 采样助手（编译为 bin/cpucores）
build.sh       # 一键构建打包脚本
```

## 许可

MIT
