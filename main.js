// 主进程：窗口 + macOS 本机数据采集
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const { exec } = require('child_process');
const path = require('path');

app.setName('任务管理器');
// 界面为深色设计：锁定深色外观，避免系统浅色模式下毛玻璃变白导致文字不可读
nativeTheme.themeSource = 'dark';

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1140,
    height: 740,
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 19 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile('index.html');
  // 支持 --view=<页签> 启动参数，或 /tmp/tm_view 文件指定初始页签，或 /tmp/tm_force_procs 强制进程页
  const argView = (process.argv.find(a => a.startsWith('--view=')) || '').slice(7);
  let fileView = '';
  try { fileView = require('fs').readFileSync('/tmp/tm_view', 'utf8').trim(); } catch { }
  const forceProcs = (() => { try { return require('fs').existsSync('/tmp/tm_force_procs'); } catch { return false; } })();
  const initView = ['cpu', 'gpu', 'mem', 'disk', 'net', 'batt', 'procs'].includes(fileView) ? fileView
    : (forceProcs ? 'procs' : argView);
  if (initView) {
    win.webContents.on('did-finish-load', () => {
      const js = initView === 'procs'
        ? "try{switchView('procs')}catch(e){}"
        : `try{selectCard('${initView}')}catch(e){}`;
      win.webContents.executeJavaScript(js).catch(() => {});
    });
  }
  // win.webContents.openDevTools({ mode: 'detach' });
}

// ---------- 工具 ----------
function run(cmd, timeout = 8000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}
const KB = 1024, MB = KB * 1024, GB = MB * 1024;

// 静态信息（一次性）
async function getStatic() {
  const [brand, cores, memsize, ver, boot, perf, eff] = await Promise.all([
    run('sysctl -n machdep.cpu.brand_string'),
    run('sysctl -n hw.ncpu'),
    run('sysctl -n hw.memsize'),
    run('sw_vers -productVersion'),
    run('sysctl -n kern.boottime'),
    run('sysctl -n hw.perflevel0.physicalcpu 2>/dev/null'),
    run('sysctl -n hw.perflevel1.physicalcpu 2>/dev/null')
  ]);
  let bootSec = 0;
  const m = boot.match(/sec\s*=\s*(\d+)/);
  if (m) bootSec = parseInt(m[1], 10);
  const perfCount = parseInt(perf, 10) || 0; // 性能核（P-core）
  const effCount = parseInt(eff, 10) || 0;   // 能效核（E-core）
  const ncpu = parseInt(cores, 10) || (perfCount + effCount);
  // Apple Silicon: kern.cp_times 中性能核在前、能效核在后
  const coreTypes = [];
  for (let i = 0; i < ncpu; i++) {
    coreTypes.push(perfCount > 0 && i < perfCount ? 'P' : 'E');
  }
  return {
    chip: brand.trim() || 'Apple Silicon',
    cores: ncpu,
    perfCount, effCount, coreTypes,
    memTotal: parseInt(memsize, 10) || 16 * GB,
    osVersion: ver.trim(),
    bootSec,
    hostname: require('os').hostname()
  };
}

// ---------- 采集器 ----------
const CPU_HELPER = path.join(__dirname, 'bin', 'cpucores');
let lastCoreTicks = null;     // 每核 [user, system, idle, nice]
let lastHostFrac = null;      // 机器级 CPU 占比 { user, sys }（0-1，含 nice 于 user），供进程页聚合估算
let lastIfaces = null;        // { name: {ibytes, obytes} }

