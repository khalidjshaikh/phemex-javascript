/**
 * Graph ticker.csv with Plotly.js.
 *
 * Reads ./ticker.csv (time,ask,bid,index,mark,last) and generates a standalone
 * self-contained HTML page (ticker-graph.html) with an interactive Plotly chart.
 * Re-run whenever ticker.csv changes:
 *
 *   npm run graph
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const CSV_PATH = join(ROOT, 'ticker.csv');
const HTML_PATH = join(ROOT, 'ticker-graph.html');
const PLOTLY_LOCAL = join(ROOT, 'vendor', 'plotly.min.js');
// Date axis needs a full date; ticker.csv only carries HH:MM:SS, so pin a base date.
const BASE_DATE = '2000-01-01';

interface Tick {
  time: string; // full ISO datetime for Plotly's date axis
  timeLabel: string; // raw HH:MM:SS for display
  ask: number;
  bid: number;
  index: number;
  mark: number;
  last: number;
}

function parseCsv(text: string): Tick[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error(`${CSV_PATH} is empty`);
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const required = ['time', 'ask', 'bid', 'index', 'mark', 'last'];
  for (const col of required) {
    if (!header.includes(col)) {
      throw new Error(`ticker.csv is missing required column "${col}" (got: ${header.join(', ')})`);
    }
  }
  const idx = Object.fromEntries(header.map((h, i) => [h, i])) as Record<string, number>;
  const ticks: Tick[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const raw = cols[idx.time].trim();
    if (!/^\d{2}:\d{2}:\d{2}/.test(raw)) continue; // skip malformed rows
    ticks.push({
      time: `${BASE_DATE}T${raw}`,
      timeLabel: raw,
      ask: parseFloat(cols[idx.ask]),
      bid: parseFloat(cols[idx.bid]),
      index: parseFloat(cols[idx.index]),
      mark: parseFloat(cols[idx.mark]),
      last: parseFloat(cols[idx.last]),
    });
  }
  return ticks;
}

function traces(ticks: Tick[]): string {
  const series: Array<[string, string, string]> = [
    ['ask', 'Ask', '#d62728'],
    ['bid', 'Bid', '#2ca02c'],
    ['index', 'Index', '#ff7f0e'],
    ['mark', 'Mark', '#1f77b4'],
    ['last', 'Last', '#9467bd'],
  ];
  const times = ticks.map((t) => t.time);
  return (
    '[\n' +
    series
      .map(
        ([key, name, color]) => `  {
    name: ${JSON.stringify(name)},
    type: 'scatter',
    mode: 'lines',
    x: ${JSON.stringify(times)},
    y: ${JSON.stringify(ticks.map((t) => t[key as keyof Tick]))},
    line: { color: '${color}', width: 1.5 },
    hovertemplate: '%{x|%H:%M:%S}<br>${name}: %{y:.2f}<extra></extra>'
  }`
      )
      .join(',\n') +
    '\n]'
  );
}

function buildHtml(ticks: Tick[]): string {
  const plotlySrc = existsSync(PLOTLY_LOCAL)
    ? 'vendor/plotly.min.js'
    : 'https://cdn.plot.ly/plotly-2.35.2.min.js';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ticker.csv — Plotly graph</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #111; color: #ddd;
               font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  #wrap { height: 100vh; display: flex; flex-direction: column; }
  #header { padding: 10px 16px; border-bottom: 1px solid #333; display: flex;
            align-items: baseline; gap: 12px; flex-wrap: wrap; }
  #header h1 { font-size: 15px; margin: 0; color: #fff; }
  #header .meta { font-size: 12px; color: #999; }
  #chart { flex: 1; min-height: 0; }
</style>
</head>
<body>
<div id="wrap">
  <div id="header">
    <h1>ticker.csv</h1>
    <span class="meta" id="meta"></span>
  </div>
  <div id="chart"></div>
</div>
<script src="${plotlySrc}"></script>
<script>
  if (typeof Plotly === 'undefined') {
    document.write('<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"><\\/script>');
  }
</script>
<script>
  const data = ${traces(ticks)};
  const layout = {
    paper_bgcolor: '#111',
    plot_bgcolor: '#111',
    font: { color: '#ddd', size: 12 },
    margin: { l: 60, r: 20, t: 30, b: 50 },
    xaxis: {
      type: 'date',
      tickformat: '%H:%M:%S',
      rangeslider: { visible: true, thickness: 0.06 },
      showgrid: true,
      gridcolor: '#2a2a2a',
      zeroline: false
    },
    yaxis: {
      title: { text: 'Price' },
      gridcolor: '#2a2a2a',
      zeroline: false
    },
    hovermode: 'x unified',
    legend: { orientation: 'h', y: 1.12, x: 0 },
    showlegend: true
  };
  const config = { responsive: true, displaylogo: false };
  Plotly.newPlot('chart', data, layout, config);
  const rows = data[0].x.length;
  const range = (key) => {
    const ys = data.find((d) => d.name === key).y;
    return Math.min(...ys).toFixed(2) + ' – ' + Math.max(...ys).toFixed(2);
  };
  document.getElementById('meta').textContent =
    rows + ' ticks · ' + data[0].x[0].slice(11) + ' → ' + data[0].x[rows - 1].slice(11) +
    ' · ask ' + range('Ask') + ' · bid ' + range('Bid') + ' · index ' + range('Index') +
    ' · mark ' + range('Mark') + ' · last ' + range('Last');
</script>
</body>
</html>
`;
}

function main(): void {
  if (!existsSync(CSV_PATH)) {
    console.error(`Cannot find ${CSV_PATH} — run the recorder first or pass the file path.`);
    process.exit(1);
  }
  const ticks = parseCsv(readFileSync(CSV_PATH, 'utf8'));
  writeFileSync(HTML_PATH, buildHtml(ticks), 'utf8');
  console.log(`Wrote ${HTML_PATH} (${ticks.length} ticks)`);
}

main();
