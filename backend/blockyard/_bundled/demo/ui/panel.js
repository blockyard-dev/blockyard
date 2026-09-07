// 示範面板：把收到的每一則訊息印出來。
//
// 受信任的 HTML 面板；使用 v1 訊息協定接收執行結果。
const out = document.getElementById('out');
const english = new URLSearchParams(location.search).get('lang') === 'en';
document.title = english ? 'Demo panel' : '示範面板';
out.textContent = english ? 'No messages yet.' : '還沒收到訊息。';
const lines = [];

window.addEventListener('message', (e) => {
  // 只接收這個面板的宿主視窗送來的訊息。
  if (e.source !== window.parent) return;
  lines.push(JSON.stringify(e.data));
  out.textContent = lines.join('\n');
});

// 沒有這一則，編輯器不知道什麼時候可以開始送——iframe 的載入是非同步的，
// 早送的東西會掉在地上。
window.parent.postMessage({ v: 1, type: 'ready' }, '*');
