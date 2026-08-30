/**
 * `deserialize(serialize(ws))` 等價（§8.4、PROGRESS.md 第 4 步）。
 *
 * 測資是現成的：§17 題庫那 63 份 `project.json`，一份都不必另寫。讀的是
 * **後端真正在用的** `builtins/*.yaml` 與 `extensions/demo/manifest.yaml`
 * ——複製出來的一份會在漂移的那天繼續綠著，這與 `define.test.ts` 是同一個
 * 理由。
 *
 * 「等價」不是 byte-for-byte：`escape_and_bare_dollar` 那份題目故意手寫了
 * 一個內容其實是字面值、卻標成 `kind: template` 的輸入（測的是**直譯器**
 * 解析這類邊界字串的行為，不是「前端會不會存出這種 IR」）。轉換層永遠依
 * **內容**決定 `kind`／`whole`（`ir/template.ts`），所以比對前用同一條規則
 * 把兩邊的 `kind`／`whole`／`refs` 正規化一次——這正是 §4.7「`refs` 是衍生
 * 欄位」在測試裡的體現。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import * as Blockly from 'blockly/core';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { registerManifests } from '../blockly/setup';
import { registerProcedures } from '../blockly/procedures';
import { buildContext, type ConversionContext } from './context';
import { loadProject } from './deserialize';
import { serializeWorkspace } from './serialize';
import { hasInterpolation, isWholeTemplate } from './template';
import type { Manifest } from '../types/manifest';
import type { Block as IRBlock, BlockyProjectIR as ProjectIR } from '../types/project';

const BUILTINS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../backend/blocky/interpreter/builtins',
);
const DEMO_MANIFEST = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../extensions/demo/manifest.yaml',
);
const CORPUS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../backend/tests/conformance',
);

function loadManifests(): Manifest[] {
  const builtins = readdirSync(BUILTINS)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parse(readFileSync(join(BUILTINS, f), 'utf8')) as Manifest);
  const demo = parse(readFileSync(DEMO_MANIFEST, 'utf8')) as Manifest;
  return [...builtins, demo];
}

function findFixtures(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findFixtures(full));
    else if (entry.name === 'project.json') out.push(full);
  }
  return out;
}

/**
 * 這幾題**故意**手寫出編輯器畫不出來的 IR，測的是後端／直譯器那一層的
 * 防線，不是「這是一份存得出來的專案」。兩種情況：
 *
 * - **形狀擺錯位置、opcode 不存在**（§13.3、D20）：Blockly 自己的連接系統
 *   本來就不會讓你把一顆沒有 previousStatement 的積木接進堆疊，也不會有
 *   未註冊 type 的積木可以拖上畫布——這是比後端更早一層的防線。
 * - **字面值的 JSON 型別是編輯器的文字/數字影子畫不出來的**（`boolean`、
 *   `null`、`object.type.cast` 下拉選項故意不存在的 `object`）：這裡沒有
 *   「布林字面值」這種積木（§8.5：boolean 孔沒有影子，只能接 reporter），
 *   所以像 `demo.add` 的 `b` 收到字面 `true`（測 §4.3 的 `true→1`）這種
 *   題目，本來就只有手寫 IR 才寫得出來。
 *
 * round-trip 測試量的是「合法、畫得出來的專案能不能存讀不失真」，不該去
 * 要求它也能表示編輯器本來就生不出來的 IR。
 */
const NOT_REPRESENTABLE_IN_BLOCKLY = new Set([
  'errors/command_in_input_hole/project.json',
  'errors/extension_block_shape_is_checked_too/project.json',
  'errors/hat_in_the_middle_of_a_stack/project.json',
  'errors/reporter_in_stack/project.json',
  // cap block 下面接了積木（§4.6 的 `terminal`）。`procedure.return` 與
  // `control.stop` 都已經沒有 `nextStatement`，Blockly 直接拒收——正是這兩題
  // 想證明的那條防線。
  'errors/terminal_block_cannot_have_next/project.json',
  'errors/stop_is_a_terminal_block/project.json',
  'errors/unknown_opcode_stays_a_placeholder/project.json',
  'extensions/missing_pack_is_placeholder/project.json',
  'extensions/number_arg_converts/project.json',
  'extensions/number_arg_out_of_range/project.json',
  'type/cast_refuses_object/project.json',
  'type/list_and_object_are_distinct/project.json',
  'values/string_coercion_table/project.json',
]);

