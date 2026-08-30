/**
 * 定義帽子上的參數晶片（§4.6，第四輪回饋第 2 件）。
 *
 * 走**真的工作區**但沒有畫面：拖曳本身（`CopyOnDragStrategy`）只有 `BlockSvg`
 * 有，那一半在瀏覽器裡驗。這裡驗的是另外那一半，也是真正會出事的那一半——
 * **帽子的孔是畫面，不是內容**。存兩份 `params` 的話兩份遲早會漂移，而那種
 * bug 只會在「改了簽章、存檔、重新載入」之後才長出來。
 */
import * as Blockly from 'blockly/core';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerManifests } from './setup';
import { definitionType, isParamType, paramType, registerProcedures } from './procedures';
import { applyProcedure } from './apply';
import { fillDefinitionParams } from './params';
import { buildContext } from '../ir/context';
import { loadProject } from '../ir/deserialize';
import { serializeWorkspace } from '../ir/serialize';
import type { RegisteredBlock } from './define';
import type { Manifest } from '../types/manifest';
import type { BlockyProjectIR as ProjectIR, Procedure } from '../types/project';

const BUILTINS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../backend/blocky/interpreter/builtins',
);

let builtins: RegisteredBlock[];

beforeAll(() => {
  const manifests = readdirSync(BUILTINS)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parseYaml(readFileSync(join(BUILTINS, f), 'utf8')) as Manifest);
  builtins = registerManifests(manifests).blocks;
});

const JUMP: Procedure = {
  name: '跳 %(a1) 次 到 %(a2)',
  params: [
    { id: 'a1', name: '次數', type: 'number' },
    { id: 'a2', name: '方向', type: 'string' },
  ],
  returns: null,
  definitionBlock: 'def',
  body: null,
};

function project(): ProjectIR {
  return {
    formatVersion: 1,
    meta: {},
    extensions: [],
    variables: {},
    procedures: { p_jump: JUMP },
    scripts: [],
    blocks: {
      def: { opcode: 'procedure.definition', parent: null, next: null, fields: { proc: 'p_jump' } },
    },
  } as unknown as ProjectIR;
}

function open() {
  const ir = project();
  const procedures = ir.procedures as Record<string, Procedure>;
  const blocks = registerProcedures(procedures);
  const ctx = buildContext([...builtins, ...blocks]);
  const workspace = new Blockly.Workspace();
  loadProject(ir, workspace, ctx);
  return { workspace, procedures, ctx };
}

/** 畫布上所有參數積木。 */
function chips(workspace: Blockly.Workspace): Blockly.Block[] {
  return workspace.getAllBlocks(false).filter((b) => isParamType(b.type));
}

describe('帽子上的參數', () => {
  it('每個參數一顆晶片，孔名就是參數 id', () => {
    const { workspace, procedures } = open();
    fillDefinitionParams(workspace, procedures);

    const hat = workspace.getBlocksByType(definitionType('p_jump'), false)[0]!;
    expect(hat.getInput('a1')?.connection?.targetBlock()?.type).toBe(paramType('p_jump', 'a1'));
    expect(hat.getInput('a2')?.connection?.targetBlock()?.type).toBe(paramType('p_jump', 'a2'));
  });

  it('積木上寫的是參數**名稱**——IR 的 id 在畫面上一個字都不該出現', () => {
    // 名字在型別裡而不是欄位裡，所以「上面寫什麼」要問 Blockly 的定義。
    const { workspace, procedures } = open();
    fillDefinitionParams(workspace, procedures);

    const chip = workspace.getBlocksByType(paramType('p_jump', 'a1'), false)[0]!;
    expect(chip.toString()).toContain('次數');
    // **不是** `取得 (次數)`：參數不是變數，那個動詞不該出現（第五輪回饋）。
    expect(chip.toString()).not.toContain('取得');
  });

  it('晶片刪不掉——與定義帽子同一個理由', () => {
    const { workspace, procedures } = open();
    fillDefinitionParams(workspace, procedures);

    const chip = chips(workspace)[0]!;
    expect(chip.isDeletable()).toBe(false);
  });

  it('**帽子的孔不進 IR**：存出來的定義積木沒有 inputs', () => {
    const { workspace, procedures, ctx } = open();
    fillDefinitionParams(workspace, procedures);

    const out = serializeWorkspace(workspace, ctx, { procedures });
    const blocks = out.blocks ?? {};
    // 晶片一顆都沒有被存進去：`blocks` 裡只有那顆定義帽子。
    expect(Object.keys(blocks)).toEqual(['def']);
    expect(blocks.def?.inputs ?? {}).toEqual({});
    // 而參數本身完好——它的唯一真實來源是 `procedures[].params`。
    expect(out.procedures?.p_jump?.params).toHaveLength(2);
  });

  it('冪等：跑第二次不會多長一顆，也不會換掉已經在那裡的積木', () => {
    const { workspace, procedures } = open();
    fillDefinitionParams(workspace, procedures);
    const before = chips(workspace).map((b) => b.id);

    fillDefinitionParams(workspace, procedures);
    expect(chips(workspace).map((b) => b.id)).toEqual(before);
  });

  it('被擠出來的晶片會被收掉，孔重新補上', () => {
    // 使用者把別的積木丟進參數的孔：晶片變成頂層積木，而它是刪不掉的——
    // 不收拾的話畫布上就留下一顆拆不掉的孤兒。
    const { workspace, procedures } = open();
    fillDefinitionParams(workspace, procedures);

    const chip = chips(workspace)[0]!;
    chip.outputConnection!.disconnect();
    expect(chip.getParent()).toBeNull();

    fillDefinitionParams(workspace, procedures);
    expect(chips(workspace)).toHaveLength(2);
    expect(workspace.getBlockById(chip.id)).toBeNull();
  });
});