async function gatherCPU() {
  // 优先走 Mach API（Swift 助手，macOS 27 移除了 kern.cp_time/cp_times）
  const out = await run('"' + CPU_HELPER + '"', 5000);
  let coreLoads = [], pUsage = null, eUsage = null;
  let usage = 0, user = 0, sys = 0, idle = 100;
  const lines = out.trim().split('\n');
  if (lines.length >= 2 && !out.startsWith('ERR')) {
    const ticks = [];
    for (let i = 1; i < lines.length; i++) {
      const nums = lines[i].trim().split(/\s+/).map(Number);
      if (nums.length === 4 && nums.every(n => !isNaN(n))) ticks.push(nums);
    }
    if (lastCoreTicks && lastCoreTicks.length === ticks.length) {
      const busySum = { b: 0, u: 0, s: 0, t: 0 };
      coreLoads = ticks.map((t, i) => {
        const p = lastCoreTicks[i];
        const du = t[0] - p[0], ds = t[1] - p[1], dn = t[3] - p[3], di = t[2] - p[2];
        const busy = du + ds + dn, total = busy + di;
        const pct = total > 0 ? (busy / total) * 100 : 0;
        busySum.b += busy; busySum.u += du; busySum.s += ds; busySum.t += total;
        return pct;
      });
      if (busySum.t > 0) {
        usage = (busySum.b / busySum.t) * 100;
        // 用户占比并入 nice（后台 QoS/nice 线程），与活动监视器"用户"口径一致
        user = ((busySum.u + (busySum.b - busySum.u - busySum.s)) / busySum.t) * 100;
        sys = (busySum.s / busySum.t) * 100;
        idle = 100 - usage;
        // 记录机器级占比（0-1），供进程页做 kernel/受保护系统进程聚合估算
        lastHostFrac = { user: usage / 100 - (busySum.s / busySum.t), sys: busySum.s / busySum.t };
      }
      const types = staticInfo ? staticInfo.coreTypes : null;
      if (types && types.length === coreLoads.length) {
        const ps = [], es = [];
        coreLoads.forEach((v, i) => (types[i] === 'P' ? ps : es).push(v));
        if (ps.length) pUsage = ps.reduce((a, b) => a + b, 0) / ps.length;
        if (es.length) eUsage = es.reduce((a, b) => a + b, 0) / es.length;
      }
    }
    lastCoreTicks = ticks;
  } else {
    // 兜底：iostat 的 cpu us/sy/id 列（最后一行 = 1 秒窗口）
    const io = await run('iostat -c 2 disk0 2>/dev/null', 5000);
    const rows = io.trim().split('\n');
    if (rows.length >= 3) {
      const cols = rows[rows.length - 1].trim().split(/\s+/);
      if (cols.length >= 7) {
        const us = parseFloat(cols[cols.length - 4]) || 0;
        const sy = parseFloat(cols[cols.length - 3]) || 0;
        usage = us + sy; user = us; sys = sy; idle = 100 - usage;
      }
    }
  }
  const loadRaw = await run('sysctl -n vm.loadavg');
  const load = (loadRaw.match(/\{?\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/) || []).slice(1).map(Number);
  return { usage, user, sys, idle, coreLoads, pUsage, eUsage, loadAvg: load };
}

async function gatherMem(staticInfo) {
  const [vmStat, swap] = await Promise.all([
    run('vm_stat'),
    run('sysctl -n vm.swapusage')
  ]);
  const page = 16384; // Apple Silicon arm64
  const get = (name) => {
    const m = vmStat.match(new RegExp(name + ':\\s+(\\d+)'));
    return m ? parseInt(m[1], 10) * page : 0;
  };
  const free = get('Pages free');
  const active = get('Pages active');
  const inactive = get('Pages inactive');
  const wired = get('Pages wired down');
  const compressed = get('Pages occupied by compressor');
  const purgeable = get('Pages purgeable');
  const speculative = get('Pages speculative');
  const total = staticInfo.memTotal;
  const used = Math.min(total, active + wired + compressed + Math.max(0, (inactive - purgeable)));
  const avail = Math.max(0, total - used);
  const sm = swap.match(/total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M/);
  return {
    total, used, avail,
    active, wired, compressed, inactive, free, purgeable, speculative,
    swapTotal: sm ? parseFloat(sm[1]) * MB : 0,
    swapUsed: sm ? parseFloat(sm[2]) * MB : 0,
    pressure: total > 0 ? (compressed / total) * 100 : 0
  };
}

async function gatherDiskIO() {
  // 两秒两采样，取第二行（真实 1 秒窗口）
  const out = await run('iostat -c 2 -d disk0', 5000);
  const rows = out.trim().split('\n');
  let tps = 0, mbps = 0;
  if (rows.length >= 3) {
    const cols = rows[rows.length - 1].trim().split(/\s+/);
    if (cols.length >= 4) {
      tps = parseFloat(cols[cols.length - 2]) || 0;
      mbps = parseFloat(cols[cols.length - 1]) || 0;
    }
  }
  return { tps, mbps }; // MB/s 读写合计
}

async function gatherVolumes() {
  const out = await run('df -k / /System/Volumes/VM /System/Volumes/Preboot /System/Volumes/Data 2>/dev/null');
  const seen = new Set();
  const volumes = [];
  out.trim().split('\n').slice(1).forEach(line => {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) return;
    const mount = cols.slice(8).join(' ');
    if (seen.has(mount)) return;
    seen.add(mount);
    const total = parseInt(cols[1], 10) * KB;
    const used = parseInt(cols[2], 10) * KB;
    const avail = parseInt(cols[3], 10) * KB;
    if (total <= 0) return;
    const name = mount === '/' ? 'Macintosh HD' : mount.replace('/System/Volumes/', '').replace('/Volumes/', '');
    volumes.push({ name, mount, total, used, avail });
  });
  return volumes;
}

