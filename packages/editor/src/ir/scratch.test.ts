/**
 * `serializeBlock`：工具箱裡那一顆積木 → 一段跑得動的 IR（§5.1）。
 *
 * 讀的是**後端真正在用的**那幾份 manifest（同 `roundtrip.test.ts` 的理由），
 * 而積木是照工具箱的作法長出來的——`shadows` 貼在條目上（`toolbox.ts` 的
 * `toToolboxBlock`），所以這裡驗到的「影子的值進了父積木的 inputs」與使用者
 * 在 flyout 裡點到的是同一顆積木。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import * as Blockly from 'blockly/core';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { registerManifests } from '../blockly/setup';
import type { RegisteredBlock } from '../blockly/define';
import { buildContext } from './context';
import { serializeBlock } from './serialize';
import type { Manifest } from '../types/manifest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILTINS = resolve(HERE, '../../../../backend/blockyard/interpreter/builtins');
const DEMO_MANIFEST = resolve(HERE, '../../../../backend/blockyard/_bundled/demo/manifest.yaml');

const registration = registerManifests([
  ...readdirSync(BUILTINS)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parse(readFileSync(join(BUILTINS, f), 'utf8')) as Manifest),
  parse(readFileSync(DEMO_MANIFEST, 'utf8')) as Manifest,
]);
const ctx = buildContext(registration.blocks);

/** 照工具箱的作法生一顆：條目上帶著 `shadows`（`toolbox.ts::toToolboxBlock`）。 */
function fromToolbox(workspace: Blockly.Workspace, type: string): Blockly.Block {
  const registered = registration.blocks.find((b: RegisteredBlock) => b.type === type)!;
  const inputs = Object.fromEntries(
    Object.entries(registered.shadows).map(([name, shadow]) => [
      name,
      { shadow: { type: shadow.type, fields: shadow.fields } },
    ]),
  );
  return Blockly.serialization.blocks.append({ type, inputs }, workspace);
}

describe('工具箱裡那一顆的 IR（§5.1）', () => {
  it('一顆積木、一條腳本，影子的值進父積木的 inputs', () => {
    const workspace = new Blockly.Workspace();
    try {
      const block = fromToolbox(workspace, 'demo.echo');
      const scratch = serializeBlock(block, ctx);

      expect(Object.keys(scratch.blocks)).toEqual([block.id]);
      expect(scratch.blocks[block.id]).toMatchObject({
        opcode: 'demo.echo',
        parent: null,
        next: null,
        // manifest 的 `default: "world"` 是**影子裡預先填好的值**（§7.2），
        // 所以在工具箱裡點一下就有東西可以跑，不必先打字。
        inputs: { text: { kind: 'literal', value: 'world' } },
      });
      expect(scratch.scripts).toEqual([
        { id: expect.stringMatching(/^sc_/), top: block.id, x: 0, y: 0 },
      ]);
    } finally {
      workspace.dispose();
    }
  });

  it('積木包的宣告跟著出去，內建的不宣告', () => {
    const workspace = new Blockly.Workspace();
    try {
      // §13.3：執行只載入宣告過的包，所以這一筆不補上，`demo.echo` 在後端
      // 就是一顆 `unknown_block`——而使用者只是點了工具箱裡的一顆積木。
      expect(serializeBlock(fromToolbox(workspace, 'demo.echo'), ctx).extensions).toEqual([
        { id: 'demo', version: '0.1.0' },
      ]);
      // 內建沒有資料夾也沒有 main.py（`manifest.py` 的 `builtin`）。
      expect(serializeBlock(fromToolbox(workspace, 'debug.log'), ctx).extensions).toEqual([]);
    } finally {
      workspace.dispose();
    }
  });

  it('腳本 id 每次都是新的，而且不寫回積木身上', () => {
    const workspace = new Blockly.Workspace();
    try {
      const block = fromToolbox(workspace, 'demo.echo');
      const first = serializeBlock(block, ctx).scripts[0]!.id;
      const second = serializeBlock(block, ctx).scripts[0]!.id;

      expect(first).not.toBe(second);
      // `data` 會跟著「從工具箱拖出去」複製到畫布上那一顆身上（`scriptIdOf`），
      // 寫回去的話畫布會憑空多出一條宣稱自己叫 `sc_…` 的腳本。
      expect(block.data).toBeFalsy();
    } finally {
      workspace.dispose();
    }
  });
});
