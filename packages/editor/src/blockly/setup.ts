/**
 * 啟動流程（§8.1）：拿 manifest → 註冊 → 產生工具箱。
 *
 * 這條路徑對內建與第三方是同一條（D21），所以這個檔案裡沒有任何一個 opcode
 * 的名字。
 */
import * as Blockly from 'blockly/core';
import * as zhHant from 'blockly/msg/zh-hant';
import { defineManifest, defineShadowBlocks, type RegisteredBlock } from './define';
import {
  buildToolbox,
  groupByManifest,
  type ToolboxGroup,
} from './toolbox';
import { isCallType } from './procedures';
import './fields/FieldText';
// 匯入即註冊 §16 Q16 的字面值型別切換選單。
import './literals';
import type { Manifest } from '../types/manifest';

let localeReady = false;

export interface Registration {
  blocks: RegisteredBlock[];
  groups: ToolboxGroup[];
  toolbox: Record<string, unknown>;
}

/**
 * 專案的工具箱 = 靜態宣告 + 這個專案的函式（§4.6、§8.5）。
 *
 * 函式分類裡動態的只有 **`呼叫 X` 一顆**。
 *
 * **參數不上架**（Scratch 也一樣）：它們掛在定義帽子上，拖一下就有一份
 * （§4.6、`params.ts`），而那已經是取得它們的完整路徑。上架等於同一顆積木在
 * 兩個地方各有一份入口，而分類裡那一份還少了「它屬於哪個函式」這個資訊——
 * 畫面上就是一排沒有上下文的 `second` `minute`。
 *
 * 定義帽子也**不上架**：建立函式的入口是那顆按鈕（D25），拖一顆定義出來會產生
 * 一個沒有名字的函式。
 */
export function buildProjectToolbox(
  registration: Registration,
  procedureBlocks: RegisteredBlock[],
  /** 已經設定好的金鑰（`keyId`）——`open_config` 的按鈕設定完就不再上架。 */
  configured?: ReadonlySet<string>,
): Record<string, unknown> {
  const calls = procedureBlocks.filter((block) => isCallType(block.type));
  return buildToolbox(groupByManifest([...registration.blocks, ...calls]), configured);
}

export function registerManifests(manifests: Manifest[]): Registration {
  if (!localeReady) {
    Blockly.setLocale(zhHant as unknown as Record<string, string>);
    localeReady = true;
  }

  defineShadowBlocks();

  const blocks = manifests.flatMap((manifest) => defineManifest(manifest));
  const groups = groupByManifest(blocks);
  return { blocks, groups, toolbox: buildToolbox(groups) };
}
