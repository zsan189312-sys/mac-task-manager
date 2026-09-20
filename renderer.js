// 渲染进程：UI + 图表（Windows 式 P/E 核心分离 · macOS 视觉）
const HIST = 60;
const hist = {
  cpu: [], cpuP: [], cpuE: [], mem: [], disk: [],
  netrx: [], nettx: [], batt: [], cores: []
};

const cards = [
  { id: 'cpu',  title: 'CPU',  color: '#0a84ff' },
  { id: 'mem',  title: '内存', color: '#bf5af2' },
  { id: 'disk', title: '磁盘', color: '#30d158' },
  { id: 'net',  title: 'Wi-Fi', color: '#ffd60a' },
  { id: 'batt', title: '电池', color: '#30d158' }
];
let activeCard = 'cpu';
let latest = null;
let procSort = 'cpu';
let procQuery = '';

// ---------- 工具 ----------
function fmtSize(b) {
  if (b === null || b === undefined || isNaN(b)) return '—';
  if (b >= 100 * 1024 ** 3) return (b / 1024 ** 3).toFixed(0) + ' GB';
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(0) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b.toFixed(0) + ' B';
}
function fmtRate(bps) {
  if (bps === null || bps === undefined || isNaN(bps)) return '—';
  if (bps >= 1024 ** 2) return (bps / 1024 ** 2).toFixed(1) + ' MB/s';
  if (bps >= 1024) return (bps / 1024).toFixed(0) + ' KB/s';
  return bps.toFixed(0) + ' B/s';
}
function push(arr, v) { arr.push(v); if (arr.length > HIST) arr.shift(); }
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  const w = Math.max(1, r.width), h = Math.max(1, r.height);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawSeries(cv, data, color, yMax) {
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  const max = Math.max(yMax || 0, ...data, 0.0001) * 1.15;
  const step = w / (HIST - 1);
  const x0 = w - (data.length - 1) * step;
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = x0 + i * step;
    const y = h - 1.5 - (v / max) * (h - 3);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.lineTo(x0 + (data.length - 1) * step, h); ctx.lineTo(x0, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, color + '40'); g.addColorStop(1, color + '00');
  ctx.fillStyle = g; ctx.fill();
}

// ---------- 侧栏 ----------
function buildSidebar() {
  const sb = document.getElementById('sidebar');
  sb.innerHTML = '';
  cards.forEach(c => {
    const el = document.createElement('div');
    el.className = 'card' + (c.id === activeCard ? ' active' : '');
    el.dataset.id = c.id;
    el.innerHTML = `
      <span class="dot" style="background:${c.color}"></span>
      <div class="card-body">
        <div class="card-title">${c.title}</div>
        <div class="card-sub" id="sub-${c.id}">正在采样…</div>
      </div>
      <canvas id="spark-${c.id}"></canvas>`;
    el.onclick = () => { activeCard = c.id; buildSidebar(); renderDetail(); };
    sb.appendChild(el);
  });
}

function updateSidebar(d) {
  const set = (id, txt) => { const el = document.getElementById('sub-' + id); if (el) el.textContent = txt; };
  const c = d.cpu, m = d.mem;
  const pe = (c.pUsage !== null && c.eUsage !== null)
    ? ` · P ${c.pUsage.toFixed(0)}% / E ${c.eUsage.toFixed(0)}%` : '';
  set('cpu', `${c.usage.toFixed(0)}%${pe}`);
  set('mem', `${fmtSize(m.used)} / ${fmtSize(m.total)}`);
  const vol = (d.disk.volumes.find(v => v.mount === '/') || d.disk.volumes[0]) || {};
  set('disk', `${fmtSize(vol.used)} / ${fmtSize(vol.total)} · ${fmtRate(d.disk.mbps * 1024 * 1024)}`);
  const en0 = d.net.ifaces.find(i => i.name === 'en0') || d.net.ifaces[0];
  set('net', d.wifi ? `Wi-Fi · ${d.wifi}` : (en0 ? en0.name : '未连接'));
  set('batt', d.batt.present ? `${d.batt.percent}%${d.batt.charging ? ' · 充电中' : ''}` : '无电池');

  const series = {
    cpu: hist.cpu, mem: hist.mem, disk: hist.disk,
    net: hist.netrx, batt: hist.batt
  };
  cards.forEach(cd => {
    const cv = document.getElementById('spark-' + cd.id);
    if (!cv) return;
    if (cd.id === 'net') {
      drawSeries(cv, hist.netrx, '#ffd60a');
      drawSeries(cv, hist.nettx, '#ff453a');
    } else {
      drawSeries(cv, series[cd.id], cd.color);
    }
  });
}

