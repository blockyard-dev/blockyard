import * as Blockly from 'blockly/core';
import {
  registerManifests,
  WARNING_DOT_BOX_SIZE,
  WARNING_DOT_GAP,
} from './setup';
/**
 * 已知缺口 1 的那條規則：**後端的宣告變了沒有**。
 *
 * 只測純函數那一半。「切回瀏覽器的那一刻有沒有真的問一次」是時序，不是規則
 * ——它跟 PROGRESS 上那幾條「測得到的是規則，測不到的是順序」同一類。
 */
import { describe, expect, it } from 'vitest';
import { changedManifestIds } from './setup';
import { isRemovable, visibleGroups, type ToolboxGroup } from './toolbox';
import type { Manifest } from '../types/manifest';

it('warning 紅點只佔用自己的小方格，不保留三角 icon 的 17px 寬度', () => {
  const size = Blockly.icons.WarningIcon.prototype.getSize();
  expect(size).toEqual(new Blockly.utils.Size(WARNING_DOT_BOX_SIZE, WARNING_DOT_BOX_SIZE));
});

it('warning 紅點與後面欄位不吃 Zelos 預設的 8px 間隔', () => {
  const warning = Object.create(Blockly.icons.WarningIcon.prototype) as Blockly.icons.WarningIcon;
  const prev = { icon: warning } as unknown as Blockly.blockRendering.Icon;
  const next = {} as Blockly.blockRendering.Measurable;
  expect(Blockly.zelos.RenderInfo.prototype.getInRowSpacing_(prev, next)).toBe(WARNING_DOT_GAP);
});

function mf(id: string, extra: Record<string, unknown> = {}): Manifest {
  return { manifestVersion: 1, id, name: id, version: '1.0.0', palette: [], ...extra } as Manifest;
}

describe('changedManifestIds', () => {
  it('一模一樣就是空集合——不改宣告的日子裡什麼都不該重新註冊', () => {
    const before = [mf('data'), mf('http')];
    expect(changedManifestIds(before, [mf('data'), mf('http')]).size).toBe(0);
  });

  it('新的命名空間算變了', () => {
    expect([...changedManifestIds([mf('data')], [mf('data'), mf('panel')])]).toEqual(['panel']);
  });

  it('比的是整份宣告，不是版本號', () => {
    // 改一句 `text` 不會有人記得動 `version`，而那正是開發時最常改的東西。
    const before = [mf('data', { description: '舊的' })];
    const after = [mf('data', { description: '新的' })];
    expect([...changedManifestIds(before, after)]).toEqual(['data']);
  });

  it('只回**還在**的那些——消失的不算「變了」', () => {
    // 消失的命名空間沒有東西可以重新註冊。它的後果在畫布上（下次載入退化成
    // §13.3 的佔位符），不在註冊這條路上。
    expect(changedManifestIds([mf('data'), mf('gone')], [mf('data')]).size).toBe(0);
  });

  it('順序換了不算變', () => {
    const before = [mf('data'), mf('http')];
    expect(changedManifestIds(before, [mf('http'), mf('data')]).size).toBe(0);
  });
});


describe('isRemovable / 分類的順序（D31）', () => {
  const group = (id: string, builtin: boolean) => ({ id, builtin }) as unknown as ToolboxGroup;

  it('積木包收得起來，內建收不起來', () => {
    expect(isRemovable(group('panel', false))).toBe(true);
    expect(isRemovable(group('data', true))).toBe(false);
  });

  it('收得起來的排最後——使用者的心智模型是「上面是語言、下面是我裝的東西」', () => {
    const groups = [
      group('operator', true),
      group('panel', false),
      group('procedure', true),
      group('http', false),
    ];
    expect(visibleGroups(groups, new Set(['panel', 'http'])).map((g) => g.id)).toEqual([
      'operator',
      'procedure',
      'panel',
      'http',
    ]);
  });

  it('沒加進來的就不在，但順序規則照舊', () => {
    const groups = [group('operator', true), group('panel', false), group('http', false)];
    expect(visibleGroups(groups, new Set(['http'])).map((g) => g.id)).toEqual(['operator', 'http']);
  });
});

it('keeps frontend-only manifests in the gallery without empty toolbox categories', () => {
  const registration = registerManifests([{ id: 'frontend', name: 'Frontend', version: '1', editor: { entry: 'ui.js', apiVersion: 1 } }]);
  expect(registration.groups.map((g) => g.id)).toEqual(['frontend']);
  expect(registration.blocks).toHaveLength(0);
  expect(registration.toolbox.contents).toEqual([]);
});

it('registers Blockly built-in messages in the requested locale', () => {
  registerManifests([], undefined, 'en');
  expect(Blockly.Msg['DELETE_BLOCK']).toBe('Delete Block');
  registerManifests([], undefined, 'zh-TW');
  expect(Blockly.Msg['DELETE_BLOCK']).toBe('刪除區塊');
});