async function gatherNet() {
  const out = await run('netstat -ib');
  const now = {};
  out.trim().split('\n').slice(1).forEach(line => {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) return;
    const name = cols[0];
    if (!/^en\d+$/.test(name)) return;
    // Name Mtu Network Address Ibytes Obytes ...
    const ibytes = parseInt(cols[6], 10) || 0;
    const obytes = parseInt(cols[7], 10) || 0;
    if (!now[name]) now[name] = { ibytes: 0, obytes: 0 };
    now[name].ibytes += ibytes;
    now[name].obytes += obytes;
  });
  const ifaces = [];
  for (const [name, cur] of Object.entries(now)) {
    let rxRate = 0, txRate = 0;
    if (lastIfaces && lastIfaces[name]) {
      rxRate = Math.max(0, cur.ibytes - lastIfaces[name].ibytes) / 2;
      txRate = Math.max(0, cur.obytes - lastIfaces[name].obytes) / 2;
    }
    ifaces.push({ name, ibytes: cur.ibytes, obytes: cur.obytes, rxRate, txRate });
  }
  lastIfaces = now;
  ifaces.sort((a, b) => (b.rxRate + b.txRate) - (a.rxRate + a.txRate));
  return { ifaces };
}

async function gatherWifi() {
  const out = await run("ipconfig getsummary en0 2>/dev/null | awk -F ' : ' '/ SSID/{print $2; exit}'");
  const ssid = out.trim();
  // macOS 隐私接口可能返回 <redacted>，此时不显示 SSID
  if (!ssid || /redacted/i.test(ssid)) return '';
  return ssid;
}

async function gatherBattery() {
  const out = await run('pmset -g batt');
  const pct = (out.match(/(\d+)%/) || [])[1];
  const charging = /AC Power/.test(out);
  const time = (out.match(/(\d+:\d+)\s+remaining/) || [])[1] || '';
  return {
    percent: pct ? parseInt(pct, 10) : null,
    charging,
    timeRemaining: time,
    present: !!pct
  };
}

async function gatherGPU() {
  // IOAccelerator 注册表：GPU 利用率 / 显存（用户态可读，无需 sudo）
  const out = await run('ioreg -r -d 1 -w 0 -c IOAccelerator 2>/dev/null | grep -E "Device Utilization|Renderer Utilization|Tiler Utilization|In use system memory\\\"" ', 5000);
  const get = (k) => {
    const m = out.match(new RegExp('"' + k + '"\\s*=\\s*([\\d.]+)'));
    return m ? parseFloat(m[1]) : null;
  };
  return {
    util: get('Device Utilization %'),
    renderer: get('Renderer Utilization %'),
    tiler: get('Tiler Utilization %'),
    memBytes: get('In use system memory') // 字节
  };
}