describe('改簽章之後帽子上的參數還在（§4.6）', () => {
  /**
   * 對話框按下確定時**真正跑的那一個函式**。
   *
   * 這裡曾經是一份抄過來的順序（註冊 → 重塑 → 補孔），而抄過來的順序會漂移：
   * 第七輪那個 bug 就出在「App.tsx 把它們接起來」的那條縫上，兩邊的單元測試
   * 卻全綠（PROGRESS §2.4）。現在順序只有一份，測試驗的就是它。
   */
  function apply(workspace: Blockly.Workspace, proc: Procedure) {
    applyProcedure({
      workspace: workspace as Blockly.WorkspaceSvg,
      procedures: { p_jump: JUMP },
      procId: 'p_jump',
      edited: proc,
      blocks: builtins,
    });
  }

  it('改一個參數的名字，兩顆都還在帽子上', () => {
    // 實測回饋：把 `minute` 改成 `minutes`，**帽子上的 reporter 整個不見了**。
    const { workspace, procedures } = open();
    fillDefinitionParams(workspace, procedures);

    apply(workspace, {
      ...JUMP,
      params: [
        { id: 'a1', name: '次數', type: 'number' },
        { id: 'a2', name: '方向們', type: 'string' },
      ],
    });

    const hat = workspace.getBlocksByType(definitionType('p_jump'), false)[0]!;
    expect(hat.getInput('a1')?.connection?.targetBlock()).not.toBeNull();
    expect(hat.getInput('a2')?.connection?.targetBlock()).not.toBeNull();
    expect(hat.getInput('a2')?.connection?.targetBlock()?.toString()).toContain('方向們');
  });

  it('函式體裡的參數積木也跟著改名', () => {
    const { workspace, procedures } = open();
    fillDefinitionParams(workspace, procedures);

    // 使用者從帽子上拖一顆到函式體裡（這裡直接建一顆等價的）。
    const inBody = workspace.newBlock(paramType('p_jump', 'a2'), 'in_body');
    expect(inBody.toString()).toContain('方向');

    apply(workspace, { ...JUMP, params: [
      { id: 'a1', name: '次數', type: 'number' },
      { id: 'a2', name: '方向們', type: 'string' },
    ] });

    // id 不變（IR 指著它），文字換新的。
    expect(workspace.getBlockById('in_body')?.toString()).toContain('方向們');
  });

  it('參數被刪掉時，函式體裡那顆留著並標成孤兒——不靜默刪掉使用者的積木', () => {
    const { workspace, procedures } = open();
    fillDefinitionParams(workspace, procedures);
    workspace.newBlock(paramType('p_jump', 'a2'), 'in_body');

    apply(workspace, {
      ...JUMP,
      name: '跳 %(a1) 次',
      params: [{ id: 'a1', name: '次數', type: 'number' }],
    });

    const hat = workspace.getBlocksByType(definitionType('p_jump'), false)[0]!;
    expect(hat.getInput('a1')?.connection?.targetBlock()).not.toBeNull();
    expect(hat.getInput('a2')).toBeNull();
    // 那顆積木**還在**，上面寫的仍然是舊名字——那正是使用者需要看到的線索。
    expect(workspace.getBlockById('in_body')?.toString()).toContain('方向');
  });

  it('改名字之後畫布上不會多出落單的參數積木', () => {
    const { workspace, procedures } = open();
    fillDefinitionParams(workspace, procedures);

    apply(workspace, { ...JUMP, params: [
      { id: 'a1', name: '次數', type: 'number' },
      { id: 'a2', name: '方向們', type: 'string' },
    ] });

    expect(chips(workspace)).toHaveLength(2);
    expect(chips(workspace).every((b) => b.getParent() !== null)).toBe(true);
  });
});
