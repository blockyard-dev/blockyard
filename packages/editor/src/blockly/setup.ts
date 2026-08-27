/**
 * 啟動流程（§8.1）：拿 manifest → 註冊 → 產生工具箱。
 *
 * 這條路徑對內建與第三方是同一條（D21），所以這個檔案裡沒有任何一個 opcode
 * 的名字。
 */
import * as Blockly from 'blockly/core';
import * as zhHant from 'blockly/msg/zh-hant';
import { defineManifest, defineShadowBlocks, type RegisteredBlock } from './define';
import { buildToolbox, groupByManifest, type ToolboxGroup } from './toolbox';
import './fields/FieldText';
import type { Manifest } from '../types/manifest';

let localeReady = false;

export interface Registration {
  blocks: RegisteredBlock[];
  groups: ToolboxGroup[];
  toolbox: Record<string, unknown>;
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
