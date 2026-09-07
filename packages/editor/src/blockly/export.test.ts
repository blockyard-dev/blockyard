import * as Blockly from 'blockly/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerWorkspaceExportMenus } from './export';

const SVG_ID = 'blockyard_workspace_export_svg';
const PNG_ID = 'blockyard_workspace_export_png';

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe('畫布匯出右鍵選單', () => {
  it('畫布有積木時顯示兩種格式並呼叫對應動作', () => {
    const callback = vi.fn();
    cleanup = registerWorkspaceExportMenus(callback);
    const registry = Blockly.ContextMenuRegistry.registry;
    const svg = registry.getItem(SVG_ID)!;
    const png = registry.getItem(PNG_ID)!;
    const scope = {
      workspace: { getAllBlocks: () => [{}] } as unknown as Blockly.WorkspaceSvg,
    };

    expect(svg.displayText).toBe('匯出所有積木為 SVG');
    expect(png.displayText).toBe('匯出所有積木為 PNG');
    expect(svg.preconditionFn?.(scope, new Event('contextmenu'))).toBe('enabled');
    expect(png.preconditionFn?.(scope, new Event('contextmenu'))).toBe('enabled');
    const location = new Blockly.utils.Coordinate(0, 0);
    if ('callback' in svg && svg.callback) {
      svg.callback(scope, new Event('contextmenu'), new Event('click'), location);
    }
    if ('callback' in png && png.callback) {
      png.callback(scope, new Event('contextmenu'), new Event('click'), location);
    }
    expect(callback.mock.calls).toEqual([['svg'], ['png']]);
  });

  it('空畫布時兩個動作都停用', () => {
    cleanup = registerWorkspaceExportMenus(vi.fn());
    const scope = {
      workspace: { getAllBlocks: () => [] } as unknown as Blockly.WorkspaceSvg,
    };
    const registry = Blockly.ContextMenuRegistry.registry;
    expect(registry.getItem(SVG_ID)?.preconditionFn?.(scope, new Event('contextmenu'))).toBe('disabled');
    expect(registry.getItem(PNG_ID)?.preconditionFn?.(scope, new Event('contextmenu'))).toBe('disabled');
  });
});
