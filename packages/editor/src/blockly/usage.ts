/**
 * 「畫布上還有誰在用這個積木包」（D31 的刪除規則）。
 *
 * 刪掉一個擴充功能與刪掉一個函式定義是同一種動作：**它會讓畫布上已經存在的
 * 積木失去來源**。函式那條路的規則是「還有人呼叫就不准刪，並且捲到那一顆」
 * （`App.tsx::deleteRef`），這裡照抄——差別只有「還在用」的定義從一個
 * `procedure.call#<id>` 換成**這個命名空間註冊出來的每一種積木**。
 *
 * 不用 opcode 的前綴去比對字串（`type.startsWith('http.')`）：那會把
 * `http_extra` 這種名字也算進來，而且它等於在前端寫死「積木的 type 長什麼
 * 樣子」——那是 `define.ts` 的事。問註冊表要那幾個 type，是同一份資料的唯一
 * 一份答案。
 *
 * **`dynamic` 的積木不在 `group.blocks` 裡**（`define.ts` 根本沒註冊它們），
 * 所以它們也不會被算進「還在用」。目前沒有任何積木包宣告 `dynamic`（那是內建
 * 限定的，D22），所以這條現在不咬人。
 */
import * as Blockly from 'blockly/core';
import type { ToolboxGroup } from './toolbox';

export function blocksUsing(workspace: Blockly.Workspace, group: ToolboxGroup): Blockly.Block[] {
  // `ordered: true` = 由上而下、由左而右。「捲到其中一顆」時，畫面上比較高的
  // 那一顆比註冊順序裡的第一顆更接近使用者說的「第一個」。
  return group.blocks.flatMap((block) => workspace.getBlocksByType(block.type, true));
}
