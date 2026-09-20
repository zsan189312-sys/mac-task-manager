// 渲染进程：UI + 图表（P/E 核心分离 · GPU 监测 · 增量更新架构）
const HIST = 60;
const hist = {
  cpu: [], cpuP: [], cpuE: [], mem: [], disk: [], gpu: [],
  netrx: [], nettx: [], batt: [], cores: []
};

const cards = [
  { id: 'cpu',  title: 'CPU',  color: '#0a84ff' },
  { id: 'gpu',  title: 'GPU',  color: '#64d2ff' },
  { id: 'mem',  title: '内存', color: '#bf5af2' },
  { id: 'disk', title: '磁盘', color: '#30d158' },
  { id: 'net',  title: 'Wi-Fi', color: '#ffd60a' },
  { id: 'batt', title: '电池', color: '#30d158' }
];
// M4 核心频率规格（Apple 公布 P 核睿频 4.41 GHz；E 核实测约 2.6 GHz）
const FREQ = { pIdle: 0.7, pMax: 4.41, eIdle: 0.6, eMax: 2.6 };
const cardColor = Object.fromEntries(cards.map(c => [c.id, c.color]));
let activeCard = 'cpu';
let latest = null;
let procSort = 'cpu';
let procQuery = '';
let bodyBuilt = false; // detail-body 是否已按当前卡片构建

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
function setText(id, v) { const el = document.getElementById(id); if (el && el.textContent !== v) el.textContent = v; }

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
    el.onclick = () => { activeCard = c.id; bodyBuilt = false; buildSidebar(); tickDetail(true); };
    sb.appendChild(el);
  });
}

function updateSidebar(d) {
  const c = d.cpu, m = d.mem;
  const pe = (c.pUsage !== null && c.eUsage !== null)
    ? ` · P ${c.pUsage.toFixed(0)}% / E ${c.eUsage.toFixed(0)}%` : '';
  setText('sub-cpu', `${c.usage.toFixed(0)}%${pe}`);
  setText('sub-mem', `${fmtSize(m.used)} / ${fmtSize(m.total)}`);
  const vol = (d.disk.volumes.find(v => v.mount === '/') || d.disk.volumes[0]) || {};
  setText('sub-disk', `${fmtSize(vol.used)} / ${fmtSize(vol.total)} · ${fmtRate(d.disk.mbps * 1024 * 1024)}`);
  const en0 = d.net.ifaces.find(i => i.name === 'en0') || d.net.ifaces[0];
  setText('sub-net', d.wifi ? `Wi-Fi · ${d.wifi}` : (en0 ? 'Wi-Fi · 已连接' : '未连接'));
  setText('sub-batt', d.batt.present ? `${d.batt.percent}%${d.batt.charging ? ' · 充电中' : ''}` : '无电池');
  setText('sub-gpu', d.gpu.util === null ? '—' : `${d.gpu.util.toFixed(0)}% · ${fmtSize(d.gpu.memBytes)}`);

  drawSeries(document.getElementById('spark-cpu'), hist.cpu, '#0a84ff');
  drawSeries(document.getElementById('spark-mem'), hist.mem, '#bf5af2', 100);
  drawSeries(document.getElementById('spark-gpu'), hist.gpu, '#64d2ff', 100);
  drawSeries(document.getElementById('spark-disk'), hist.disk, '#30d158');
  drawSeries(document.getElementById('spark-net'), hist.netrx, '#ffd60a');
  drawSeries(document.getElementById('spark-net'), hist.nettx, '#ff453a');
  drawSeries(document.getElementById('spark-batt'), hist.batt, '#30d158', 100);
}

// ---------- 详情：build（切换时一次） / update（每帧增量） ----------
const titleMap = { cpu: 'CPU', mem: '内存', gpu: 'GPU', disk: '磁盘', net: '网络', batt: '电池' };

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