// ---------- 详情 ----------
const titleMap = { cpu: 'CPU', mem: '内存', disk: '磁盘', net: '网络', batt: '电池' };

function drawOverlaid(cv, primary, secondary, c1, c2, yMax) {
  drawSeries(cv, primary, c1, yMax);
  const { ctx, w, h } = setupCanvas(cv);
  if (secondary.length < 2) return;
  const max = Math.max(yMax || 0, ...primary, ...secondary, 0.0001) * 1.15;
  const step = w / (HIST - 1);
  const x0 = w - (secondary.length - 1) * step;
  ctx.beginPath();
  secondary.forEach((v, i) => {
    const x = x0 + i * step;
    const y = h - 1.5 - (v / max) * (h - 3);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = c2; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
}

const detailRenderers = {
  cpu(d) {
    const st = d.staticInfo;
    document.getElementById('detail-meta').textContent =
      `${st.chip} · ${st.perfCount} 性能核 + ${st.effCount} 能效核`;
    document.getElementById('chart-max').textContent = '';
    drawSeries(document.getElementById('bigchart'), hist.cpu, '#0a84ff');

    // P / E 双面板
    const pVal = d.cpu.pUsage === null ? '—' : d.cpu.pUsage.toFixed(0) + '%';
    const eVal = d.cpu.eUsage === null ? '—' : d.cpu.eUsage.toFixed(0) + '%';
    let html = `
      <div class="pe-grid">
        <div class="panel">
          <div class="panel-head">
            <span class="panel-title"><span class="chip chip-p">P</span>性能核心（${st.perfCount} 核）</span>
            <span class="panel-value" style="color:var(--p-core)">${pVal}</span>
          </div>
          <canvas id="pe-p"></canvas>
        </div>
        <div class="panel">
          <div class="panel-head">
            <span class="panel-title"><span class="chip chip-e">E</span>能效核心（${st.effCount} 核）</span>
            <span class="panel-value" style="color:var(--e-core)">${eVal}</span>
          </div>
          <canvas id="pe-e"></canvas>
        </div>
      </div>`;

    // 每核小图块
    html += `<div class="section-title">逻辑核心</div><div class="tiles" id="core-tiles">`;
    d.cpu.coreLoads.forEach((v, i) => {
      const isP = st.coreTypes[i] === 'P';
      html += `
        <div class="tile">
          <div class="tile-head">
            <span class="tile-name"><b style="color:${isP ? 'var(--p-core)' : 'var(--e-core)'}">${isP ? 'P' : 'E'}${isP ? i : i - st.perfCount}</b> 核心 ${i}</span>
            <span class="tile-val" id="tile-val-${i}">${v.toFixed(0)}%</span>
          </div>
          <canvas id="tile-cv-${i}"></canvas>
        </div>`;
    });
    html += `</div>`;

    const la = d.cpu.loadAvg;
    html += `
      <div class="info-grid">
        <div class="info-item"><div class="info-label">总利用率</div><div class="info-value">${d.cpu.usage.toFixed(1)}%</div></div>
        <div class="info-item"><div class="info-label">用户 / 系统</div><div class="info-value">${d.cpu.user.toFixed(1)}% <small>/</small> ${d.cpu.sys.toFixed(1)}%</div></div>
        <div class="info-item"><div class="info-label">空闲</div><div class="info-value">${d.cpu.idle.toFixed(1)}%</div></div>
        <div class="info-item"><div class="info-label">负载均值 (1/5/15 分钟)</div><div class="info-value">${(la[0]||0).toFixed(2)} <small>/</small> ${(la[1]||0).toFixed(2)} <small>/</small> ${(la[2]||0).toFixed(2)}</div></div>
      </div>`;
    return html;
  },
  mem(d) {
    const m = d.mem;
    document.getElementById('detail-meta').textContent = `${fmtSize(m.total)} 统一内存`;
    document.getElementById('chart-max').textContent = '';
    drawSeries(document.getElementById('bigchart'), hist.mem, '#bf5af2', 100);
    const rows = [
      ['已使用', m.used, '#bf5af2'],
      ['App 内存（活跃）', m.active, '#0a84ff'],
      ['联动内存（Wired）', m.wired, '#ff453a'],
      ['已压缩', m.compressed, '#ffd60a'],
      ['非活跃', m.inactive, '#30d158'],
      ['可用', m.avail, 'rgba(235,240,248,0.3)']
    ];
    return `
      <div class="info-grid">
        <div class="info-item"><div class="info-label">物理内存</div><div class="info-value">${fmtSize(m.used)} <small>/ ${fmtSize(m.total)}</small></div></div>
        <div class="info-item"><div class="info-label">内存占用率</div><div class="info-value">${(m.used / m.total * 100).toFixed(0)}%</div></div>
        <div class="info-item"><div class="info-label">压缩器压力</div><div class="info-value">${m.pressure.toFixed(1)}%</div></div>
        <div class="info-item"><div class="info-label">交换分区 (Swap)</div><div class="info-value">${fmtSize(m.swapUsed)} <small>/ ${fmtSize(m.swapTotal)}</small></div></div>
      </div>
      <div class="section-title">内存构成</div>
      ${rows.map(([label, v, color]) => `
        <div class="bar-row">
          <span class="bar-label">${label}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${(v / m.total * 100).toFixed(1)}%;background:${color}"></div></div>
          <span class="bar-num">${fmtSize(v)}</span>
        </div>`).join('')}`;
  },
  disk(d) {
    document.getElementById('detail-meta').textContent = `读写吞吐合计（macOS 磁盘层不区分读写）`;
    drawSeries(document.getElementById('bigchart'), hist.disk, '#30d158');
    document.getElementById('chart-max').textContent = fmtRate(Math.max(...hist.disk, 0.0001) * 1024 * 1024);
    const vols = d.disk.volumes.map(v => `
      <tr>
        <td>${esc(v.name)}</td>
        <td style="color:var(--text-2)">${esc(v.mount)}</td>
        <td>${fmtSize(v.used)} / ${fmtSize(v.total)}
          <span class="usage-track"><span class="usage-fill" style="width:${(v.used / v.total * 100).toFixed(0)}%"></span></span>
        </td>
        <td>可用 ${fmtSize(v.avail)}</td>
      </tr>`).join('');
    return `
      <div class="info-grid">
        <div class="info-item"><div class="info-label">当前吞吐（读写合计）</div><div class="info-value">${fmtRate(d.disk.mbps * 1024 * 1024)}</div></div>
        <div class="info-item"><div class="info-label">IOPS</div><div class="info-value">${d.disk.tps.toFixed(0)} <small>次/秒</small></div></div>
        <div class="info-item"><div class="info-label">60 秒峰值</div><div class="info-value">${fmtRate(Math.max(...hist.disk, 0) * 1024 * 1024)}</div></div>
      </div>
      <div class="section-title">卷（APFS 容器）</div>
      <table class="vol-table">
        <thead><tr><th>卷</th><th>挂载点</th><th>容量</th><th style="text-align:right">可用</th></tr></thead>
        <tbody>${vols}</tbody>
      </table>`;
  },
  net(d) {
    const en0 = d.net.ifaces.find(i => i.name === 'en0') || d.net.ifaces[0] || { rxRate: 0, txRate: 0, ibytes: 0, obytes: 0, name: 'en0' };
    document.getElementById('detail-meta').textContent = d.wifi ? `Wi-Fi · ${d.wifi}` : en0.name;
    drawOverlaid(document.getElementById('bigchart'), hist.netrx, hist.nettx, '#ffd60a', '#ff453a');
    document.getElementById('chart-max').textContent = fmtRate(Math.max(...hist.netrx, ...hist.nettx, 0.001));
    const ifaces = d.net.ifaces.map(i => `
      <tr>
        <td>${esc(i.name)}${i.name === 'en0' ? ' <span style="color:var(--text-3)">（Wi-Fi）</span>' : ''}</td>
        <td style="color:#ffd60a">↓ ${fmtRate(i.rxRate)}</td>
        <td style="color:#ff453a">↑ ${fmtRate(i.txRate)}</td>
        <td>累计收 ${fmtSize(i.ibytes)} / 发 ${fmtSize(i.obytes)}</td>
      </tr>`).join('');
    return `
      <div class="info-grid">
        <div class="info-item"><div class="info-label">接收速率 ↓</div><div class="info-value" style="color:#ffd60a">${fmtRate(en0.rxRate)}</div></div>
        <div class="info-item"><div class="info-label">发送速率 ↑</div><div class="info-value" style="color:#ff453a">${fmtRate(en0.txRate)}</div></div>
        <div class="info-item"><div class="info-label">本次开机累计接收</div><div class="info-value">${fmtSize(en0.ibytes)}</div></div>
        <div class="info-item"><div class="info-label">本次开机累计发送</div><div class="info-value">${fmtSize(en0.obytes)}</div></div>
      </div>
      <div class="section-title">网络接口（<span style="color:#ffd60a">黄=接收</span> / <span style="color:#ff453a">红=发送</span>）</div>
      <table class="vol-table">
        <thead><tr><th>接口</th><th>接收</th><th>发送</th><th>累计</th></tr></thead>
        <tbody>${ifaces}</tbody>
      </table>`;
  },
  batt(d) {
    const b = d.batt;
    document.getElementById('detail-meta').textContent = b.charging ? '已接通电源' : '使用电池';
    drawSeries(document.getElementById('bigchart'), hist.batt, '#30d158', 100);
    document.getElementById('chart-max').textContent = '100%';
    return `
      <div class="info-grid">
        <div class="info-item"><div class="info-label">电量</div><div class="info-value">${b.present ? b.percent + '%' : '—'}</div></div>
        <div class="info-item"><div class="info-label">状态</div><div class="info-value">${b.present ? (b.charging ? '⚡ 充电中' : '🔋 电池供电') : '无电池'}</div></div>
        <div class="info-item"><div class="info-label">${b.charging ? '充满' : '可用'}时间</div><div class="info-value">${b.timeRemaining || '—'}</div></div>
      </div>
      <div class="section-title">近 60 秒电量曲线</div>`;
  }
};

// CPU 详情渲染后需要补画 P/E 面板和每核小图
function paintCpuExtras(d) {
  if (activeCard !== 'cpu' || !d) return;
  const pCv = document.getElementById('pe-p');
  const eCv = document.getElementById('pe-e');
  if (pCv) drawSeries(pCv, hist.cpuP, '#0a84ff', 100);
  if (eCv) drawSeries(eCv, hist.cpuE, '#30d158', 100);
  d.cpu.coreLoads.forEach((v, i) => {
    if (!hist.cores[i]) hist.cores[i] = [];
    const cv = document.getElementById('tile-cv-' + i);
    if (!cv) return;
    const st = d.staticInfo;
    drawSeries(cv, hist.cores[i], st.coreTypes[i] === 'P' ? '#0a84ff' : '#30d158', 100);
    const tv = document.getElementById('tile-val-' + i);
    if (tv) tv.textContent = v.toFixed(0) + '%';
  });
}

function renderDetail() {
  if (!latest) return;
  document.getElementById('detail-title').textContent = titleMap[activeCard];
  document.getElementById('detail-body').innerHTML = detailRenderers[activeCard](latest);
  paintCpuExtras(latest);
}

// ---------- 进程 ----------
function renderProcs(d) {
  const tbody = document.getElementById('proc-tbody');
  const q = procQuery.toLowerCase();
  let list = d.procs.list;
  if (q) list = list.filter(p => p.name.toLowerCase().includes(q) || String(p.pid).includes(q));
  if (procSort === 'cpu') list = [...list].sort((a, b) => b.cpu - a.cpu);
  else if (procSort === 'mem') list = [...list].sort((a, b) => b.rss - a.rss);
  else if (procSort === 'pid') list = [...list].sort((a, b) => a.pid - b.pid);
  const shown = list.slice(0, 200);
  tbody.innerHTML = shown.map(p => `
    <tr>
      <td class="td-num">${p.pid}</td>
      <td style="max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</td>
      <td class="td-num ${p.cpu > 30 ? 'cpu-hot' : ''}">${p.cpu.toFixed(1)}</td>
      <td class="td-num">${fmtSize(p.rss)}</td>
      <td style="text-align:right"><button class="kill-btn" data-pid="${p.pid}">退出</button></td>
    </tr>`).join('');
  document.getElementById('proc-summary').textContent =
    `显示 ${shown.length} / ${d.procs.count} 个进程 · 按 ${procSort === 'cpu' ? 'CPU' : procSort === 'mem' ? '内存' : 'PID'} 排序`;
  tbody.querySelectorAll('.kill-btn').forEach(btn => {
    btn.onclick = () => window.bridge.killProcess(parseInt(btn.dataset.pid, 10));
  });
}

// ---------- 状态栏 ----------
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d > 0 ? `${d} 天 ${h} 小时` : h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}

// ---------- 事件 ----------
function switchView(v) {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.view === v));
  document.getElementById('perf-view').classList.toggle('active', v === 'perf');
  document.getElementById('procs-view').classList.toggle('active', v === 'procs');
  if (v === 'procs' && latest) renderProcs(latest);
  if (v === 'perf' && latest) { renderDetail(); }
}
document.querySelectorAll('.tab').forEach(t => { t.onclick = () => switchView(t.dataset.view); });
document.getElementById('proc-search').addEventListener('input', e => {
  procQuery = e.target.value;
  if (latest) renderProcs(latest);
});
document.getElementById('th-cpu').onclick = () => {
  procSort = procSort === 'cpu' ? 'pid' : procSort === 'pid' ? 'mem' : 'cpu';
  if (latest) renderProcs(latest);
};
// 键盘：⌘1/⌘2 切页，Esc 清空搜索
window.addEventListener('keydown', e => {
  if (e.metaKey && e.key === '1') { e.preventDefault(); switchView('perf'); }
  else if (e.metaKey && e.key === '2') { e.preventDefault(); switchView('procs'); }
  else if (e.key === 'Escape') {
    const s = document.getElementById('proc-search');
    if (s.value) { s.value = ''; procQuery = ''; if (latest) renderProcs(latest); }
  }
});
window.addEventListener('keydown', e => {
  if (e.metaKey) document.body.classList.add('cmd-down');
});
window.addEventListener('keyup', e => {
  if (!e.metaKey) document.body.classList.remove('cmd-down');
});

