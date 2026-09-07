/**
 * §8.3：object / list 的值氣泡是**可展開的 JSON tree，不是截斷字串**。
 *
 * 這不是裝飾。§8.5 說「型別提示用警告不用形狀」，代價是畫面上看不出一顆
 * reporter 回的是文字還是物件——值氣泡是補回那個資訊的地方，也是設計文件說的
 * 「最有效的型別防呆」。所以 `"{\"a\":1}"`（文字）與 `{a: 1}`（物件）在這裡
 * 必須長得不一樣：前者有引號、是一行；後者可以展開。
 */
import { useState } from 'react';
import { t } from '../i18n';

interface Props {
  value: unknown;
  /** 巢狀深度。前兩層預設展開，再深就收起來——不然一份 API 回應會塞滿畫面。 */
  depth?: number;
}

export function JsonTree({ value, depth = 0 }: Props) {
  if (Array.isArray(value)) {
    return <Branch entries={value.map((v, i) => [String(i + 1), v])} open="[" close="]" depth={depth} />;
  }
  if (value !== null && typeof value === 'object') {
    return <Branch entries={Object.entries(value as Record<string, unknown>)} open="{" close="}" depth={depth} />;
  }
  return <Scalar value={value} />;
}

function Scalar({ value }: { value: unknown }) {
  if (typeof value === 'string') return <span className="json-string">&quot;{value}&quot;</span>;
  if (typeof value === 'number') return <span className="json-number">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="json-boolean">{value ? t('json.true') : t('json.false')}</span>;
  if (value === null) return <span className="json-null">{t('json.null')}</span>;
  if (value === undefined) return <span className="json-null">—</span>;
  return <span>{String(value)}</span>;
}

function Branch({
  entries,
  open,
  close,
  depth,
}: {
  entries: [string, unknown][];
  open: string;
  close: string;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2);

  if (entries.length === 0) {
    return (
      <span className="json-punct">
        {open}
        {close}
      </span>
    );
  }

  if (!expanded) {
    return (
      <button type="button" className="json-toggle" onClick={() => setExpanded(true)}>
        {open}⋯{close} <span className="json-count">{entries.length}</span>
      </button>
    );
  }

  return (
    <span className="json-branch">
      <button type="button" className="json-toggle" onClick={() => setExpanded(false)}>
        {open}
      </button>
      <ul className="json-entries">
        {entries.map(([key, child]) => (
          <li key={key}>
            <span className="json-key">{key}</span>
            <span className="json-punct">：</span>
            <JsonTree value={child} depth={depth + 1} />
          </li>
        ))}
      </ul>
      <span className="json-punct">{close}</span>
    </span>
  );
}
