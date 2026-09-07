/**
 * 容器孔裡的 JSON 文字 → 一顆明確的「解析 JSON」積木。
 *
 * 偵測與畫提示分開：這裡只處理 Blockly/manifest 資料，浮在積木上方的 React
 * 介面在 `components/JsonParsePrompts.tsx`。因此提示不是積木定義的一部分，不會
 * 改變積木寬度、序列化內容或「仍可直接接 object/list reporter」的能力。
 */
import * as Blockly from 'blockly/core';
import { SHADOW_FIELD, shadowKindOf } from './define';
import { argSpecOf } from './repeat';
import type { ConversionContext } from '../ir/context';

const PARSE_TYPE = 'object.parse_json';
const PARSE_INPUT = 'text';

export type JsonContainerType = 'list' | 'object' | 'json';

export interface JsonParseCandidate {
  /** 浮動提示對齊的外層積木。 */
  blockId: string;
  /** 裝著使用者原始文字的影子。 */
  shadowId: string;
  inputName: string;
  expected: JsonContainerType;
  /** 同一格改成另一份 JSON 時，要視為一個新的提示。 */
  text: string;
}

/** 只接受 JSON 容器；`json` 參數在後端邊界上的語意也是「物件或清單」。 */
export function matchesJsonContainer(text: string, expected: JsonContainerType): boolean {
  try {
    const value: unknown = JSON.parse(text);
    if (expected === 'list') return Array.isArray(value);
    if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    return value !== null && typeof value === 'object';
  } catch {
    return false;
  }
}

/** 找出畫布上所有「已打成合法 JSON、尚未解析」的容器孔。 */
export function jsonParseCandidates(
  workspace: Blockly.Workspace,
  ctx: ConversionContext,
): JsonParseCandidate[] {
  const out: JsonParseCandidate[] = [];
  for (const block of workspace.getAllBlocks(false)) {
    if (block.isShadow() || block.isInFlyout) continue;
    const spec = ctx.blockOf(block.type)?.spec;
    if (!spec) continue;

    for (const input of block.inputList) {
      const type = argSpecOf(spec, input.name)?.type;
      if (type !== 'list' && type !== 'object' && type !== 'json') continue;
      const shadow = input.connection?.targetBlock();
      if (!shadow?.isShadow() || shadowKindOf(shadow.type) !== 'text') continue;
      const raw = String(shadow.getFieldValue(SHADOW_FIELD) ?? '');
      if (!matchesJsonContainer(raw, type)) continue;
      out.push({
        blockId: block.id,
        shadowId: shadow.id,
        inputName: input.name,
        expected: type,
        text: raw,
      });
    }
  }
  return out;
}

/**
 * 把文字影子換成 `解析 JSON (原文字)`。
 *
 * 先在新 reporter 的文字孔建立影子，再把 reporter 接進原孔。Blockly 會在實體
 * reporter 蓋上來時收掉原本的文字影子；文字已複製到內層，所以不會遺失。
 */
export function wrapJsonText(shadow: Blockly.Block, expected: JsonContainerType): Blockly.Block | null {
  const raw = String(shadow.getFieldValue(SHADOW_FIELD) ?? '');
  const parentConnection = shadow.outputConnection?.targetConnection;
  if (!parentConnection || !matchesJsonContainer(raw, expected) || !Blockly.Blocks[PARSE_TYPE]) {
    return null;
  }

  Blockly.Events.setGroup(true);
  try {
    const parser = shadow.workspace.newBlock(PARSE_TYPE);
    const inputConnection = parser.getInput(PARSE_INPUT)?.connection;
    if (!parser.outputConnection || !inputConnection) {
      parser.dispose(false);
      return null;
    }
    inputConnection.setShadowState({
      type: 'blockyard.shadow.text',
      fields: { [SHADOW_FIELD]: raw },
    });
    parentConnection.connect(parser.outputConnection);

    const svg = parser as Blockly.BlockSvg;
    svg.initSvg?.();
    svg.render?.();
    return parser;
  } finally {
    Blockly.Events.setGroup(false);
  }
}