const PROCINFO = path.join(__dirname, 'bin', 'procinfo');
let lastProcRaw = null;       // { pid: {ticks,dR,dW,wk} }
let lastProcsTime = 0;        // 上次进程采集时间戳(ms)
let lastProcCpu = null;       // ps 兜底方案用 { pid: cpuSeconds }
let liveNet = {};             // nettop 常驻流的每进程累计字节 { pid: {rx,tx} }
let netStreamChild = null;

// nettop 常驻流：每秒输出一次每进程累计字节，开销为零（避免每次轮询 spawn 5 秒采样）
function startNetStream() {
  try {
    netStreamChild = exec('nettop -P -x -l 0', { maxBuffer: 128 * 1024 * 1024 }, () => {});
    let buf = '';
    netStreamChild.stdout.setEncoding('utf8');
    netStreamChild.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const t = line.trim().split(/\s+/);
        if (t.length < 4 || !t[1] || !t[1].includes('.')) continue;
        const pid = t[1].slice(t[1].lastIndexOf('.') + 1);
        if (!/^\d+$/.test(pid)) continue;
        if (!liveNet[pid]) liveNet[pid] = { rx: 0, tx: 0 };
        liveNet[pid].rx = parseInt(t[2], 10) || 0;
        liveNet[pid].tx = parseInt(t[3], 10) || 0;
      }
    });
    netStreamChild.on('exit', () => { setTimeout(startNetStream, 5000); }); // 断流自动重启
  } catch (e) { /* 忽略，网速列显示 — */ }
}

