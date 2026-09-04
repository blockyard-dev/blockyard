import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `blockyard serve` 綁 8787（backend/blockyard/cli.py）。dev server 代理過去，讓前端
// 在開發與打包後走同一組相對路徑 —— fetch('/api/extensions') 兩邊都對。
//
// `BLOCKYARD_BACKEND` 換掉代理的目標。用途是**同時開兩份**：一份是自己在用的
// 編輯器（真的專案資料），一份是正在改的那份（丟得掉的 DB）。沒有它的話，
// 驗證一個改動就得先把自己正在用的那份關掉。
//
// Blockly 的 media 由 `scripts/copy-media.mjs` 放進 `public/`（見那支腳本），
// 所以這裡不需要任何複製設定。
const backend = process.env.BLOCKYARD_BACKEND ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      // §6.1 的事件流。`ws: true` 少一個，執行按鈕就會安靜地連不上——
      // dev server 會把 upgrade 請求當成一般 HTTP 打回 404。
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
      // §9.3 的 webhook 進入點。**不在 `/api` 底下**（它是給外面打的位址，
      // 不是編輯器的 API），所以上面那條蓋不到它。
      //
      // 少了這一條的症狀很難查：webhook 面板給的網址是用**這個分頁的來源**
      // 組出來的（打包後前後端同一個 process，那是對的），所以 dev 下複製到的
      // 是 `http://localhost:5173/hooks/…`——而 5173 上根本沒有那條路徑，
      // 打過去是 404。後端明明好好的，看起來卻像 webhook 壞了。
      '/hooks': backend,
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
