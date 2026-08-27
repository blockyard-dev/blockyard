/**
 * 後端 API 客戶端（附錄 A）。
 *
 * 路徑一律相對：開發時 Vite 代理到 127.0.0.1:8787（`vite.config.ts`），打包後
 * 前端由同一個 process 提供（`api/app.py` 的 StaticFiles），兩邊都對。
 */
import type { Manifest } from '../types/manifest';

export async function fetchExtensions(signal?: AbortSignal): Promise<Manifest[]> {
  const res = await fetch('/api/extensions', { signal });
  if (!res.ok) {
    throw new Error(`GET /api/extensions → ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as Manifest[];
}