async function gatherProcs() {
  const now = Date.now();
  const elapsed = lastProcsTime > 0 ? (now - lastProcsTime) / 1000 : 0;
  const iv = elapsed > 0.5 ? elapsed : 2;

  // 1) procinfo 助手：KERN_PROC_ALL 全量枚举（含 root 系统进程）
  //    行格式：pid \t cpticks \t diskR \t diskW \t wakeups \t rss \t path
  const out = await run('"' + PROCINFO + '"', 8000);
  const cur = {};
  const lines = out.trim().split('\n').filter(Boolean);
  lines.forEach(line => {
    const p = line.split('\t');
    if (p.length < 8) return;
    // taskinfo 与 rusage 两种口径取较大值（macOS 27 对 darwinbg/nice 线程均有漏计）
    cur[p[0]] = { cpuNs: Math.max(+p[1] || 0, +p[2] || 0), dR: +p[3], dW: +p[4], wk: +p[5], rss: +p[6], path: p[7] || '' };
  });

  // 兜底：procinfo 被阻断时回退旧 ps 方案
  if (lines.length < 30) {
    return await gatherProcsPsFallback(iv, now);
  }

  // 2) ps 补充源：macOS 27 的 taskinfo/rusage 不计 darwinbg/nice 线程的 CPU 时间，
  //    ps 的 pcpu（衰减均值）能看到，例如挖矿类进程。两者取较大值。
  let psCpu = {};
  try {
    const psOut = await run('ps -axo pid=,pcpu=', 5000);
    psOut.trim().split('\n').forEach(line => {
      const m = line.trim().match(/^(\d+)\s+([\d.]+)$/);
      if (m) psCpu[m[1]] = parseFloat(m[2]);
    });
  } catch (e) { }

  // 3) 差分合成进程列表（网速来自常驻 nettop 流的累计字节差分）
  const ncpu = (staticInfo && staticInfo.cores) || 10;
  const procs = [];
  let attrFrac = 0; // 可读进程的 CPU 占机器比例合计
  for (const [pid, c] of Object.entries(cur)) {
    const prev = lastProcRaw ? lastProcRaw[pid] : null;
    const nPrev = liveNet[pid];
    let cpu = 0, diskRead = 0, diskWrite = 0, energy = 0, rx = 0, tx = 0;
    if (prev) {
      // CPU 时间为纳秒累计：Δns / Δt(ns) × 100 = 占用单核百分比（与 top 口径一致）
      cpu = Math.max(0, (c.cpuNs - prev.cpuNs) / 1e9 / iv * 100);
      diskRead = Math.max(0, (c.dR - prev.dR) / iv);
      diskWrite = Math.max(0, (c.dW - prev.dW) / iv);
    }
    const psVal = psCpu[pid] || 0;
    if (psVal > cpu) { cpu = psVal; }
    // 换算为"占整机容量百分比"（单核口径 ÷ 核数），最大 100
    cpu = Math.min(100, cpu / ncpu);
    // 能耗瓦数估算：整机份额 × 20W（M4 全核满载 CPU 功耗约 20W）+ 唤醒率开销
    const wkRate = prev ? Math.max(0, (c.wk - prev.wk) / iv) : 0;
    energy = (cpu / 100) * 20 + wkRate * 0.05;
    attrFrac += cpu / 100;
    if (nPrev) {
      rx = Math.max(0, (nPrev.rx - (prev ? (prev.rx0 || 0) : 0)) / iv);
      tx = Math.max(0, (nPrev.tx - (prev ? (prev.tx0 || 0) : 0)) / iv);
    }
    const full = c.path || '';
    const name = full.includes('/') ? full.slice(full.lastIndexOf('/') + 1) : (full || '(未知)');
    procs.push({ pid: parseInt(pid, 10), name, cpu, rss: c.rss, diskRead, diskWrite, rx, tx, energy });
  }

  // 3) 聚合估算行：macOS 27 收紧了跨用户读取（WindowServer 等 root 进程 taskinfo 被拒），
  //    且 darwinbg/nice 线程的 CPU 时间不计入 taskinfo/rusage。用 host ticks 补齐缺口，
  //    使进程页 CPU 合计 ≈ 性能页总利用率。
  const realCount = procs.length;
  if (lastHostFrac && lastProcRaw) {
    const kernelPct = Math.max(0, lastHostFrac.sys) * 100;               // 占整机 %
    const protPct = Math.max(0, lastHostFrac.user - attrFrac) * 100;     // 占整机 %
    procs.push({ pid: 0, name: 'kernel_task（内核）', cpu: kernelPct, rss: 0, diskRead: 0, diskWrite: 0, rx: 0, tx: 0, energy: kernelPct / 100 * 20, pseudo: true });
    procs.push({ pid: -1, name: '系统进程（受保护·聚合估算）', cpu: protPct, rss: 0, diskRead: 0, diskWrite: 0, rx: 0, tx: 0, energy: protPct / 100 * 20, pseudo: true });
  }
  procs.sort((a, b) => b.cpu - a.cpu);

  // 记录本轮 net 快照，供下轮差分
  const rawWithNet = {};
  for (const [pid, c] of Object.entries(cur)) {
    rawWithNet[pid] = { ...c, rx0: liveNet[pid] ? liveNet[pid].rx : 0, tx0: liveNet[pid] ? liveNet[pid].tx : 0 };
  }
  lastProcRaw = rawWithNet;
  lastProcsTime = now;
  return { count: realCount, list: procs.slice(0, 300) };
}

