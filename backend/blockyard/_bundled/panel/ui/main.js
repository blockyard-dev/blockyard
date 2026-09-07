/**
 * 面板的入口：接編輯器的訊息，畫成東西。
 *
 * ## 協定
 *
 * 編輯器**一個字都不解讀** payload——它只負責把 `ctx.send_panel()` 送的東西
 * 原樣 postMessage 過來，順序不動。所以下面這幾種訊息是**這個包自己定的**：
 *
 *     {type: 'line',  values: [1, 2, 3]}     整串換掉（序號當 x）
 *     {type: 'point', x, y}                  加一個點（累加）
 *     {type: 'clear'}                        清空
 *     {type: 'stat',  name, value}           一張數值卡
 *     {type: 'table', columns, rows}         一張表
 *
 * ## 重播
 *
 * 編輯器留著這次 Run 的全部訊息，面板重掛（換分頁、彈出視窗）時**從頭重播**。
 * 所以每一則訊息都要能「從空的開始重播得出同一張畫面」——`point` 可以，
 * 「把畫面往右捲 10px」不行。這是寫包的人的合約，不是編輯器保證得了的事。
 */
import { createChart } from './chart.js';

const english = new URLSearchParams(location.search).get('lang') === 'en';
document.title = english ? 'Panel' : '面板';
document.getElementById('hint').textContent = english
  ? 'Drag with two fingers to pan · Pinch or ⌘+wheel to zoom · Double-click to reset'
  : '兩指拖曳平移 · 捏合或 ⌘滾輪縮放 · 雙擊回到自動';

const chart = createChart(document.getElementById('canvas'));
const statsEl = document.getElementById('stats');
const tableWrap = document.getElementById('table-wrap');
const tableEl = document.getElementById('table');

/** 數值卡是**具名**的：同一個名字送第二次是換掉它，不是再長一張。 */
const stats = new Map();

function renderStats() {
  statsEl.hidden = stats.size === 0;
  statsEl.replaceChildren(
    ...[...stats].map(([name, value]) => {
      const box = document.createElement('div');
      box.className = 'stat';
      const n = document.createElement('span');
      n.className = 'stat-name';
      n.textContent = name;
      const v = document.createElement('span');
      v.className = 'stat-value';
      // `textContent` 而不是 `innerHTML`：值來自使用者的畫布，而這一頁的 CSP
      // 擋得住外連、擋不住「把一段 HTML 塞進自己的 DOM」。
      v.textContent = value;
      v.title = value;
      box.append(n, v);
      return box;
    }),
  );
}

function renderTable(columns, rows) {
  tableWrap.hidden = rows.length === 0;
  const head = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const c of columns) {
    const th = document.createElement('th');
    th.textContent = c;
    hr.append(th);
  }
  head.append(hr);
  const body = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const c of columns) {
      const td = document.createElement('td');
      // 缺的那一格畫空白：欄位是所有列的聯集，缺格是正常的資料不是錯誤。
      td.textContent = row[c] ?? '';
      tr.append(td);
    }
    body.append(tr);
  }
  tableEl.replaceChildren(head, body);
}

function apply(msg) {
  switch (msg?.type) {
    case 'line':
      chart.setSeries(msg.values ?? []);
      break;
    case 'point':
      chart.addPoint(msg.x, msg.y);
      break;
    case 'clear':
      chart.clear();
      break;
    case 'stat':
      stats.set(String(msg.name), String(msg.value));
      renderStats();
      break;
    case 'table':
      renderTable(msg.columns ?? [], msg.rows ?? []);
      break;
    default:
      // 認不得就跳過。編輯器不驗 payload，所以這裡是唯一會看到它的地方——
      // 而一個打錯字的 type 應該是「那一則沒作用」，不是整個面板停掉。
      break;
  }
}

window.addEventListener('message', (e) => {
  // 只接收這個面板的宿主視窗送來的訊息。
  if (e.source !== window.parent) return;
  const data = e.data;
  if (data?.v !== 1) return;
  if (data.type === 'message') apply(data.payload);
});

// 沒有這一則，編輯器不知道什麼時候可以開始送——iframe 的載入是非同步的，
// 早送的東西會掉在地上。它同時是重播的觸發點。
window.parent.postMessage({ v: 1, type: 'ready' }, '*');