const manifestRegistration = registerManifests(loadManifests());
const fixtures = findFixtures(CORPUS);

/**
 * 兩件事故意不比對「照抄」，比對前先套同一條規則正規化：
 *
 * 1. `kind: template` 用的內容規則重新套一次：`literal` 值恰好含未逸出的
 *    `${` 才算 `template`，`whole` 由內容決定。`refs` 一律清空——它是衍生
 *    欄位，前端从不自己算（§4.7）。
 * 2. 省略的 dropdown／boolean 欄位補上 manifest 宣告的預設值——省略和明講
 *    預設值是同一件事（`interpreter/builtins/debug.py` 的 `t.field(b,
 *    "level", "info")` 就是這樣讀的），但題庫兩種寫法都有（`control.stop`
 *    的 `scope` 就明講了跟預設一樣的值）。轉換層對這件事沒有意見：它只
 *    **保留現有的值**（`object.to_json` 的 `pretty` 沒設，Blockly 的
 *    `field_checkbox` 一樣會給出它自己的初始值），不猜哪一種寫法「比較
 *    對」，所以留給測試自己拉平。
 * 3. 同一條規則的第三個消費者：函式的 `x` / `y`（定義帽子的位置）。題庫是
 *    手寫的語意規格，沒有人在裡面寫座標；而存檔一定寫得出來（schema 的預設
 *    值就是 0）。省略與明講 0 是同一份 IR。
 */
function canonicalize(project: ProjectIR, ctx: ConversionContext): ProjectIR {
  const blocks: Record<string, IRBlock> = {};
  for (const [id, block] of Object.entries(project.blocks ?? {})) {
    const inputs: IRBlock['inputs'] = {};
    for (const [name, input] of Object.entries(block.inputs ?? {})) {
      const isTextValue =
        (input.kind === 'literal' || input.kind === 'template') && typeof input.value === 'string';
      if (isTextValue) {
        const value = input.value as string;
        inputs![name] = hasInterpolation(value)
          ? { kind: 'template', value, refs: [], whole: isWholeTemplate(value) }
          : { kind: 'literal', value };
      } else {
        inputs![name] = input;
      }
    }

    const fields: Record<string, unknown> = { ...(block.fields ?? {}) };
    const registered = ctx.blockOf(block.opcode);
    if (registered) {
      for (const [key, arg] of Object.entries(registered.spec.args ?? {})) {
        if (key in fields) continue;
        const isFieldArg = arg.field === true || arg.type === 'variable';
        if (!isFieldArg) continue;
        if (arg.type === 'boolean') fields[key] = arg.default === true;
        else if (arg.default != null) fields[key] = String(arg.default);
      }
    }

    blocks[id] = { ...block, inputs, fields };
  }

  const procedures: ProjectIR['procedures'] = {};
  for (const [id, proc] of Object.entries(project.procedures ?? {})) {
    procedures![id] = { ...proc, x: proc.x ?? 0, y: proc.y ?? 0 };
  }

  return { ...project, blocks, procedures };
}

describe('定義帽子的位置（實測回饋）', () => {
  /**
   * 症狀：存檔重開之後**每一顆定義帽子都疊在同一個位置**。
   *
   * 成因是位置沒有地方存——定義帽子不進 `scripts`（§5.1 的觸發條件是 top 的
   * opcode，而它永遠不會被觸發），而 `Procedure` 當時沒有 `x` / `y`。所以這
   * 一題驗的是**存得出來也讀得回去**，兩個方向都要，只驗一邊會漏掉「寫了但
   * 沒人讀」這種修法。
   */
  it('存得出來，也讀得回去', () => {
    const path = fixtures.find((f) => f.includes('procedure/no_return_yields_null'))!;
    const project = JSON.parse(readFileSync(path, 'utf8')) as ProjectIR;
    const procId = Object.keys(project.procedures!)[0]!;
    const moved: ProjectIR = {
      ...project,
      procedures: { ...project.procedures, [procId]: { ...project.procedures![procId]!, x: 240, y: 88 } },
    };

    const ctx = buildContext([
      ...manifestRegistration.blocks,
      ...registerProcedures(moved.procedures ?? {}),
    ]);
    const workspace = new Blockly.Workspace();
    try {
      loadProject(moved, workspace, ctx);
      const hat = workspace.getBlockById(moved.procedures![procId]!.definitionBlock!);
      expect(hat?.getRelativeToSurfaceXY()).toEqual({ x: 240, y: 88 });

      const out = serializeWorkspace(workspace, ctx, { procedures: moved.procedures });
      expect(out.procedures?.[procId]?.x).toBe(240);
      expect(out.procedures?.[procId]?.y).toBe(88);
    } finally {
      workspace.dispose();
    }
  });
});

