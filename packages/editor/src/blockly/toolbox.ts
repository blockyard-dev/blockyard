/**
 * manifest → 工具箱分類（§8.1 第 3 步）。
 *
 * 一份 manifest 一個分類，順序照 `GET /api/extensions` 吐出來的順序——後端
 * 已經把內建排在積木包前面（`api/extensions.py`），前端不再重排。
 */
import type { RegisteredBlock } from './define';

export interface ToolboxGroup {
  id: string;
  name: string;
  colour: string;
  builtin: boolean;
  blocks: RegisteredBlock[];
}

const DEFAULT_COLOUR = '#9966FF';

export function groupByManifest(blocks: RegisteredBlock[]): ToolboxGroup[] {
  const groups = new Map<string, ToolboxGroup>();
  for (const block of blocks) {
    const { manifest } = block;
    let group = groups.get(manifest.id);
    if (!group) {
      group = {
        id: manifest.id,
        name: manifest.name,
        colour: manifest.color ?? DEFAULT_COLOUR,
        builtin: manifest.builtin === true,
        blocks: [],
      };
      groups.set(manifest.id, group);
    }
    group.blocks.push(block);
  }
  return [...groups.values()];
}

/**
 * `deprecated: true` 的積木**註冊但不上架**：舊專案載得進來（不然會變成
 * §13.3 的未知積木），但沒有人能再拉出新的一顆。
 */
export function buildToolbox(groups: ToolboxGroup[]): Record<string, unknown> {
  return {
    kind: 'categoryToolbox',
    contents: groups
      .map((group) => ({
        kind: 'category',
        name: group.name,
        colour: group.colour,
        cssConfig: { container: 'blocky-category' },
        contents: group.blocks
          .filter((block) => !block.spec.deprecated)
          .map(toToolboxBlock),
      }))
      .filter((category) => category.contents.length > 0),
  };
}

/**
 * 影子積木只能掛在工具箱條目上（Blockly 的 JSON 積木定義沒有宣告影子的地方），
 * 所以 `define.ts` 算好的 `shadows` 在這裡才貼上去。
 */
function toToolboxBlock(block: RegisteredBlock): Record<string, unknown> {
  const entry: Record<string, unknown> = { kind: 'block', type: block.type };
  if (Object.keys(block.fields).length > 0) entry.fields = block.fields;
  const inputs = Object.entries(block.shadows);
  if (inputs.length > 0) {
    entry.inputs = Object.fromEntries(
      inputs.map(([name, shadow]) => [
        name,
        { shadow: { type: shadow.type, fields: shadow.fields } },
      ]),
    );
  }
  return entry;
}
