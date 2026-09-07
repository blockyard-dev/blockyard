/**
 * 擴充功能入口（§8.1）。Scratch 放「添加擴展」的那個位置：工具箱的左下角。
 *
 * 這個檔案只剩下**那一顆加號**：按下去開的是整頁的擴充功能面板
 * （`ExtensionsGallery`，D31）。原本點開的是一個 15rem 的小面板，列著已載入的
 * 命名空間——那是「還沒有安裝流程」時最誠實的做法（列一份真的清單，至少說得出
 * 「這裡管的是積木包」）。現在那份清單有地方去了，而且點得下去。
 */
import { Plus } from 'lucide-react';
import { useExtensionsUi } from './extensionsStore';
import { t } from '../i18n';

export function ExtensionsEntry() {
  const openGallery = useExtensionsUi((s) => s.openGallery);

  return (
    <div className="ext-entry">
      {/* 只有一個加號，沒有文字：分類欄是 60px 寬（`index.css`），帶文字的按鈕
          會同時蓋掉最後一個分類與 flyout 左邊那一條積木。文字由 title 與
          aria-label 交代。 */}
      <button
        type="button"
        className="ext-button"
        onClick={openGallery}
        aria-label={t('extensions.label')}
        title={t('extensions.label')}
      >
        <span className="ext-button-icon">
          <Plus size={20} strokeWidth={2.5} />
        </span>
      </button>
    </div>
  );
}
