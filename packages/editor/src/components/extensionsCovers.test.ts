import { describe, expect, it } from 'vitest';
import { coverUrl, withCover } from './extensionsCovers';
import type { ToolboxGroup } from '../blockly/toolbox';

function group(id: string, cover: string | null): ToolboxGroup {
  return {
    id,
    name: id,
    colour: '#000',
    builtin: false,
    panels: [],
    version: '0.1.0',
    description: null,
    cover,
    blocks: [],
    palette: [],
    buttons: [],
    secrets: [],
  };
}

describe('封面', () => {
  it('網址只吃 id——路徑是後端去 manifest 讀的', () => {
    expect(coverUrl('demo')).toBe('/api/extensions/demo/cover');
  });

  it('沒宣告封面的包不預載', () => {
    // 預載一個不存在的封面等於每次開場都送一輪 404。
    const groups = [group('demo', 'preview.png'), group('http', null)];

    expect(withCover(groups).map((g) => g.id)).toEqual(['demo']);
  });
});
