import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `blocky serve` 綁 8787（backend/blocky/cli.py）。dev server 代理過去，讓前端
// 在開發與打包後走同一組相對路徑 —— fetch('/api/extensions') 兩邊都對。
//
// Blockly 的 media 由 `scripts/copy-media.mjs` 放進 `public/`（見那支腳本），
// 所以這裡不需要任何複製設定。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  build: { outDir: 'dist', sourcemap: true },
});
