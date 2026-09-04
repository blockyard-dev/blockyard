/**
 * 互動折線圖：canvas + 平移／縮放／自動適應。
 *
 * **這是積木包自己的程式碼**，不是編輯器的。編輯器只給這個包一格 sandbox 的
 * iframe，裡面畫什麼、怎麼畫、要不要換成 three.js，都是這裡的事。
 *
 * 一個引擎、兩種資料形狀：`line` 是一串數字（序號 → 值），`point` 是一串
 * [x, y]。兩者在這裡都變成 `[x, y][]`，所以縮放、格線、自動適應只寫一次。
 */

/** 拖曳／縮放追上目標值的速度。每幀補上剩餘距離的這個比例。 */
const LERP = 0.25;
/** 座標軸上大約幾格。實際格數由 `niceStep` 湊成 1／2／5 的整數倍。 */
const TICKS = 6;
/** 自動適應時上下左右各留的空白比例。貼著邊界的線會被裁掉一半。 */
const PAD = 0.12;

/** 讓刻度落在 1／2／5 的整數倍上。 */
export function niceStep(range, ticks) {
  if (!(range > 0)) return 1;
  const raw = range / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm > 7.5 ? 10 : norm > 3.5 ? 5 : norm > 1.5 ? 2 : 1;
  return step * mag;
}