// ---------- 主循环 ----------
window.bridge.onStats((d) => {
  latest = d;
  push(hist.cpu, d.cpu.usage);
  push(hist.cpuP, d.cpu.pUsage === null ? 0 : d.cpu.pUsage);
  push(hist.cpuE, d.cpu.eUsage === null ? 0 : d.cpu.eUsage);
  push(hist.mem, d.mem.used / d.mem.total * 100);
  push(hist.disk, d.disk.mbps);
  const en0 = d.net.ifaces.find(i => i.name === 'en0') || d.net.ifaces[0];
  push(hist.netrx, en0 ? en0.rxRate : 0);
  push(hist.nettx, en0 ? en0.txRate : 0);
  push(hist.batt, d.batt.present ? d.batt.percent : 0);
  d.cpu.coreLoads.forEach((v, i) => {
    if (!hist.cores[i]) hist.cores[i] = [];
    push(hist.cores[i], v);
  });

  if (!document.getElementById('osinfo').textContent) {
    document.getElementById('osinfo').textContent = `macOS ${d.staticInfo.osVersion} · arm64`;
    document.getElementById('sb-left').textContent =
      `macOS ${d.staticInfo.osVersion} · ${d.staticInfo.chip}（${d.staticInfo.perfCount}P + ${d.staticInfo.effCount}E）· 采样间隔 2 秒`;
  }
  updateSidebar(d);
  renderDetail();
  if (document.getElementById('procs-view').classList.contains('active')) {
    renderProcs(d);
  }
  const up = Math.max(0, Date.now() / 1000 - d.staticInfo.bootSec);
  document.getElementById('sb-right').textContent = `进程 ${d.procs.count} · 已运行 ${fmtUptime(up)}`;
});

buildSidebar();