describe('IR → Blockly → IR 等價（63 份題庫）', () => {
  const cases = fixtures
    .map((f) => [f.slice(CORPUS.length + 1), f] as const)
    .filter(([name]) => !NOT_REPRESENTABLE_IN_BLOCKLY.has(name));

  it.each(cases)('%s', (_name, path) => {
    const project = JSON.parse(readFileSync(path, 'utf8')) as ProjectIR;

    const procedureBlocks = registerProcedures(project.procedures ?? {});
    const ctx = buildContext([...manifestRegistration.blocks, ...procedureBlocks]);

    const workspace = new Blockly.Workspace();
    try {
      loadProject(project, workspace, ctx);
      // `extensions` 不傳：它是**算出來的**（§13.3）。題庫的每一份 fixture
      // 都宣告了它真的用到的包，所以這一題順便驗那條推導——算錯就是這裡紅。
      const result = serializeWorkspace(workspace, ctx, {
        formatVersion: project.formatVersion,
        meta: project.meta,
        procedures: project.procedures,
      });

      expect(canonicalize(result, ctx)).toEqual(canonicalize(project, ctx));
    } finally {
      workspace.dispose();
    }
  });
});

/**
 * §13.3 的 `extensions` 宣告。
 *
 * 上面那 63 題驗的是「fixture 宣告什麼、算出來就是什麼」，而它們是**手寫**的
 * IR——每一份都已經宣告對了。真正會出事的是另一個方向：使用者從工具箱拉一顆
 * 新的積木出來，那一刻宣告要跟著長出來。P1 第一個積木包當天撞到的就是這件事
 * （症狀：按下執行，後端說「這個版本不認得積木 http.get」）。
 */
describe('extensions 是從畫布算出來的（§13.3）', () => {
  const demo = manifestRegistration.blocks.find((b) => b.manifest.id === 'demo')!.manifest;

  function fresh() {
    return {
      workspace: new Blockly.Workspace(),
      ctx: buildContext(manifestRegistration.blocks),
    };
  }

  it('拉一顆積木包的積木出來 = 宣告用到它', () => {
    const { workspace, ctx } = fresh();
    try {
      workspace.newBlock('demo.announce');
      expect(serializeWorkspace(workspace, ctx).extensions).toEqual([
        { id: 'demo', version: demo.version },
      ]);
    } finally {
      workspace.dispose();
    }
  });

  it('刪掉最後一顆，宣告也跟著不見', () => {
    const { workspace, ctx } = fresh();
    try {
      const block = workspace.newBlock('demo.announce');
      block.dispose(false);
      expect(serializeWorkspace(workspace, ctx).extensions).toEqual([]);
    } finally {
      workspace.dispose();
    }
  });

  it('內建積木不進宣告——它沒有資料夾也沒有 main.py', () => {
    const { workspace, ctx } = fresh();
    try {
      workspace.newBlock('debug.log');
      workspace.newBlock('control.repeat');
      expect(serializeWorkspace(workspace, ctx).extensions).toEqual([]);
    } finally {
      workspace.dispose();
    }
  });

  it('同一個包用了兩顆積木也只宣告一次', () => {
    const { workspace, ctx } = fresh();
    try {
      workspace.newBlock('demo.announce');
      workspace.newBlock('demo.echo');
      expect(serializeWorkspace(workspace, ctx).extensions).toHaveLength(1);
    } finally {
      workspace.dispose();
    }
  });
});
