#!/usr/bin/env -S npx tsx
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const LOGS_DIR = path.resolve(__dirname, '..', 'logs')
const PORT = 3456

interface LogEntry {
  timestamp: string
  symbol: string
  line: string
}

function parseLogFile(filePath: string): LogEntry[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const entries: LogEntry[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    const match = line.match(
      /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+(\w+)\s+/
    )
    if (match) {
      entries.push({ timestamp: match[1], symbol: match[2], line })
    } else {
      entries.push({ timestamp: '', symbol: '_header', line })
    }
  }
  return entries
}

function getAllEntries(): LogEntry[] {
  const files = fs.readdirSync(LOGS_DIR).filter((f) => f.endsWith('.log'))
  const all: LogEntry[] = []
  for (const file of files.sort()) {
    all.push(...parseLogFile(path.join(LOGS_DIR, file)))
  }
  return all
}

function getSymbols(entries: LogEntry[]): string[] {
  const set = new Set<string>()
  for (const e of entries) {
    if (e.symbol !== '_header') set.add(e.symbol)
  }
  return Array.from(set).sort()
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Log Viewer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'SF Mono', 'Menlo', 'Consolas', monospace; background: #0d1117; color: #c9d1d9; display: flex; flex-direction: column; height: 100vh; }
  header { padding: 12px 16px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 14px; font-weight: 600; color: #58a6ff; white-space: nowrap; }
  .symbol-bar { display: flex; gap: 6px; flex-wrap: wrap; }
  .symbol-btn { padding: 4px 12px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; border-radius: 6px; cursor: pointer; font-size: 12px; font-family: inherit; }
  .symbol-btn:hover { background: #30363d; }
  .symbol-btn.active { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .controls { display: flex; gap: 8px; margin-left: auto; align-items: center; }
  .controls button { padding: 4px 10px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; border-radius: 6px; cursor: pointer; font-size: 12px; font-family: inherit; }
  .controls button:hover { background: #30363d; }
  .controls span { font-size: 12px; color: #8b949e; }
  #log-container { flex: 1; overflow-y: auto; padding: 8px 0; }
  .log-line { padding: 2px 16px; font-size: 12px; line-height: 1.6; white-space: pre; border-bottom: 1px solid #161b22; }
  .log-line:hover { background: #161b22; }
  .log-line.header-line { color: #58a6ff; font-weight: 600; }
  .log-line .ts { color: #8b949e; }
  .log-line .sym { color: #d2a8ff; font-weight: 600; }
  .loading { text-align: center; padding: 40px; color: #8b949e; }
  .signal-sep { border-top: 1px solid #30363d; margin: 8px 0; }
</style>
</head>
<body>
<header>
  <h1>Log Viewer</h1>
  <div class="symbol-bar" id="symbols"></div>
  <div class="controls">
    <button onclick="toggleToday()" id="today-btn">Today: Off</button>
    <button onclick="loadPrevSignal()">&lt;</button>
    <span id="signal-info">-</span>
    <button onclick="loadNextSignal()">&gt;</button>
    <button onclick="toggleAutoRefresh()" id="auto-btn">Auto: Off</button>
  </div>
</header>
<div id="log-container"><div class="loading">Loading...</div></div>
<script>
let symbols = [];
let active = null;
let todayOnly = false;
let signalOffset = 0;
let autoRefresh = false;
let autoTimer = null;

async function init() {
  const res = await fetch('/api/symbols');
  symbols = await res.json();
  const bar = document.getElementById('symbols');
  bar.innerHTML = '<button class="symbol-btn active" data-sym="__all__">ALL</button>' +
    symbols.map(s => '<button class="symbol-btn" data-sym="'+s+'">'+s+'</button>').join('');
  bar.addEventListener('click', e => {
    const btn = e.target.closest('.symbol-btn');
    if (!btn) return;
    bar.querySelectorAll('.symbol-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    active = btn.dataset.sym === '__all__' ? null : btn.dataset.sym;
    signalOffset = 0;
    loadSignals();
  });
  loadSignals();
}

async function loadSignals() {
  const container = document.getElementById('log-container');
  const params = new URLSearchParams({ offset: signalOffset, limit: 1 });
  if (active) params.set('symbol', active);
  if (todayOnly) params.set('today', 'true');
  const res = await fetch('/api/signals?' + params);
  const data = await res.json();
  document.getElementById('signal-info').textContent =
    data.total === 0 ? 'No signals' : 'Signal ' + (signalOffset + 1) + ' of ' + data.total;
  if (data.signals.length === 0) {
    container.innerHTML = '<div class="loading">No signals</div>';
    return;
  }
  container.innerHTML = data.signals.map(block => {
    return block.split('\\n').map(l => {
      if (l.includes('▲ SIGNAL')) {
        return '<div class="log-line header-line">' + escHtml(l) + '</div>';
      }
      const m = l.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}\\.\\d+)\\s+(\\w+)(.*)/);
      if (m) {
        return '<div class="log-line"><span class="ts">' + m[1] + '</span>  <span class="sym">' + m[2] + '</span>' + escHtml(m[3]) + '</div>';
      }
      return '<div class="log-line">' + escHtml(l) + '</div>';
    }).join('');
  }).join('<div style="border-top: 1px solid #30363d; margin: 8px 0;"></div>');
  container.scrollTop = 0;
  return data.total;
}

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function toggleToday() {
  todayOnly = !todayOnly;
  document.getElementById('today-btn').textContent = 'Today: ' + (todayOnly ? 'On' : 'Off');
  signalOffset = 0;
  loadSignals();
}
function loadPrevSignal() { if (signalOffset > 0) { signalOffset--; loadSignals(); } }
function loadNextSignal() { signalOffset++; loadSignals(); }
async function toggleAutoRefresh() {
  autoRefresh = !autoRefresh;
  document.getElementById('auto-btn').textContent = 'Auto: ' + (autoRefresh ? 'On' : 'Off');
  if (autoRefresh) {
    // Jump to last signal immediately
    const total = await loadSignals();
    if (total > 0) signalOffset = total - 1;
    await loadSignals();
    autoTimer = setInterval(async () => {
      const t = await loadSignals();
      if (t > 0) signalOffset = t - 1;
      await loadSignals();
    }, 2000);
  } else {
    clearInterval(autoTimer);
    autoTimer = null;
  }
}

init();
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`)

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(HTML)
    return
  }

  if (url.pathname === '/api/symbols') {
    const entries = getAllEntries()
    const symbols = getSymbols(entries)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(symbols))
    return
  }

  if (url.pathname === '/api/logs') {
    const symbol = url.searchParams.get('symbol')
    const page = parseInt(url.searchParams.get('page') || '0', 10)
    const size = parseInt(url.searchParams.get('size') || '500', 10)

    let entries = getAllEntries()
    if (symbol) {
      entries = entries.filter((e) => e.symbol === symbol || e.symbol === '_header')
    }
    const total = entries.length
    const totalPages = Math.ceil(total / size) || 1
    const clampedPage = Math.min(page, totalPages - 1)
    const sliced = entries.slice(clampedPage * size, (clampedPage + 1) * size)
    const lines = sliced.map((e) =>
      e.symbol === '_header' ? '_HEADER_' + e.line : e.line
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ lines, total, totalPages, page: clampedPage }))
    return
  }

  if (url.pathname === '/api/signals') {
    const symbol = url.searchParams.get('symbol')
    const today = url.searchParams.get('today') === 'true'
    const offset = parseInt(url.searchParams.get('offset') || '0', 10)
    const limit = parseInt(url.searchParams.get('limit') || '1', 10)

    let entries = getAllEntries()
    if (symbol) {
      entries = entries.filter((e) => e.symbol === symbol)
    }
    if (today) {
      const todayStr = new Date().toISOString().slice(0, 10)
      entries = entries.filter((e) => e.timestamp.startsWith(todayStr))
    }

    // Group into signals
    const signals: string[][] = []
    let current: string[] | null = null
    for (const e of entries) {
      if (e.line.includes('▲ SIGNAL')) {
        if (current) signals.push(current)
        current = [e.line]
      } else if (current) {
        current.push(e.line)
      }
    }
    if (current) signals.push(current)

    const total = signals.length
    const sliced = signals.slice(offset, offset + limit)
    const blocks = sliced.map((s) => s.join('\n'))

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ signals: blocks, total, offset, limit }))
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

server.listen(PORT, () => {
  console.log(`Log viewer running at http://localhost:${PORT}`)
})
