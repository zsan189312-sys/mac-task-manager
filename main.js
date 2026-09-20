// 主进程：窗口 + macOS 本机数据采集
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { exec } = require('child_process');
const path = require('path');

app.setName('任务管理器');

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
let lastIfaces = null;        // { name: {ibytes, obytes} }
let lastProcCpu = null;       // { pid: cpuSeconds }

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
        user = (busySum.u / busySum.t) * 100;
        sys = (busySum.s / busySum.t) * 100;
        idle = 100 - usage;
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
  return out.trim();
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

async function gatherProcs() {
  // 两次采样由外部轮询控制，这里取瞬时（系统级瞬时 CPU 用 time 差分）
  const out = await run('ps -axo pid=,comm=', 8000);
  const timeOut = await run('ps -axo pid=,time=', 8000);
  const names = {};
  out.trim().split('\n').forEach(line => {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);   // ps 输出 PID 右对齐有前导空格，必须 trim
    if (m) names[m[1]] = m[2].trim();
  });
  const cur = {};
  timeOut.trim().split('\n').forEach(line => {
    // ps -o time 格式: "0:15.32" / "12:03.10" / "1:02:03.44" / "3-04:05:06.7"
    const m = line.trim().match(/^\s*(\d+)\s+(?:(\d+)-)?([\d:.]+)$/);
    if (m) {
      const pid = m[1];
      const days = m[2] ? parseInt(m[2], 10) * 86400 : 0;
      const parts = m[3].split(':').map(parseFloat);
      let secs = days;
      if (parts.length === 3) secs += parts[0] * 3600 + parts[1] * 60 + parts[2];
      else if (parts.length === 2) secs += parts[0] * 60 + parts[1];
      cur[pid] = secs;
    }
  });
  const procs = [];
  for (const [pid, secs] of Object.entries(cur)) {
    const full = names[pid] || '(未知)';
    const name = full.includes('/') ? full.slice(full.lastIndexOf('/') + 1) : full;
    let cpu = 0;
    if (lastProcCpu && lastProcCpu[pid] !== undefined) {
      cpu = Math.max(0, (secs - lastProcCpu[pid]) / 2 * 100);
    }
    procs.push({ pid: parseInt(pid, 10), name, cpu });
  }
  lastProcCpu = cur;
  procs.sort((a, b) => b.cpu - a.cpu);
  // 内存另取一轮（快）
  const memOut = await run('ps -axo pid=,rss=', 8000);
  const rssMap = {};
  memOut.trim().split('\n').forEach(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) rssMap[m[1]] = parseInt(m[2], 10) * KB;
  });
  procs.forEach(p => { p.rss = rssMap[String(p.pid)] || 0; });
  return { count: procs.length, list: procs.slice(0, 300) };
}

// ---------- 轮询 ----------
async function poll() {
  if (!win || win.isDestroyed()) return;
  try {
    const [cpu, mem, diskIO, volumes, net, wifi, batt, procs] = await Promise.all([
      gatherCPU(), gatherMem(staticInfo), gatherDiskIO(), gatherVolumes(),
      gatherNet(), gatherWifi(), gatherBattery(), gatherProcs()
    ]);
    win.webContents.send('stats', {
      ts: Date.now(),
      cpu, mem,
      disk: { ...diskIO, volumes },
      net, wifi, batt, procs,
      staticInfo
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
  // 首轮预热采样，之后每 2 秒推送
  setTimeout(poll, 800);
  timer = setInterval(poll, 2000);
});

app.on('window-all-closed', () => { if (timer) clearInterval(timer); app.quit(); });
