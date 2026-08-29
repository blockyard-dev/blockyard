/**
 * 擴充功能入口（§8.1）。Scratch 放「添加擴展」的那個位置：工具箱的左下角。
 *
 * P1 才接得上安裝流程（§7、§12.1 的審閱確認），**但位置現在就留著**：它是
 * 「新增積木包」唯一的入口，等到有東西可裝再找地方擺，多半會擺成一個藏在
 * 設定裡的分頁，那等於把整個擴充系統藏起來。
 *
 * 現在點開列的是**已載入的命名空間**——那份資料 `GET /api/extensions` 本來就
 * 給了（§8.1 第 1 步，含內建）。列一份真的清單比留一個空面板誠實：使用者至少
 * 知道「這裡管的是積木包」，而不是「這個按鈕壞了」。
 */
import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { ToolboxGroup } from '../blockly/toolbox';

export function ExtensionsEntry({ groups }: { groups: ToolboxGroup[] }) {
  const [open, setOpen] = useState(false);
  const installed = groups.filter((g) => !g.builtin);

  return (
    <div className="ext-entry">
      {open && (
        <div className="ext-panel" role="dialog" aria-label="積木包">
          <h2>積木包</h2>
          <ul className="ext-list">
            {groups.map((group) => (
              <li key={group.id}>
                <span className="ext-dot" style={{ background: group.colour }} />
                <span className="ext-name">{group.name}</span>
                <span className="ext-meta">
                  {group.builtin ? '內建' : (group.blocks[0]?.manifest.version ?? '')} ·{' '}
                  {group.blocks.length} 顆
                </span>
              </li>
            ))}
          </ul>
          <button type="button" className="button" disabled>
            <Plus size={14} strokeWidth={2.5} /> 安裝積木包…
          </button>
          <p className="ext-note">
            安裝與設定要等積木包的 Host 接上（P1）。目前有 {installed.length} 個第三方積木包。
          </p>
        </div>
      )}
      {/* 只有一個加號，沒有文字：分類欄是 60px 寬（`index.css`），帶文字的按鈕
          會同時蓋掉最後一個分類與 flyout 左邊那一條積木。文字由 title 與
          aria-label 交代。 */}
      <button
        type="button"
        className="ext-button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="積木包"
        title="積木包"
      >
        <span className="ext-button-icon">
          <Plus size={20} strokeWidth={2.5} />
        </span>
      </button>
    </div>
  );
}
