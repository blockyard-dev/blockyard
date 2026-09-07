/**
 * 字面值的型別切換（§16 Q16）。
 *
 * **問題**：`data.set`、`operator.eq` 這類參數在 manifest 裡宣告成通用的
 * `type: string`——那句話說的是「這個孔用文字框編輯」，不是「這裡只能是字串」。
 * 但編輯器只給得出文字影子，於是打 `99` 存出去是 `"99"`，而布林與 `null` 根本
 * 沒有入口。`operator.eq` 想測「`"5"` 不等於 `5`」的時候，兩顆字面值會被同一份
 * 宣告套成同一種影子，量出的差異反而消失。
 *
 * **不採用的解法**：在 manifest 上補 `literalKinds` 之類的宣告。那是把猜測寫進
 * 宣告——沒有人知道 `data.set` 的 `value` 「應該」允許哪幾種，答案是「全部」，
 * 而全部就等於不用宣告。
 *
 * **採用的解法**（設計文件裡的候選 (a)）：**影子的型別跟著值走，再給一個右鍵
 * 切換**。讀的那一半（`deserialize.ts::buildShadowState`）從第 4 步就是這樣寫
 * 的——「宣告與值的型別不一致時一律信任值本身」——所以這一步只補了寫的那一半
 * 與切換的入口，來回自動是通的。
 *
 * 切換**保留看得懂的值**：`"12"` 切成數字是 12，`真` 切成文字是 `"true"`。
 * 轉換規則刻意與後端 §4.3 的 `to_string` / `to_number` 一致，不然「切過去再切
 * 回來」會變成另一個值，而使用者只是想換個型別。
 */
import * as Blockly from 'blockly/core';
import {
  BOOLEAN_TRUE,
  SHADOW_FIELD,
  isSwitchableShadow,
  shadowKindOf,
  type ShadowKind,
} from './define';
import { shadowStateFor } from '../ir/deserialize';
import { t } from '../i18n';

/** 選單上的字。順序就是選單裡的順序。 */
const labelOf = (kind: ShadowKind): string => ({
  text: t('blockly.literal.text'),
  number: t('blockly.literal.number'),
  boolean: t('blockly.literal.boolean'),
  null: t('blockly.literal.null'),
})[kind];

const ORDER: ShadowKind[] = ['text', 'number', 'boolean', 'null'];

/** 這一格現在是什麼值。切換時用來算新的值。 */
export function literalValueOf(shadow: Blockly.Block): unknown {
  const kind = shadowKindOf(shadow.type);
  if (kind === null || kind === 'null') return null;
  const raw = shadow.getFieldValue(SHADOW_FIELD);
  if (kind === 'boolean') return raw === BOOLEAN_TRUE;
  if (kind === 'number') return Number(raw ?? 0);
  return String(raw ?? '');
}

/**
 * 換型別時怎麼帶值過去。
 *
 * 與 §4.3 的轉換表對齊：`true → "true"`、`null → ""`、`"12" → 12`、
 * 轉不動的數字 → 0。**唯一與後端不同的是「轉不動」的處理**——後端會報錯，
 * 這裡不能報錯（使用者只是在選單上點了一下），所以退回 0 並保留原本的字串在
 * 使用者的腦子裡：他看得到那一格變成 0，可以直接改回去。
 */
export function coerceLiteral(value: unknown, kind: ShadowKind): unknown {
  switch (kind) {
    case 'null':
      return null;
    case 'number': {
      const n = Number(typeof value === 'boolean' ? (value ? 1 : 0) : value);
      return Number.isFinite(n) ? n : 0;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      // 文字：只有「看起來就是 true」的才算真。空字串與 "false" 是假，其餘
      // 一律真——與 §4.3 的 falsy 規則同一個方向。
      return value !== null && value !== '' && value !== 'false' && value !== '0';
    default:
      return value === null ? '' : String(value);
  }
}

/**
 * 把一顆字面值影子換成另一種型別。
 *
 * 換的是**孔上的影子**（`connection.setShadowState`），不是改欄位——影子的
 * Blockly type 就是它的型別（見 `define.ts::shadowKindOf`），型別變了就是換一顆。
 * 包在同一個 event group 裡，一次 undo 就退得回去。
 */
export function switchLiteralKind(shadow: Blockly.BlockSvg, kind: ShadowKind): void {
  const connection = shadow.outputConnection?.targetConnection;
  if (!connection) return;
  const next = shadowStateFor(kind, coerceLiteral(literalValueOf(shadow), kind));

  Blockly.Events.setGroup(true);
  try {
    connection.setShadowState(next as Blockly.serialization.blocks.State);
  } finally {
    Blockly.Events.setGroup(false);
  }
}

/**
 * 被右鍵點到的那顆影子。
 *
 * 與 `FieldText` 的右鍵項目同一招（見那裡的說明）：`ContextMenuRegistry` 的
 * scope 只給得出積木，但 `preconditionFn` 拿得到開啟選單的原始事件。影子的選單
 * 開在**父積木**上（Blockly 的 `Gesture.setTargetBlock`），所以要連子孫一起找。
 *
 * 這個選單**不能只掛在 `FieldText` 上**：空值影子只有一個標籤，沒有任何欄位，
 * 而它正是最需要換回別的型別的那一種。
 */
let clickedShadow: Blockly.BlockSvg | null = null;

function shadowAt(scope: { block?: Blockly.BlockSvg }, event: Event): Blockly.BlockSvg | null {
  const block = scope.block;
  const target = event.target;
  if (!block || !(target instanceof Element)) return null;
  for (const candidate of block.getDescendants(false)) {
    // `isSwitchableShadow` 而不是 `shadowKindOf(...) !== null`：下拉是一顆
    // 字面值影子（存出去是字串），但它的型別不該讓人改掉，見 define.ts。
    if (!candidate.isShadow() || !isSwitchableShadow(candidate.type)) continue;
    if (candidate.getSvgRoot().contains(target)) return candidate;
  }
  return null;
}

export function registerLiteralContextMenu(): void {
  const registry = Blockly.ContextMenuRegistry.registry;

  ORDER.forEach((kind, index) => {
    const id = `blockyard_literal_${kind}`;
    if (registry.getItem(id)) return;

    registry.register({
      id,
      scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
      // 排在 FieldText 那兩項（20、21）後面，四項連在一起。
      weight: 30 + index,
      preconditionFn: (scope, event) => {
        clickedShadow = shadowAt(scope, event);
        if (!clickedShadow) return 'hidden';
        // 目前就是這個型別的話不列——「改成文字」出現在一格文字上只是雜訊。
        return shadowKindOf(clickedShadow.type) === kind ? 'hidden' : 'enabled';
      },
      displayText: () => labelOf(kind),
      callback: () => {
        if (clickedShadow) switchLiteralKind(clickedShadow, kind);
      },
    });
  });
}

registerLiteralContextMenu();