const detailDefs = {
  cpu: {
    build(d) {
      const st = d.staticInfo;
      let html = `
        <div class="pe-grid">
          <div class="panel">
            <div class="panel-head">
              <span class="panel-title"><span class="chip chip-p">P</span>性能核心（${st.perfCount} 核）</span>
              <span class="panel-value" style="color:var(--p-core)" id="p-val">—</span>
            </div>
            <canvas id="pe-p"></canvas>
          </div>
          <div class="panel">
            <div class="panel-head">
              <span class="panel-title"><span class="chip chip-e">E</span>能效核心（${st.effCount} 核）</span>
              <span class="panel-value" style="color:var(--e-core)" id="e-val">—</span>
            </div>
            <canvas id="pe-e"></canvas>
          </div>
        </div>
        <div class="section-title">逻辑核心</div><div class="tiles">`;
      d.cpu.coreLoads.forEach((v, i) => {
        const isP = st.coreTypes[i] === 'P';
        html += `
          <div class="tile">
            <div class="tile-head">
              <span class="tile-name"><b style="color:${isP ? 'var(--p-core)' : 'var(--e-core)'}">${isP ? 'P' : 'E'}${isP ? i : i - st.perfCount}</b> 核心 ${i}</span>
              <span class="tile-val" id="tile-val-${i}">—</span>
            </div>
            <canvas id="tile-cv-${i}"></canvas>
          </div>`;
      });
      html += `</div>
        <div class="info-grid">
          <div class="info-item"><div class="info-label">总利用率</div><div class="info-value" id="cpu-total">—</div></div>
          <div class="info-item"><div class="info-label">P 核估算频率</div><div class="info-value" style="color:var(--p-core)" id="cpu-freq-p">—</div></div>
          <div class="info-item"><div class="info-label">E 核估算频率</div><div class="info-value" style="color:var(--e-core)" id="cpu-freq-e">—</div></div>
          <div class="info-item"><div class="info-label">用户 / 系统</div><div class="info-value" id="cpu-us">—</div></div>
          <div class="info-item"><div class="info-label">空闲</div><div class="info-value" id="cpu-idle">—</div></div>
          <div class="info-item"><div class="info-label">负载均值 (1/5/15 分钟)</div><div class="info-value" id="cpu-load">—</div></div>
        </div>`;
      return html;
    },
    update(d) {
      setText('p-val', d.cpu.pUsage === null ? '—' : d.cpu.pUsage.toFixed(0) + '%');
      setText('e-val', d.cpu.eUsage === null ? '—' : d.cpu.eUsage.toFixed(0) + '%');
      drawSeries(document.getElementById('pe-p'), hist.cpuP, '#0a84ff', 100);
      drawSeries(document.getElementById('pe-e'), hist.cpuE, '#30d158', 100);
      d.cpu.coreLoads.forEach((v, i) => {
        setText('tile-val-' + i, v.toFixed(0) + '%');
        const cv = document.getElementById('tile-cv-' + i);
        if (cv) drawSeries(cv, hist.cores[i], d.staticInfo.coreTypes[i] === 'P' ? '#0a84ff' : '#30d158', 100);
      });
      setText('cpu-total', d.cpu.usage.toFixed(1) + '%');
      // 估算频率：闲置基频 + 利用率 × 睿频区间（macOS 无用户态频率接口）
      const fp = d.cpu.pUsage === null ? null : FREQ.pIdle + (FREQ.pMax - FREQ.pIdle) * (d.cpu.pUsage / 100);
      const fe = d.cpu.eUsage === null ? null : FREQ.eIdle + (FREQ.eMax - FREQ.eIdle) * (d.cpu.eUsage / 100);
      setText('cpu-freq-p', fp === null ? '—' : '~' + fp.toFixed(2) + ' GHz');
      setText('cpu-freq-e', fe === null ? '—' : '~' + fe.toFixed(2) + ' GHz');
      setText('cpu-us', `${d.cpu.user.toFixed(1)}% / ${d.cpu.sys.toFixed(1)}%`);
      setText('cpu-idle', d.cpu.idle.toFixed(1) + '%');
      const la = d.cpu.loadAvg;
      setText('cpu-load', `${(la[0]||0).toFixed(2)} / ${(la[1]||0).toFixed(2)} / ${(la[2]||0).toFixed(2)}`);
    },
    meta(d) { return `${d.staticInfo.chip} · P 核睿频 4.41 GHz · E 核 ~2.6 GHz（频率为利用率估算）`; }
  },
  gpu: {
    build(d) {
      const g = d.staticInfo.gpu || {};
      return `
        <div class="info-grid">
          <div class="info-item"><div class="info-label">GPU 利用率</div><div class="info-value" style="color:var(--p-core)" id="gpu-util">—</div></div>
          <div class="info-item"><div class="info-label">渲染器 / 分块器</div><div class="info-value" id="gpu-rt">—</div></div>
          <div class="info-item"><div class="info-label">GPU 显存占用</div><div class="info-value" id="gpu-mem">—</div></div>
          <div class="info-item"><div class="info-label">规格</div><div class="info-value" style="font-size:13px">${esc(d.staticInfo.chip)} GPU${g.cores ? ' · ' + g.cores + ' 核' : ''}${g.metal ? ' · ' + esc(g.metal) : ''}</div></div>
        </div>
        <div class="section-title">GPU 利用率曲线（IOAccelerator 实时采样）</div>`;
    },
    update(d) {
      setText('gpu-util', d.gpu.util === null ? '—' : d.gpu.util.toFixed(0) + '%');
      setText('gpu-rt', d.gpu.renderer === null ? '—' : `${d.gpu.renderer.toFixed(0)}% / ${d.gpu.tiler === null ? '—' : d.gpu.tiler.toFixed(0) + '%'}`);
      setText('gpu-mem', d.gpu.memBytes === null ? '—' : fmtSize(d.gpu.memBytes));
    },
    meta() { return 'IOAccelerator 用户态采样 · 无需 sudo'; }
  },
  mem: {
    build() {
      return `
        <div class="info-grid">
          <div class="info-item"><div class="info-label">物理内存</div><div class="info-value" id="mem-used">—</div></div>
          <div class="info-item"><div class="info-label">内存占用率</div><div class="info-value" id="mem-pct">—</div></div>
          <div class="info-item"><div class="info-label">压缩器压力</div><div class="info-value" id="mem-pressure">—</div></div>
          <div class="info-item"><div class="info-label">交换分区 (Swap)</div><div class="info-value" id="mem-swap">—</div></div>
        </div>
        <div class="section-title">内存构成</div><div id="mem-bars"></div>`;
    },
    update(d) {
      const m = d.mem;
      setText('mem-used', `${fmtSize(m.used)} / ${fmtSize(m.total)}`);
      setText('mem-pct', (m.used / m.total * 100).toFixed(0) + '%');
      setText('mem-pressure', m.pressure.toFixed(1) + '%');
      setText('mem-swap', `${fmtSize(m.swapUsed)} / ${fmtSize(m.swapTotal)}`);
      const rows = [
        ['已使用', m.used, '#bf5af2'], ['App 内存（活跃）', m.active, '#0a84ff'],
        ['联动内存（Wired）', m.wired, '#ff453a'], ['已压缩', m.compressed, '#ffd60a'],
        ['非活跃', m.inactive, '#30d158'], ['可用', m.avail, 'rgba(235,240,248,0.3)']
      ];
      const bar = document.getElementById('mem-bars');
      if (bar && !bar.dataset.built) {
        bar.innerHTML = rows.map((r, i) => `
          <div class="bar-row">
            <span class="bar-label">${r[0]}</span>
            <div class="bar-track"><div class="bar-fill" id="bar-mem-${i}" style="background:${r[2]}"></div></div>
            <span class="bar-num" id="bar-num-${i}">—</span>
          </div>`).join('');
        bar.dataset.built = '1';
      }
      rows.forEach((r, i) => {
        const f = document.getElementById('bar-mem-' + i);
        if (f) f.style.width = (r[1] / m.total * 100).toFixed(1) + '%';
        setText('bar-num-' + i, fmtSize(r[1]));
      });
    },
    meta(d) { return `${fmtSize(d.mem.total)} 统一内存`; }
  },
  disk: {
    build() {
      return `
        <div class="info-grid">
          <div class="info-item"><div class="info-label">当前吞吐（读写合计）</div><div class="info-value" id="disk-rate">—</div></div>
          <div class="info-item"><div class="info-label">IOPS</div><div class="info-value" id="disk-iops">—</div></div>
          <div class="info-item"><div class="info-label">60 秒峰值</div><div class="info-value" id="disk-peak">—</div></div>
        </div>
        <div class="section-title">卷（APFS 容器）</div>
        <table class="vol-table">
          <thead><tr><th>卷</th><th>挂载点</th><th>容量</th><th style="text-align:right">可用</th></tr></thead>
          <tbody id="vol-tbody"><tr><td colspan="4" style="color:var(--text-3)">采集中…</td></tr></tbody>
        </table>`;
    },
    update(d) {
      setText('disk-rate', fmtRate(d.disk.mbps * 1024 * 1024));
      setText('disk-iops', d.disk.tps.toFixed(0) + ' 次/秒');
      setText('disk-peak', fmtRate(Math.max(...hist.disk, 0) * 1024 * 1024));
      const tb = document.getElementById('vol-tbody');
      if (tb && d.disk.volumes.length) {
        tb.innerHTML = d.disk.volumes.map(v => `
          <tr>
            <td>${esc(v.name)}</td>
            <td style="color:var(--text-2)">${esc(v.mount)}</td>
            <td>${fmtSize(v.used)} / ${fmtSize(v.total)}
              <span class="usage-track"><span class="usage-fill" style="width:${(v.used / v.total * 100).toFixed(0)}%"></span></span>
            </td>
            <td>可用 ${fmtSize(v.avail)}</td>
          </tr>`).join('');
      }
    },
    meta() { return '读写吞吐合计（macOS 磁盘层不区分读写）'; }
  },
  net: {
    build() {
      return `
        <div class="info-grid">
          <div class="info-item"><div class="info-label">接收速率 ↓</div><div class="info-value" style="color:#ffd60a" id="net-rx">—</div></div>
          <div class="info-item"><div class="info-label">发送速率 ↑</div><div class="info-value" style="color:#ff453a" id="net-tx">—</div></div>
          <div class="info-item"><div class="info-label">本次开机累计接收</div><div class="info-value" id="net-rxt">—</div></div>
          <div class="info-item"><div class="info-label">本次开机累计发送</div><div class="info-value" id="net-txt">—</div></div>
        </div>
        <div class="section-title">网络接口（<span style="color:#ffd60a">黄=接收</span> / <span style="color:#ff453a">红=发送</span>）</div>
        <table class="vol-table">
          <thead><tr><th>接口</th><th>接收</th><th>发送</th><th>累计</th></tr></thead>
          <tbody id="net-tbody"></tbody>
        </table>`;
    },
    update(d) {
      const en0 = d.net.ifaces.find(i => i.name === 'en0') || d.net.ifaces[0] ||
        { rxRate: 0, txRate: 0, ibytes: 0, obytes: 0, name: 'en0' };
      setText('net-rx', fmtRate(en0.rxRate));
      setText('net-tx', fmtRate(en0.txRate));
      setText('net-rxt', fmtSize(en0.ibytes));
      setText('net-txt', fmtSize(en0.obytes));
      const tb = document.getElementById('net-tbody');
      if (tb) tb.innerHTML = d.net.ifaces.map(i => `
        <tr>
          <td>${esc(i.name)}${i.name === 'en0' ? ' <span style="color:var(--text-3)">（Wi-Fi）</span>' : ''}</td>
          <td style="color:#ffd60a">↓ ${fmtRate(i.rxRate)}</td>
          <td style="color:#ff453a">↑ ${fmtRate(i.txRate)}</td>
          <td>累计收 ${fmtSize(i.ibytes)} / 发 ${fmtSize(i.obytes)}</td>
        </tr>`).join('');
    },
    meta(d) { return d.wifi ? `Wi-Fi · ${d.wifi}` : 'Wi-Fi · 已连接'; }
  },
  batt: {
    build() {
      return `
        <div class="info-grid">
          <div class="info-item"><div class="info-label">电量</div><div class="info-value" id="batt-pct">—</div></div>
          <div class="info-item"><div class="info-label">状态</div><div class="info-value" id="batt-state">—</div></div>
          <div class="info-item"><div class="info-label"><span id="batt-time-label">可用</span>时间</div><div class="info-value" id="batt-time">—</div></div>
        </div>
        <div class="section-title">近 60 秒电量曲线</div>`;
    },
    update(d) {
      const b = d.batt;
      setText('batt-pct', b.present ? b.percent + '%' : '—');
      setText('batt-state', b.present ? (b.charging ? '⚡ 充电中' : '🔋 电池供电') : '无电池');
      setText('batt-time', b.timeRemaining || '—');
      setText('batt-time-label', b.charging ? '充满' : '可用');
    },
    meta(d) { return d.batt.charging ? '已接通电源' : '使用电池'; }
  }
};

