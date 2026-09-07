import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../types/manifest';
import type { EditorAPI, EditorHost } from './types';
import {
  EditorRuntime,
  matchesShortcut,
  rescueMode,
  saveAndReload,
  setExtensionEnabled,
} from './runtime';

const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
const pack = (id: string, apiVersion = 1): Manifest => ({
  id,
  name: id,
  version: '1',
  editor: { entry: 'ui/editor.js', apiVersion },
});
function host(): EditorHost {
  return {
    workspace: {
      getIR: vi.fn(),
      applyIR: vi.fn(),
      getSelection: () => null,
      select: vi.fn(),
      focus: vi.fn(),
    },
    project: { current: () => ({ id: 'prj_test', name: 'Test' }), save: vi.fn(async () => {}) },
    run: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}
describe('trusted editor runtime', () => {
  it('loads in ID order only once, regardless of toolbox membership', async () => {
    const activated: string[] = [];
    const importer = vi.fn(async () => ({
      activate: (api: EditorAPI) => {
        activated.push(api.extensionId);
      },
    }));
    const runtime = new EditorRuntime(host(), importer);
    await Promise.all([runtime.load([pack('z'), pack('a')], ''), runtime.load([pack('a')], '')]);
    expect(activated).toEqual(['a', 'z']);
    expect(importer).toHaveBeenCalledWith('/api/extensions/a/asset/ui/editor.js');
    await runtime.dispose();
  });
  it('rescue and disabled preferences skip code before import', async () => {
    const importer = vi.fn();
    const runtime = new EditorRuntime(host(), importer);
    await runtime.load([pack('a')], '?extensions=off');
    setExtensionEnabled('a', false);
    await runtime.load([pack('a')], '');
    expect(importer).not.toHaveBeenCalled();
    expect(rescueMode('?x=1&extensions=off')).toBe(true);
    setExtensionEnabled('a', true);
  });
  it('unsupported versions and activation failures leave other plugins usable', async () => {
    const importer = vi.fn(async (url: string) => ({
      activate(api: EditorAPI) {
        api.commands.register('hello', () => 'hello');
        api.ui.registerToolbarButton({
          id: 'button',
          label: 'Hello',
          command: `${api.extensionId}.hello`,
        });
        if (url.includes('/bad/')) throw new Error('broken');
      },
    }));
    const runtime = new EditorRuntime(host(), importer);
    await runtime.load([pack('bad'), pack('future', 2), pack('good')], '');
    expect(runtime.getSnapshot().problems.map((p) => p.id)).toEqual(['bad', 'future']);
    expect(runtime.getSnapshot().toolbar.map((p) => p.id)).toEqual(['good.button']);
    await expect(runtime.execute('bad.hello')).rejects.toThrow('找不到命令');
    expect(await runtime.execute('good.hello')).toBe('hello');
    expect(importer).toHaveBeenCalledTimes(2);
  });
  it('namespaces registrations, rejects duplicates, and cleans commands/events/panels', async () => {
    let api!: EditorAPI;
    const deactivate = vi.fn();
    const runtime = new EditorRuntime(host(), async () => ({
      activate: (value) => {
        api = value;
      },
      deactivate,
    }));
    await runtime.load([pack('a')], '');
    const remove = api.commands.register('test', () => 42);
    expect(() => api.commands.register('test', () => 0)).toThrow('重複');
    api.ui.registerPanel({ id: 'panel', title: 'Panel', mount: () => {} });
    const onRun = vi.fn();
    api.events.on('run.changed', onRun);
    runtime.emit('run.changed', { status: 'running', runId: 'r1' });
    expect(onRun).toHaveBeenCalledOnce();
    remove();
    remove();
    api.commands.register('test', () => 43);
    await runtime.dispose();
    expect(runtime.getSnapshot().panels).toEqual([]);
    await expect(runtime.execute('a.test')).rejects.toThrow();
    runtime.emit('run.changed', { status: 'done', runId: 'r1' });
    expect(onRun).toHaveBeenCalledOnce();
    expect(deactivate).toHaveBeenCalledOnce();
  });
  it('core commands call the same editor host operations', async () => {
    const h = host();
    const runtime = new EditorRuntime(h);
    await runtime.execute('editor.save');
    await runtime.execute('editor.run');
    await runtime.execute('editor.stop');
    expect(h.project.save).toHaveBeenCalledOnce();
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.stop).toHaveBeenCalledOnce();
  });
  it('does not overwrite a core command when a plugin is named editor', async () => {
    const h = host();
    const runtime = new EditorRuntime(h, async () => ({
      activate(api) {
        api.commands.register('save', () => 'overwritten');
      },
    }));
    await runtime.load([pack('editor')], '');
    expect(runtime.getSnapshot().problems[0]?.message).toContain('重複');
    await runtime.execute('editor.save');
    expect(h.project.save).toHaveBeenCalledOnce();
  });
  it('does not reload after a failed save', async () => {
    const reload = vi.fn();
    await expect(
      saveAndReload(async () => {
        throw new Error('unsaved');
      }, reload),
    ).rejects.toThrow('unsaved');
    expect(reload).not.toHaveBeenCalled();
    const order: string[] = [];
    await saveAndReload(
      async () => {
        order.push('save');
      },
      () => {
        order.push('reload');
      },
    );
    expect(order).toEqual(['save', 'reload']);
  });
  it('does not reload when the user edits during saving', async () => {
    let revision = 'before';
    const reload = vi.fn();
    await expect(
      saveAndReload(
        async () => {
          revision = 'after';
        },
        reload,
        () => revision,
      ),
    ).rejects.toThrow('畫布已變更');
    expect(reload).not.toHaveBeenCalled();
  });
  it('matches explicit modifier sets', () => {
    expect(
      matchesShortcut('Mod+Shift+k', {
        key: 'K',
        ctrlKey: false,
        metaKey: true,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      matchesShortcut('Mod+k', {
        key: 'K',
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(false);
  });
});
