/**
 * 更新一個積木包之後，畫布用新的定義重畫一次（`docs/extension-design.md` §4）。
 *
 * **這一題真正在守的是失敗的那一條**：新版少了一格參數時，舊的 IR 裡那個孔的
 * 名字在新定義上不存在，而 Blockly 的 `append` 對這種狀況是丟例外。那一下如果
 * 發生在 `workspace.clear()` 之後，使用者的畫布就空了——而那是這整條路上唯一
 * 一件真的會弄丟東西的事。
 *
 * 所以規則是：**讀不起來就一個字都不碰。** 下面第二題就是它。
 */
import * as Blockly from 'blockly/core';
import { describe, expect, it } from 'vitest';
import { registerManifests } from './setup';
import { rebuildCanvas } from './rebuild';
import { buildContext } from '../ir/context';
import { serializeWorkspace } from '../ir/serialize';
import type { Manifest } from '../types/manifest';
import type { BlockyardProjectIR as ProjectIR } from '../types/project';

/** 一顆 `說 (誰)`。`text` 與參數都可以換，那正是「更新」會動的兩樣東西。 */
function pack(id: string, { text = '對 %1 說哈囉', arg = 'who' } = {}): Manifest {
  return {
    manifestVersion: 1,
    id,
    name: id,
    version: '1.0.0',
    palette: [
      {
        opcode: 'hello',
        type: 'reporter',
        text,
        returns: 'string',
        args: { [arg]: { type: 'string', default: '世界' } },
      },
    ],
  } as unknown as Manifest;
}

function canvasWith(id: string, manifests: Manifest[]) {
  const registration = registerManifests(manifests);
  const ctx = buildContext(registration.blocks);
  const workspace = new Blockly.Workspace();
  Blockly.serialization.blocks.append({ type: `${id}.hello` }, workspace);
  return { workspace, ctx, registration };
}

/** 畫布 → IR，與 `App` 存檔走同一條。 */
function snapshot(workspace: Blockly.Workspace, ctx: ReturnType<typeof buildContext>) {
  return serializeWorkspace(workspace, ctx, { formatVersion: 1 }) as ProjectIR;
}

describe('更新之後重畫畫布', () => {
  it('積木上的字換了，畫布上那顆跟著換', () => {
    const before = [pack('rb_a')];
    const { workspace, ctx } = canvasWith('rb_a', before);
    const project = snapshot(workspace, ctx);

    // 更新：同一個 type，換一份定義。
    const after = [pack('rb_a', { text: '大聲對 %1 說哈囉' })];
    const registration = registerManifests(after, before);

    const ok = rebuildCanvas({
      workspace,
      project,
      ctx: buildContext(registration.blocks),
    });

    expect(ok).toBe(true);
    const block = workspace.getBlocksByType('rb_a.hello', false)[0]!;
    // 重畫出來的那一顆是**新定義**建的：那句話裡的字在積木自己身上。
    expect(block.toString()).toContain('大聲');
  });

  it('參數改名了：重畫得起來，而那一格的值跟著不見', () => {
    // **這是審閱畫面答應過的事**（§4：「少了 who（那幾格會被丟掉）」），所以
    // 它不是失敗，是說過的後果。新定義上沒有那個孔，值就沒有地方可以去。
    const before = [pack('rb_b')];
    const { workspace, ctx } = canvasWith('rb_b', before);
    const project = snapshot(workspace, ctx);
    const registration = registerManifests([pack('rb_b', { arg: 'target' })], before);

    const ok = rebuildCanvas({ workspace, project, ctx: buildContext(registration.blocks) });

    expect(ok).toBe(true);
    const block = workspace.getBlocksByType('rb_b.hello', false)[0]!;
    expect(block.getInput('target')).not.toBeNull();
    expect(block.getInput('who')).toBeNull();
  });

  it('讀不起來就**一個字都不碰**', () => {
    // 走到這裡的是「`loadProject` 中途丟例外」那一類（§16 Q19 的份數與孔的
    // 順序、壞掉的 `procedure.call`⋯）。那一下如果發生在 `clear()` 之後，
    // 使用者的畫布就空了——而那是這整條路上唯一一件真的會弄丟東西的事。
    const before = [pack('rb_c')];
    const { workspace, ctx } = canvasWith('rb_c', before);
    const project = snapshot(workspace, ctx);
    const idsBefore = workspace.getAllBlocks(false).map((b) => b.id);

    // 一份讀到一半會丟例外的 IR：`procedure.call` 沒有 `mutation.proc`。
    const broken: ProjectIR = {
      ...project,
      blocks: { ...project.blocks, broken: { opcode: 'procedure.call' } },
      scripts: [...(project.scripts ?? []), { id: 'sc_broken', top: 'broken', x: 0, y: 0 }],
    } as ProjectIR;

    const ok = rebuildCanvas({ workspace, project: broken, ctx });

    expect(ok).toBe(false);
    // 連 id 都沒換。呼叫端要靠這個 `false` 去說一句老實話。
    expect(workspace.getAllBlocks(false).map((b) => b.id)).toEqual(idsBefore);
  });

  it('空跑不留下任何東西', () => {
    // 空跑要在**另一個**工作區上跑，不然「先驗證再動手」只是把同一個風險換個
    // 位置。這一題釘的是那份隔離。
    const before = [pack('rb_d')];
    const { workspace, ctx } = canvasWith('rb_d', before);
    const project = snapshot(workspace, ctx);

    rebuildCanvas({ workspace, project, ctx });

    expect(workspace.getAllBlocks(false)).toHaveLength(1);
  });
});
