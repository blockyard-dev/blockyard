/**
 * 刪掉函式 → Ctrl+Z（§8.2 的兩本帳）。
 *
 * 走**真的工作區**與**真的 Blockly undo 堆疊**：手寫 IR → `loadProject` →
 * 補孔 → `dispose` → `workspace.undo()`。只驗 `syncTrashedProcedures` 的
 * 純函式部分會漏掉這裡真正的難處——「undo 之後畫布上長什麼樣」是 Blockly
 * 的行為，不是我們的規則。
 *
 * Blockly 的事件是**下一輪 tick 才進 undo 堆疊**的（`eventUtils` 的佇列），
 * 所以每一步之後都要讓出一次 event loop。少了那一行，`undoStack_` 是空的而
 * `undo()` 什麼都不做——一題永遠是綠的測試（PROGRESS §5.9）。
 */
import * as Blockly from 'blockly/core';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerManifests } from './setup';
import { definitionType, registerProcedures } from './procedures';
import { fillDefinitionParams } from './params';
import { syncTrashedProcedures } from './lifecycle';
import { buildContext } from '../ir/context';
import { loadProject } from '../ir/deserialize';
import type { RegisteredBlock } from './define';
import type { Manifest } from '../types/manifest';
import type { BlockyardProjectIR as ProjectIR, Procedure } from '../types/project';

const BUILTINS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../backend/blockyard/interpreter/builtins',
);

let builtins: RegisteredBlock[];

beforeAll(() => {
  const manifests = readdirSync(BUILTINS)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parseYaml(readFileSync(join(BUILTINS, f), 'utf8')) as Manifest);
  builtins = registerManifests(manifests).blocks;
});

const JUMP: Procedure = {
  name: '跳 %(a1) 次',
  params: [{ id: 'a1', name: '次數', type: 'number' }],
  returns: null,
  definitionBlock: 'def',
  body: 'wait',
} as unknown as Procedure;

/** 一顆定義帽子，底下接著一顆函式體積木。 */
function project(): ProjectIR {
  return {
    formatVersion: 1,
    meta: {},
    extensions: [],
    variables: {},
    procedures: { p_jump: JUMP },
    scripts: [],
    blocks: {
      def: {
        opcode: 'procedure.definition',
        parent: null,
        next: 'wait',
        fields: { proc: 'p_jump' },
      },
      wait: {
        opcode: 'control.wait',
        parent: 'def',
        next: null,
        inputs: { seconds: { kind: 'literal', value: 1 } },
      },
    },
  } as unknown as ProjectIR;
}

/** Blockly 的事件排在下一輪 tick 才進 undo 堆疊。 */
const settle = () => new Promise((r) => setTimeout(r, 0));

function open() {
  const ir = project();
  const procedures = ir.procedures as Record<string, Procedure>;
  const workspace = new Blockly.Workspace();
  loadProject(ir, workspace, buildContext([...builtins, ...registerProcedures(procedures)]));
  fillDefinitionParams(workspace, procedures);
  return { workspace, procedures };
}

/** `App.tsx` 的 `deleteRef` 對 Blockly 那一半做的事。 */
function trash(workspace: Blockly.Workspace, procId: string): Record<string, Procedure> {
  workspace.getBlocksByType(definitionType(procId), false)[0]?.dispose(false);
  return {};
}

describe('刪掉函式之後 undo', () => {
  it('帽子回到畫布上，那筆宣告也跟著回來', async () => {
    const { workspace, procedures } = open();
    const archive = { ...procedures };
    await settle();

    const declared = trash(workspace, 'p_jump');
    await settle();
    // 刪完的狀態：兩本帳一致（畫布上沒有帽子，宣告裡也沒有）。
    expect(syncTrashedProcedures(workspace, ['p_jump'], declared, archive)).toBeNull();

    workspace.undo(false);
    await settle();

    // Blockly 那一本自己退回來了——連函式體。
    expect(workspace.getBlockById('def')).not.toBeNull();
    expect(workspace.getBlockById('wait')).not.toBeNull();

    // 而這是原本沒有人做的那一半：宣告要跟著帽子回來，且是**刪掉前那一份**
    // 簽章，不是一個名字叫 `p_jump` 的空殼。
    const synced = syncTrashedProcedures(workspace, ['p_jump'], declared, archive);
    expect(synced).not.toBeNull();
    expect(synced!.p_jump).toEqual(JUMP);
  });

  it('再 redo 一次，宣告又跟著消失', async () => {
    const { workspace, procedures } = open();
    const archive = { ...procedures };
    await settle();

    trash(workspace, 'p_jump');
    await settle();
    workspace.undo(false);
    await settle();
    const revived = syncTrashedProcedures(workspace, ['p_jump'], {}, archive)!;

    workspace.undo(true); // redo
    await settle();

    expect(workspace.getBlockById('def')).toBeNull();
    expect(syncTrashedProcedures(workspace, ['p_jump'], revived, archive)).toEqual({});
  });

  it('undo 還原的參數晶片修得回「刪不掉」——不然帽子拖到垃圾桶沒有反應', async () => {
    const { workspace, procedures } = open();
    await settle();
    trash(workspace, 'p_jump');
    await settle();
    workspace.undo(false);
    await settle();

    // 補孔要能認出「孔裡那顆已經是晶片了」而不是再生一顆——重複的話帽子上會
    // 疊出第二顆膠囊，或是換掉積木 id。
    fillDefinitionParams(workspace, procedures);
    const hat = workspace.getBlockById('def')!;
    const chip = hat.getInput('a1')?.connection?.targetBlock();
    expect(chip?.type).toBe('procedure.param#p_jump.a1');
    expect(chip?.isDeletable()).toBe(false);
    expect(workspace.getBlocksByType('procedure.param#p_jump.a1', false)).toHaveLength(1);
  });

  it('沒刪過的函式不歸它管——舊專案那種「有宣告、沒帽子」不該被清掉', async () => {
    const { workspace } = open();
    await settle();
    // `trashed` 是空的：畫布上有帽子、宣告裡沒有，也不動它。
    expect(syncTrashedProcedures(workspace, [], {}, { p_jump: JUMP })).toBeNull();
    // 反方向同理（`ir/serialize.ts` 明講要保留這種宣告）。
    expect(syncTrashedProcedures(workspace, [], { p_ghost: JUMP }, {})).toBeNull();
  });

  it('查不到簽章就不動——寧可留一顆孤兒帽子，也不要生一個名字是亂碼的函式', async () => {
    const { workspace } = open();
    await settle();
    expect(syncTrashedProcedures(workspace, ['p_jump'], {}, {})).toBeNull();
  });
});