/** 資料的外框，加上留白。空資料給一個看得出是空的框，而不是 NaN。 */
export function fitBox(points) {
  if (points.length === 0) return { minX: 0, maxX: 1, minY: 0, maxY: 1 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  // 一條水平線（或單一個點）的 span 是 0，除下去是 NaN——而「十個一樣的值」
  // 是完全合理的資料。給它一個固定高度的框，線落在正中間。
  const padX = maxX === minX ? Math.max(Math.abs(maxX) * PAD, 0.5) : (maxX - minX) * PAD;
  const padY = maxY === minY ? Math.max(Math.abs(maxY) * PAD, 0.5) : (maxY - minY) * PAD;
  return { minX: minX - padX, maxX: maxX + padX, minY: minY - padY, maxY: maxY + padY };
}

/** 軸標籤。位數跟著格距走，不然 0.1 的格會全部顯示成 0。 */
function label(v, step) {
  const digits = Math.max(0, Math.min(6, -Math.floor(Math.log10(step))));
  return v.toFixed(digits);
}

export function createChart(canvas) {
  const ctx = canvas.getContext('2d');
  let points = [];
  let width = 0;
  let height = 0;
  // 使用者拖過或縮過之後就不再自動適應——不然新的一個點會把畫面拉回去，而他
  // 正在看的正是自己捲到的那個位置。雙擊還原。
  let autoFit = true;
  let view = null;
  let target = null;

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    // `setTransform` 而不是 `scale`：後者是累加的，每次 resize 都會再乘一次。
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  const toScreen = (v, x, y) => ({
    x: ((x - v.minX) / (v.maxX - v.minX)) * width,
    y: height - ((y - v.minY) / (v.maxY - v.minY)) * height,
  });
  const toData = (v, sx, sy) => ({
    x: v.minX + (sx / width) * (v.maxX - v.minX),
    y: v.minY + ((height - sy) / height) * (v.maxY - v.minY),
  });

  /* ----------------------------------------------------------------
   * 手勢
   *
   * **`target` 與 `view` 一起動，不經過 lerp。** 手勢要當場跟手——lerp 是給
   * 自動適應那條路用的（資料變了、框跟著平滑地追過去）。捏合時走 lerp 的話，
   * 手指停住了畫面還在慢慢追，那正是「不順」的來源。
   * ---------------------------------------------------------------- */

  /** 平移：螢幕上位移幾個像素。 */
  const panBy = (dxPx, dyPx) => {
    if (!target || !view) return;
    const dx = (dxPx / width) * (view.maxX - view.minX);
    const dy = (dyPx / height) * (view.maxY - view.minY);
    for (const box of [target, view]) {
      box.minX -= dx; box.maxX -= dx;
      box.minY += dy; box.maxY += dy;
    }
  };

  /** 以畫布上的某一點為錨點縮放。那一點在縮放前後停在原地。 */
  const zoomAt = (px, py, k) => {
    if (!target || !view) return;
    const at = toData(view, px, py);
    for (const box of [target, view]) {
      box.minX = at.x + (box.minX - at.x) * k;
      box.maxX = at.x + (box.maxX - at.x) * k;
      box.minY = at.y + (box.minY - at.y) * k;
      box.maxY = at.y + (box.maxY - at.y) * k;
    }
  };

  /**
   * 按著的每一根手指／滑鼠。
   *
   * **兩根以上就是手勢**：中心點的位移是平移，兩指距離的比例是縮放，錨點就是
   * 那個中心點——這兩件事同時發生（一邊捏一邊挪是同一個動作，拆成兩個模式會
   * 讓它一頓一頓的）。
   *
   * 這條路是**觸控螢幕**的。觸控板不走這裡：瀏覽器不會把觸控板上的兩根手指
   * 當成兩個 pointer（那塊板子不是頁面的觸控表面），它送的是 `wheel`——見下面
   * 那一段。
   */
  const pointers = new Map();
  let gesture = null;

  const midpoint = () => {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  const beginGesture = () => {
    gesture = pointers.size >= 2 ? midpoint() : null;
  };

  canvas.addEventListener('pointerdown', (e) => {
    autoFit = false;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    beginGesture();
  });

  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const now = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, now);

    if (pointers.size >= 2) {
      if (!gesture) return beginGesture();
      const next = midpoint();
      panBy(next.x - gesture.x, next.y - gesture.y);
      // 距離是 0 的那一瞬間（兩指疊在一起）除下去是 Infinity。跳過那一幀，
      // 下一幀就正常了——比夾一個下限誠實，那個下限會讓縮放在極近距離變鈍。
      if (gesture.d > 0 && next.d > 0) {
        const rect = canvas.getBoundingClientRect();
        // `gesture.d / next.d`：手指拉開（next 變大）→ k < 1 → 視窗變小 → 放大。
        zoomAt(next.x - rect.left, next.y - rect.top, gesture.d / next.d);
      }
      gesture = next;
      return;
    }

    panBy(now.x - prev.x, now.y - prev.y);
  });

  const release = (e) => {
    pointers.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    // 剩一根手指時要**重新取基準**，不然那根手指會被當成「中心點瞬間跳到這裡」
    // 而畫面猛地一彈。
    beginGesture();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  /**
   * 觸控板與滑鼠：`wheel`。
   *
   * **觸控板上的兩根手指不會變成兩個 pointer**——那塊板子不是頁面的觸控表面，
   * 瀏覽器不告訴我們手指在哪裡。所以上面那套「中心點 + 兩指距離」在觸控板上
   * 沒有輸入可以算，它是給觸控螢幕的。觸控板拿到的是同一件事的**已經算好的
   * 結果**：
   *
   *   兩指拖曳 → `wheel`，帶 deltaX/deltaY（就是中心點的位移）  → 平移
   *   捏合     → `wheel`，瀏覽器合成 **ctrlKey: true**，deltaY  → 縮放
   *              （那個 deltaY 就是瀏覽器從兩指距離變化算出來的）
   *   滑鼠滾輪 → 沒有 ctrlKey                                   → 平移
   *   ⌘/Ctrl + 滾輪 → 有 ctrlKey                                → 縮放
   *
   * **捏合送 ctrlKey 是瀏覽器的既有約定**，不是我們發明的——所以這一條同時接住
   * 觸控板與「⌘＋滾輪」，不必嗅探裝置（`deltaY` 是不是整數、有多大，那些都只是
   * 猜，而嗅探正是 D24／D27 一路在避免的事）。
   *
   * 代價：只有滑鼠的人要按著 ⌘ 才縮放。這是 Figma 那一派的取捨，換到的是觸控板
   * 上兩指拖曳就是平移——而那是這個面板最常見的動作。
   */
  canvas.addEventListener('wheel', (e) => {
    if (!target || !view) return;
    e.preventDefault();
    autoFit = false;
    // `deltaMode` 1 = 行、2 = 頁。不換算的話，設成「以行捲動」的滑鼠一格會
    // 只挪一個像素，看起來像沒反應。
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? height : 1;
    const rect = canvas.getBoundingClientRect();

    if (e.ctrlKey || e.metaKey) {
      // `exp` 而不是「大於零就乘 1.12」：捏合送過來的是一連串**很小**的 deltaY，
      // 而固定倍率會讓每一格都是同樣大的一跳——推得慢跟推得快感覺一樣。指數
      // 曲線讓縮放正比於手指走的距離，而且放大縮小天生對稱
      // （`exp(d) * exp(-d) === 1`，來回捏一次會回到原點）。
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp((e.deltaY * unit) / 300));
      // **同一則事件裡的橫向位移也要用掉。** 純捏合的 `deltaX` 是 0，所以這一行
      // 平常什麼都不做；但瀏覽器如果在一次兩指動作裡同時給了縮放與橫移，早一步
      // `return` 就等於把那一半丟掉。
      //
      // 「邊移動邊縮放」在觸控板上做不做得到**不由這裡決定**：macOS 會把一次
      // 兩指動作分類成「捲動」或「放大」，只送其中一種事件流。我們這邊
      // `panBy`／`zoomAt` 都直接改 `view`，兩種事件交錯到達就會自然疊加——是它們
      // 本來就不會同時到。（觸控螢幕沒有這個限制，見上面那段 pointer 的路。）
      if (e.deltaX) panBy(-e.deltaX * unit, 0);
      return;
    }

    // 平移。`deltaX/deltaY` 是內容要移動的方向，跟手指相反，所以是負號。
    panBy(-e.deltaX * unit, -e.deltaY * unit);
  }, { passive: false });

  canvas.addEventListener('dblclick', () => { autoFit = true; });

  const frame = () => {
    requestAnimationFrame(frame);
    if (autoFit || !target) target = fitBox(points);
    if (!view) view = { ...target };
    for (const key of ['minX', 'maxX', 'minY', 'maxY']) {
      view[key] += (target[key] - view[key]) * LERP;
    }

    const css = getComputedStyle(canvas);
    const ink = css.getPropertyValue('--chart-ink').trim() || '#2563eb';
    const grid = css.getPropertyValue('--chart-grid').trim() || '#f1f5f9';
    const axis = css.getPropertyValue('--chart-axis').trim() || '#cbd5e1';
    const text = css.getPropertyValue('--chart-text').trim() || '#94a3b8';

    ctx.clearRect(0, 0, width, height);

    const stepX = niceStep(view.maxX - view.minX, TICKS);
    const stepY = niceStep(view.maxY - view.minY, TICKS);
    ctx.lineWidth = 1;
    ctx.font = '10px system-ui, sans-serif';

    for (let x = Math.ceil(view.minX / stepX) * stepX; x <= view.maxX; x += stepX) {
      const p = toScreen(view, x, 0);
      ctx.strokeStyle = Math.abs(x) < stepX / 1e6 ? axis : grid;
      ctx.beginPath();
      ctx.moveTo(Math.round(p.x) + 0.5, 0);
      ctx.lineTo(Math.round(p.x) + 0.5, height);
      ctx.stroke();
      ctx.fillStyle = text;
      ctx.fillText(label(x, stepX), p.x + 3, height - 4);
    }
    for (let y = Math.ceil(view.minY / stepY) * stepY; y <= view.maxY; y += stepY) {
      const p = toScreen(view, 0, y);
      ctx.strokeStyle = Math.abs(y) < stepY / 1e6 ? axis : grid;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(p.y) + 0.5);
      ctx.lineTo(width, Math.round(p.y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = text;
      ctx.fillText(label(y, stepY), 4, p.y - 3);
    }

    if (points.length > 0) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      points.forEach(([dx, dy], i) => {
        const p = toScreen(view, dx, dy);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();

      // 點太多的時候不畫圓點：一千個 4px 的圓連成一條粗帶子，比不畫還糟。
      if (points.length <= 240) {
        for (const [dx, dy] of points) {
          const p = toScreen(view, dx, dy);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.stroke();
        }
      }
    }
  };
  requestAnimationFrame(frame);

  return {
    /** 整串換掉（一串數字 → 序號當 x）。 */
    setSeries(values) {
      points = values.map((v, i) => [i + 1, v]);
    },
    /** 加一個點。**累加**——畫到一半的圖看得見它長出來。 */
    addPoint(x, y) {
      points.push([x, y]);
    },
    clear() {
      points = [];
      autoFit = true;
    },
    get count() {
      return points.length;
    },
  };
}
