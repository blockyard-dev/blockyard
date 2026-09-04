// 示範面板：把收到的每一則訊息印出來。
//
// **它是積木包自己的 JS**，跑在一個 sandbox iframe 裡（opaque origin）：碰不到
// 編輯器的 DOM、localStorage 會 throw、fetch 打後端會被擋。唯一的通道是
// postMessage，而 `event.origin` 在這裡永遠是 "null"，所以認人要靠別的。
const out = document.getElementById('out');
const lines = [];

window.addEventListener('message', (e) => {
  // 只認 opener（編輯器）。sandbox 的 origin 是 "null"，比對它等於沒比對。
  if (e.source !== window.parent) return;
  lines.push(JSON.stringify(e.data));
  out.textContent = lines.join('\n');
});

// 沒有這一則，編輯器不知道什麼時候可以開始送——iframe 的載入是非同步的，
// 早送的東西會掉在地上。
window.parent.postMessage({ v: 1, type: 'ready' }, '*');