// 旧方案兜底（procinfo 被系统策略阻断时）
async function gatherProcsPsFallback(iv, now) {
  const out = await run('ps -axo pid=,comm=', 8000);
  const timeOut = await run('ps -axo pid=,time=', 8000);
  const names = {};
  out.trim().split('\n').forEach(line => {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m) names[m[1]] = m[2].trim();
  });
  const cur = {};
  timeOut.trim().split('\n').forEach(line => {
    const m = line.trim().match(/^\s*(\d+)\s+(?:(\d+)-)?([\d:.]+)$/);
    if (m) {
      const days = m[2] ? parseInt(m[2], 10) * 86400 : 0;
      const parts = m[3].split(':').map(parseFloat);
      let secs = days;
      if (parts.length === 3) secs += parts[0] * 3600 + parts[1] * 60 + parts[2];
      else if (parts.length === 2) secs += parts[0] * 60 + parts[1];
      cur[m[1]] = secs;
    }
  });
  const memOut = await run('ps -axo pid=,rss=', 8000);
  const rssMap = {};
  memOut.trim().split('\n').forEach(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) rssMap[m[1]] = parseInt(m[2], 10) * KB;
  });
  const procs = [];
  for (const [pid, secs] of Object.entries(cur)) {
    const full = names[pid] || '(未知)';
    const name = full.includes('/') ? full.slice(full.lastIndexOf('/') + 1) : full;
    let cpu = 0;
    if (lastProcCpu && lastProcCpu[pid] !== undefined) {
      cpu = Math.max(0, (secs - lastProcCpu[pid]) / iv * 100);
    }
    procs.push({ pid: parseInt(pid, 10), name, cpu, rss: rssMap[pid] || 0, diskRead: 0, diskWrite: 0, rx: 0, tx: 0, energy: cpu });
  }
  procs.sort((a, b) => b.cpu - a.cpu);
  lastProcCpu = cur;
  lastProcsTime = now;
  return { count: procs.length, list: procs.slice(0, 300) };
}

// ---------- 轮询（分层：快车道 2s / 慢车道 6s / 低频 30s） ----------
let tick = 0;
let lastVolumes = [];
let lastWifi = '';
let lastBatt = { present: false };
let lastProcs = { count: 0, list: [] };

async function poll() {
  if (!win || win.isDestroyed()) return;
  try {
    tick++;
    // 快车道：每 2 秒
    const [cpu, mem, diskIO, net, gpu] = await Promise.all([
      gatherCPU(), gatherMem(staticInfo), gatherDiskIO(), gatherNet(), gatherGPU()
    ]);
    // 低频：每 30 秒（变化很慢的指标）
    if (tick === 1 || tick % 15 === 0) {
      [lastBatt, lastWifi] = await Promise.all([gatherBattery(), gatherWifi()]);
    }
    // 慢车道：每 6 秒
    if (tick === 1 || tick % 3 === 2) lastVolumes = await gatherVolumes();
    if (tick === 2 || tick % 3 === 0) lastProcs = await gatherProcs();

    win.webContents.send('stats', {
      ts: Date.now(),
      cpu, mem,
      disk: { ...diskIO, volumes: lastVolumes },
      net, wifi: lastWifi, batt: lastBatt, procs: lastProcs,
      gpu, staticInfo
    });
  } catch (e) {
    console.error('poll error', e);
  }
}

let staticInfo = null;
let timer = null;

app.whenReady().then(async () => {
  staticInfo = await getStatic();
  createWindow();
  ipcMain.handle('kill-process', async (e, pid) => {
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['强制退出', '取消'],
      defaultId: 0,
      cancelId: 1,
      message: `确定要强制退出进程 ${pid} 吗？`,
      detail: '未保存的数据可能会丢失。'
    });
    if (r.response !== 0) return '已取消';
    return new Promise((resolve) => {
      exec(`kill -9 ${pid}`, (err) => resolve(err ? '失败：' + err.message : `已退出进程 ${pid}`));
    });
  });
  // GPU 静态信息（system_profiler 较慢，仅启动时取一次，不阻塞窗口）
  run('system_profiler SPDisplaysDataType 2>/dev/null', 15000).then(out => {
    const cores = (out.match(/Total Number of Cores:\s*(\d+)/) || [])[1];
    const metal = (out.match(/Metal Support:\s*(.+)/) || [])[1];
    staticInfo.gpu = {
      cores: cores ? parseInt(cores, 10) : null,
      metal: metal ? metal.trim() : null
    };
  });
  // 首轮预热采样，之后每 2 秒推送
  startNetStream(); // 常驻 nettop 流：每进程网络累计字节
  setTimeout(poll, 800);
  timer = setInterval(poll, 2000);
});

app.on('window-all-closed', () => { if (timer) clearInterval(timer); app.quit(); });
