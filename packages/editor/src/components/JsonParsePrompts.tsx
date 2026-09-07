/** 浮在積木上方的一鍵「解析 JSON」提示。 */
import { useEffect, useRef, useState } from 'react';
import type * as Blockly from 'blockly/core';
import {
  jsonParseCandidates,
  wrapJsonText,
  type JsonParseCandidate,
} from '../blockly/jsonParse';
import type { ConversionContext } from '../ir/context';
import { blockRect } from '../run/decorate';
import { t } from '../i18n';

interface Props {
  workspace: Blockly.WorkspaceSvg | null;
  ctx: ConversionContext;
}

/** 先完整停留三秒，再用 400ms 淡出。 */
const PROMPT_HOLD_MS = 3000;
const PROMPT_FADE_MS = 400;

interface Prompt extends JsonParseCandidate {
  removeAt: number;
}

export function JsonParsePrompts({ workspace, ctx }: Props) {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const hovered = useRef<string | null>(null);
  // 一份 JSON 淡出後，不可因為畫布捲動或別顆積木改變就重新冒出來。內容先變成
  // 無效、或換成另一份 JSON，這筆才失效。
  const suppressed = useRef(new Map<string, string>());

  useEffect(() => {
    if (!workspace) {
      setPrompts([]);
      suppressed.current.clear();
      return;
    }
    const refresh = () => {
      const next = jsonParseCandidates(workspace, ctx);
      const present = new Set(next.map((candidate) => candidate.shadowId));
      for (const shadowId of suppressed.current.keys()) {
        // 這格曾經離開「合法 JSON」狀態；下次再打成合法時可以重新提醒。
        if (!present.has(shadowId)) suppressed.current.delete(shadowId);
      }

      setPrompts((old) => {
        const before = new Map(old.map((prompt) => [promptKey(prompt), prompt]));
        const now = performance.now();
        const fresh = next.flatMap((candidate): Prompt[] => {
          const previous = before.get(promptKey(candidate));
          if (previous) return [previous];
          if (suppressed.current.get(candidate.shadowId) === candidate.text) return [];
          return [{ ...candidate, removeAt: now + PROMPT_HOLD_MS + PROMPT_FADE_MS }];
        });
        return samePrompts(old, fresh) ? old : fresh;
      });
    };
    refresh();
    const changed = (event: Blockly.Events.Abstract) => {
      if (!event.isUiEvent) refresh();
    };
    workspace.addChangeListener(changed);
    return () => workspace.removeChangeListener(changed);
  }, [workspace, ctx]);

  // rAF 負責淡出，這裡在動畫結束後才真的移除 DOM，並記住同一份內容不要重播。
  useEffect(() => {
    if (prompts.length === 0) return;
    const next = Math.min(...prompts.map((prompt) => prompt.removeAt));
    const timer = window.setTimeout(() => {
      const now = performance.now();
      setPrompts((old) => old.filter((prompt) => {
        if (prompt.removeAt > now) return true;
        suppressed.current.set(prompt.shadowId, prompt.text);
        return false;
      }));
    }, Math.max(0, next - performance.now()));
    return () => window.clearTimeout(timer);
  }, [prompts]);

  // 使用 DOM 實測座標，縮放、捲動與拖曳時提示都會跟著積木。
  useEffect(() => {
    if (!workspace || prompts.length === 0) return;
    let raf = 0;
    const tick = () => {
      for (const candidate of prompts) {
        const key = promptKey(candidate);
        const node = nodes.current.get(key);
        const rect = blockRect(workspace, candidate.blockId);
        const shadow = workspace.getBlockById(candidate.shadowId) as Blockly.BlockSvg | null;
        const inputRect = shadow?.getSvgRoot().getBoundingClientRect();
        if (!node || !rect || !inputRect) continue;
        const now = performance.now();
        // 跟執行結果氣泡相同：hover 時持續把期限往後推。移開後因此會重新拿到
        // 完整三秒，不會在游標剛離開按鈕時立刻消失。
        if (hovered.current === key) {
          candidate.removeAt = now + PROMPT_HOLD_MS + PROMPT_FADE_MS;
        }
        node.style.visibility = 'visible';
        const left = candidate.removeAt - now;
        node.style.opacity = left < PROMPT_FADE_MS
          ? String(Math.max(0, left) / PROMPT_FADE_MS)
          : '1';
        // 垂直在整顆積木外面，水平方向則指向實際的 JSON 輸入格；同一顆積木有
        // 兩個容器孔時，兩顆提示才不會完全疊在一起。
        node.style.transform = `translate(${inputRect.left + inputRect.width / 2}px, ${rect.top}px)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [workspace, prompts]);

  return (
    <div className="json-parse-prompt-layer">
      {prompts.map((candidate) => (
        <div
          key={promptKey(candidate)}
          ref={(node) => {
            const key = promptKey(candidate);
            if (node) nodes.current.set(key, node);
            else nodes.current.delete(key);
          }}
          className="json-parse-prompt"
          style={{ visibility: 'hidden' }}
          onMouseEnter={() => { hovered.current = promptKey(candidate); }}
          onMouseLeave={() => {
            if (hovered.current === promptKey(candidate)) hovered.current = null;
          }}
        >
          <button
            type="button"
            onClick={() => {
              const shadow = workspace?.getBlockById(candidate.shadowId);
              if (shadow) wrapJsonText(shadow, candidate.expected);
            }}
          >
            {t('json.parse')}
          </button>
        </div>
      ))}
    </div>
  );
}

function promptKey(candidate: JsonParseCandidate): string {
  return `${candidate.shadowId}\u0000${candidate.text}`;
}

function samePrompts(a: Prompt[], b: Prompt[]): boolean {
  return a.length === b.length && a.every((x, i) => {
    const y = b[i];
    return y !== undefined
      && x.blockId === y.blockId
      && x.shadowId === y.shadowId
      && x.inputName === y.inputName
      && x.expected === y.expected
      && x.text === y.text
      && x.removeAt === y.removeAt;
  });
}