function tickDetail(force) {
  if (!latest) return;
  const body = document.getElementById('detail-body');
  if (!bodyBuilt || force) {
    body.innerHTML = detailDefs[activeCard].build(latest);
    bodyBuilt = true;
  }
  detailDefs[activeCard].update(latest);
  // 大图 + 轴标注
  const color = cardColor[activeCard];
  const big = document.getElementById('bigchart');
  if (activeCard === 'net') {
    drawOverlaid(big, hist.netrx, hist.nettx, '#ffd60a', '#ff453a');
    setText('chart-max', fmtRate(Math.max(...hist.netrx, ...hist.nettx, 0.001)));
  } else {
    const series = { cpu: hist.cpu, mem: hist.mem, gpu: hist.gpu, disk: hist.disk, batt: hist.batt };
    const yMax = (activeCard === 'mem' || activeCard === 'gpu' || activeCard === 'batt') ? 100 : undefined;
    drawSeries(big, series[activeCard], color, yMax);
    setText('chart-max', activeCard === 'batt' ? '100%'
      : activeCard === 'disk' ? fmtRate(Math.max(...hist.disk, 0.0001) * 1024 * 1024)
      : (activeCard === 'mem' || activeCard === 'gpu') ? '100%' : '');
  }
  setText('detail-meta', detailDefs[activeCard].meta(latest));
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
  if (v === 'perf' && latest) tickDetail(true);
  if (v === 'procs' && latest) renderProcs(latest);
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
window.addEventListener('keydown', e => {
  if (e.metaKey && e.key === '1') { e.preventDefault(); switchView('perf'); }
  else if (e.metaKey && e.key === '2') { e.preventDefault(); switchView('procs'); }
  else if (e.key === 'Escape') {
    const s = document.getElementById('proc-search');
    if (s.value) { s.value = ''; procQuery = ''; if (latest) renderProcs(latest); }
  }
  document.body.classList.toggle('cmd-down', e.metaKey);
});
window.addEventListener('keyup', e => { if (!e.metaKey) document.body.classList.remove('cmd-down'); });

// ---------- 主循环 ----------
window.bridge.onStats((d) => {
  latest = d;
  push(hist.cpu, d.cpu.usage);
  push(hist.cpuP, d.cpu.pUsage === null ? 0 : d.cpu.pUsage);
  push(hist.cpuE, d.cpu.eUsage === null ? 0 : d.cpu.eUsage);
  push(hist.mem, d.mem.used / d.mem.total * 100);
  push(hist.gpu, d.gpu.util === null ? 0 : d.gpu.util);
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
  if (document.getElementById('perf-view').classList.contains('active')) tickDetail();
  if (document.getElementById('procs-view').classList.contains('active')) renderProcs(d);
  const up = Math.max(0, Date.now() / 1000 - d.staticInfo.bootSec);
  document.getElementById('sb-right').textContent = `进程 ${d.procs.count} · 已运行 ${fmtUptime(up)}`;
});

buildSidebar();
