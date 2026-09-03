/**
 * 「按住 Alt 拖曳 = 複製這顆以下整串」的那一半（`duplicate.ts`）。
 *
 * 驗的是 `duplicateStack`：**複製出來的是什麼**。手勢那一半（Alt、換掉
 * `Dragger` 的 draggable）走的是真的指標事件與 SVG，jsdom 沒有——而複製的內容
 * 錯了才是使用者救不回來的那一種錯（多出一顆同 id 的腳本、少了底下那一串）。
 *
 * manifest 讀**後端真正在用的那幾份 yaml**（同 `repeat.test.ts`）：手寫一份
 * fixture 的話，哪天 `data.set` 的宣告改了，測試會繼續綠著。
 */
import * as Blockly from 'blockly/core';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { registerManifests } from './setup';
import { duplicateStack } from './duplicate';
import { SHADOW_TEXT } from './define';
import type { Manifest } from '../types/manifest';

const BUILTINS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../backend/blocky/interpreter/builtins',
);

beforeAll(() => {
  const manifests = readdirSync(BUILTINS)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parse(readFileSync(join(BUILTINS, f), 'utf8')) as Manifest);
  registerManifests(manifests);
});

let workspace: Blockly.Workspace;

beforeEach(() => {
  workspace = new Blockly.Workspace();
});

afterEach(() => {
  workspace.dispose();
});

/** 使用者那個例子：`設定 a` → `設定 b` → `重複 10 次 { 改變 b }`。 */
function buildStack(): { top: Blockly.Block; middle: Blockly.Block } {
  const first = workspace.newBlock('data.set');
  const second = workspace.newBlock('data.set');
  const loop = workspace.newBlock('control.repeat');
  const inner = workspace.newBlock('data.change');

  first.nextConnection!.connect(second.previousConnection!);
  second.nextConnection!.connect(loop.previousConnection!);
  loop.getInput('body')!.connection!.connect(inner.previousConnection!);
  return { top: first, middle: second };
}

/** 一串積木由上往下的型別。 */
function chain(block: Blockly.Block): string[] {
  const out: string[] = [];
  for (let b: Blockly.Block | null = block; b; b = b.getNextBlock()) out.push(b.type);
  return out;
}

describe('內建快捷鍵', () => {
  it('`D` 鍵複製已經拿掉', () => {
    // 拿掉的理由見 `duplicate.ts`（同一件事兩個入口、而且範圍不一樣）。這條
    // 釘的是**名字**：升級 Blockly 之後那個常數改了，`unregister` 會安靜地
    // 什麼都不做，而 D 鍵會自己回來。
    const registry = Blockly.ShortcutRegistry.registry;
    expect(registry.getKeyCodesByShortcutName(Blockly.ShortcutItems.names.DUPLICATE)).toEqual(
      [],
    );
    expect(registry.getShortcutNamesByKeyCode(Blockly.utils.KeyCodes.D.toString()) ?? []).toEqual(
      [],
    );
  });
});

describe('duplicateStack', () => {
  it('複製那一顆與它底下整串，原件一動也不動', () => {
    const { top, middle } = buildStack();

    const copy = duplicateStack(middle)!;

    expect(chain(copy)).toEqual(['data.set', 'control.repeat']);
    // C 型積木的嘴巴裡那顆也要在——`addNextBlocks` 帶的是「底下」，而孔裡那顆
    // 是預設就會帶的「裡面」。兩者都少了就只複製到一顆空殼。
    expect(copy.getNextBlock()!.getInputTargetBlock('body')!.type).toBe('data.change');

    // 原件：還接在第一顆底下、底下那串沒有被拔走。
    expect(middle.getParent()).toBe(top);
    expect(chain(top)).toEqual(['data.set', 'data.set', 'control.repeat']);
    // 複製品是頂層積木（接在哪裡由接下來的拖曳決定）。
    expect(copy.getParent()).toBeNull();
  });

  it('`withNext: false` 只複製那一顆', () => {
    // 拖曳時是 Ctrl／⌘ 按著（Blockly 給那顆鍵的意思就是「只要這一顆」，
    // 見 `duplicate.ts`）。
    const { top, middle } = buildStack();

    const copy = duplicateStack(middle, { withNext: false })!;

    expect(chain(copy)).toEqual(['data.set']);
    expect(chain(top)).toEqual(['data.set', 'data.set', 'control.repeat']);
  });

  it('複製品放在原件的位置上', () => {
    // 拖曳的手感靠這個：使用者按下去的位置就是原件，複製品疊在同一個地方接手。
    const { middle } = buildStack();
    const at = middle.getRelativeToSurfaceXY();

    const copy = duplicateStack(middle)!;

    expect(copy.getRelativeToSurfaceXY()).toEqual(at);
  });

  it('複製品從上到下都是新的 id', () => {
    const { middle } = buildStack();
    const before = workspace.getAllBlocks(false).map((b) => b.id);

    const copy = duplicateStack(middle)!;

    const fresh = copy.getDescendants(false).map((b) => b.id);
    expect(fresh).toHaveLength(3);
    for (const id of fresh) expect(before).not.toContain(id);
  });

  it('腳本 id（`data`）不跟著複製走', () => {
    // 跟著走的話畫布上就有兩條腳本宣稱自己是 `sc_1`，而執行高亮、`thread.start`
    // 與後端的 `_script_of()` 全部拿它當 key（見 `ir/serialize.ts`）。
    const { top } = buildStack();
    top.data = 'sc_1';

    const copy = duplicateStack(top)!;

    expect(copy.data).toBeFalsy();
    expect(top.data).toBe('sc_1');
  });

  it('刪不掉的積木不複製', () => {
    // 函式定義帽子與帽子上的參數晶片（`procedures.ts`、`params.ts`）都是這一種。
    const { middle } = buildStack();
    middle.setDeletable(false);

    expect(duplicateStack(middle)).toBeNull();
  });

  it('影子積木不複製', () => {
    // 影子不是使用者的東西：真的拖它，Blockly 給的是它的父積木
    // （`BlockDragStrategy.getTargetBlock`），所以這裡也不該生出一顆。
    const set = workspace.newBlock('data.set');
    set.getInput('value')!.connection!.setShadowState({ type: SHADOW_TEXT });
    const shadow = set.getInputTargetBlock('value')!;

    expect(shadow.isShadow()).toBe(true);
    expect(duplicateStack(shadow)).toBeNull();
  });
});
