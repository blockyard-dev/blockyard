/**
 * 改簽章之後畫布上那些積木怎麼變（§8.5）。
 *
 * 走**真的工作區**：手寫一份 IR → `loadProject` → 改 `procedures` → 重新註冊
 * → `reshapeProcedure`。只驗「產生的定義長什麼樣」會漏掉這裡真正的難處——
 * 積木在 `init` 的當下就把孔長好了，重新註冊不會動到已經在畫布上的那些。
 *
 * 警告圖示只有 `BlockSvg` 畫得出來（`Block.setWarningText` 是空實作），而這裡
 * 是無畫面的工作區——所以孤兒那幾題驗的是**誰被搬成了頂層積木**，那正是
 * 「積木有沒有被靜默刪掉」的實質內容。
 */
import * as Blockly from 'blockly/core';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerManifests } from './setup';
import { registerProcedures, callType } from './procedures';
import { reshapeProcedure } from './reshape';
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

/** 一個腳本：`旗子 → 呼叫 跳 (3) (左)`，另外一顆定義帽子。 */
function project(): ProjectIR {
  return {
    formatVersion: 1,
    meta: {},
    extensions: [],
    variables: {},
    procedures: { p_jump: JUMP },
    scripts: [{ id: 'sc_1', top: 'hat', x: 0, y: 0 }],
    blocks: {
      hat: { opcode: 'event.when_flag_clicked', parent: null, next: 'call' },
      def: { opcode: 'procedure.definition', parent: null, next: null, fields: { proc: 'p_jump' } },
      call: {
        opcode: 'procedure.call',
        parent: 'hat',
        next: null,
        mutation: { proc: 'p_jump' },
        inputs: {
          a1: { kind: 'block', id: 'three' },
          a2: { kind: 'literal', value: '左' },
        },
      },
      three: { opcode: 'operator.expr', parent: 'call', next: null, fields: { expr: '1 + 2' } },
    },
  } as unknown as ProjectIR;
}

function open(): { workspace: Blockly.Workspace; procedures: Record<string, Procedure> } {
  const ir = project();
  const procedures = ir.procedures as Record<string, Procedure>;
  const blocks = registerProcedures(procedures);
  const workspace = new Blockly.Workspace();
  loadProject(ir, workspace, buildContext([...builtins, ...blocks]));
  return { workspace, procedures };
}

/** 改簽章 = 先重新註冊型別，再重塑畫布上的積木。順序反過來就重建出舊形狀。 */
function apply(workspace: Blockly.Workspace, proc: Procedure) {
  registerProcedures({ p_jump: proc });
  return reshapeProcedure(workspace as Blockly.WorkspaceSvg, 'p_jump', proc);
}

describe('改簽章', () => {
  it('積木的 id 不變——IR 的 scripts/body 都指著它', () => {
    const { workspace } = open();
    apply(workspace, { ...JUMP, name: '飛 %(a1) 次 到 %(a2)' });

    const call = workspace.getBlockById('call');
    expect(call).not.toBeNull();
    expect(call?.getParent()?.id).toBe('hat');
  });

  it('留著的孔連同裡面的積木一起帶過去', () => {
    const { workspace } = open();
    apply(workspace, { ...JUMP, name: '跳 %(a2) 次 到 %(a1)' });

    const call = workspace.getBlockById('call');
    expect(call?.getInput('a1')?.connection?.targetBlock()?.id).toBe('three');
    expect(call?.getInput('a2')?.connection?.targetBlock()?.getFieldValue('VALUE')).toBe('左');
  });

  it('少一個參數 → 插在那個孔裡的積木留在原地成為孤兒，不刪除', () => {
    const { workspace } = open();
    const result = apply(workspace, {
      ...JUMP,
      name: '跳 %(a2) 次',
      params: [JUMP.params![1]!],
    });

    const orphan = workspace.getBlockById('three');
    expect(orphan).not.toBeNull();
    expect(orphan?.getParent()).toBeNull();
    expect(result.orphans).toContain('three');
  });

  it('影子不是孤兒——它是那個孔的一部分', () => {
    const { workspace } = open();
    // a2 裡面是字面值影子，拿掉 a2 之後不該多出一顆頂層的白色格子。
    const result = apply(workspace, { ...JUMP, name: '跳 %(a1) 次', params: [JUMP.params![0]!] });
    expect(result.orphans).toEqual([]);
    expect(workspace.getTopBlocks(false).map((b) => b.id).sort()).toEqual(['def', 'hat']);
  });

  it('加一個參數 → 多一個空孔，舊的照樣接著', () => {
    const { workspace } = open();
    apply(workspace, {
      ...JUMP,
      name: '跳 %(a1) 次 到 %(a2) 加 %(a3)',
      params: [...JUMP.params!, { id: 'a3', name: '力道', type: 'number' }],
    });

    const call = workspace.getBlockById('call');
    expect(call?.getInput('a3')).not.toBeNull();
    expect(call?.getInput('a1')?.connection?.targetBlock()?.id).toBe('three');
  });
});

describe('形狀重塑（command ↔ reporter）', () => {
  it('改成有回傳值：接在 hat 底下的呼叫積木接不回去，成為孤兒而不是被刪掉', () => {
    const { workspace } = open();
    const result = apply(workspace, { ...JUMP, returns: 'number' });

    const call = workspace.getBlockById('call');
    expect(call).not.toBeNull();
    // 形狀變了就接不回原本那個接點——留在原地，使用者看得到它還在哪裡。
    expect(call?.getParent()).toBeNull();
    expect(result.orphans).toContain('call');
    expect(call?.outputConnection).not.toBeNull();
  });

  it('改成布林回傳值 → 呼叫積木是六角形', () => {
    const { workspace } = open();
    apply(workspace, { ...JUMP, returns: 'boolean' });
    expect(workspace.getBlockById('call')?.outputConnection?.getCheck()).toEqual(['Boolean']);
  });
});

describe('重塑完仍然存得出對的 IR', () => {
  it('簽章改了，畫布上的積木存出來還是同一份腳本', () => {
    const { workspace } = open();
    const next: Procedure = { ...JUMP, name: '飛 %(a1) 次 到 %(a2)' };
    const blocks = registerProcedures({ p_jump: next });
    reshapeProcedure(workspace as Blockly.WorkspaceSvg, 'p_jump', next);

    const ir = serializeWorkspace(workspace, buildContext([...builtins, ...blocks]), {
      procedures: { p_jump: next },
    });

    expect(ir.scripts?.[0]?.top).toBe('hat');
    expect(ir.blocks?.call?.opcode).toBe('procedure.call');
    expect(ir.blocks?.call?.mutation).toEqual({ proc: 'p_jump' });
    expect(ir.procedures?.p_jump?.name).toBe('飛 %(a1) 次 到 %(a2)');
    expect(ir.procedures?.p_jump?.definitionBlock).toBe('def');
  });
});

describe('註冊順序', () => {
  it('先註冊型別再重塑——反過來會重建出舊形狀', () => {
    const { workspace } = open();
    const next: Procedure = { ...JUMP, name: '跳 %(a1) 次', params: [JUMP.params![0]!] };

    // 故意不重新註冊就重塑：舊定義還在，所以 a2 那個孔還會被建出來。
    reshapeProcedure(workspace as Blockly.WorkspaceSvg, 'p_jump', next);
    expect(workspace.getBlockById('call')?.getInput('a2')).not.toBeNull();

    // 正確的順序把它收掉。
    expect(callType('p_jump')).toBe('procedure.call#p_jump');
    apply(workspace, next);
    expect(workspace.getBlockById('call')?.getInput('a2')).toBeNull();
  });
});
