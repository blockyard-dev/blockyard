// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorRuntime } from './runtime';
import { PluginActions, PluginPanels } from './PluginUI';
import { ExtPanel } from '../components/ExtPanel';
import type { EditorAPI, EditorHost } from './types';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const host = (): EditorHost => ({
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
});
it('renders registered controls, mounts custom DOM and removes styles/handlers on disposal', async () => {
  const clicked = vi.fn();
  const unmount = vi.fn();
  const runtime = new EditorRuntime(host(), async () => ({
    activate(api: EditorAPI) {
      api.commands.register('click', clicked);
      api.ui.registerToolbarButton({ id: 'button', label: 'Plugin button', command: 'ui.click' });
      api.ui.registerMenu({ id: 'menu', label: 'Plugin menu', command: 'ui.click' });
      api.ui.registerStyle('theme', '.custom { color: red; }');
      api.ui.registerPanel({
        id: 'panel',
        title: 'Plugin panel',
        mount(node) {
          const text = document.createElement('p');
          text.textContent = 'Custom DOM';
          node.append(text);
          return unmount;
        },
      });
    },
  }));
  await act(async () => {
    root.render(
      <>
        <PluginActions runtime={runtime} />
        <PluginPanels runtime={runtime} />
      </>,
    );
    await runtime.load(
      [{ id: 'ui', name: 'UI', version: '1', editor: { entry: 'ui.js', apiVersion: 1 } }],
      '',
    );
  });
  expect(container.textContent).toContain('Custom DOM');
  expect(document.querySelector('style[data-extension="ui.theme"]')).not.toBeNull();
  const button = [...container.querySelectorAll('button')].find(
    (node) => node.textContent === 'Plugin button',
  )!;
  await act(async () => button.click());
  expect(clicked).toHaveBeenCalledOnce();
  await act(async () => runtime.dispose());
  expect(container.textContent).not.toContain('Custom DOM');
  expect(unmount).toHaveBeenCalledOnce();
  expect(document.querySelector('style[data-extension="ui.theme"]')).toBeNull();
});
it('legacy iframe keeps ready/replay/call routing without sandbox', async () => {
  const call = vi.fn();
  await act(async () =>
    root.render(
      <ExtPanel
        extId="demo"
        panelId="demo"
        entry="ui/index.html"
        outbox={[{ value: 3 }]}
        onMessage={call}
      />,
    ),
  );
  const frame = container.querySelector('iframe')!;
  expect(frame.hasAttribute('sandbox')).toBe(false);
  const send = vi.spyOn(frame.contentWindow!, 'postMessage');
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', { source: window, data: { v: 1, type: 'ready' } }),
    );
  });
  expect(send).not.toHaveBeenCalled();
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', { source: frame.contentWindow, data: { v: 1, type: 'ready' } }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: { v: 1, type: 'call', payload: { name: 'go' } },
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: { v: 2, type: 'call', payload: {} },
      }),
    );
  });
  expect(send).toHaveBeenCalledWith({ v: 1, type: 'message', payload: { value: 3 } }, '*');
  expect(call).toHaveBeenCalledExactlyOnceWith({ name: 'go' });
});
