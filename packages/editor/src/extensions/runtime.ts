import { readPref, writePref } from '../prefs';
import type { Manifest } from '../types/manifest';
import { t } from '../i18n';
import type {
  ActionSpec,
  Command,
  Dispose,
  EditorAPI,
  EditorEvents,
  EditorHost,
  EditorModule,
  PanelSpec,
  ShortcutSpec,
} from './types';

const DISABLED_PREF = 'extensions.editor.disabled';
export const rescueMode = (search: string) =>
  new URLSearchParams(search).get('extensions') === 'off';
export function disabledExtensions(): Set<string> {
  const value = readPref<unknown>(DISABLED_PREF, []);
  return new Set(
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [],
  );
}
export function setExtensionEnabled(id: string, enabled: boolean): void {
  const disabled = disabledExtensions();
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  writePref(DISABLED_PREF, [...disabled].sort());
}
/** Call after disk mutation. Failed saves leave the live document intact. */
export async function saveAndReload(
  save: () => Promise<void>,
  reload: () => void,
  snapshot?: () => string,
): Promise<void> {
  const before = snapshot?.();
  await save();
  if (snapshot && snapshot() !== before) throw new Error(t('error.pluginSaveChanged'));
  reload();
}

interface Owned {
  owner: string;
}
export interface RuntimeSnapshot {
  menus: (ActionSpec & Owned)[];
  toolbar: (ActionSpec & Owned)[];
  panels: (PanelSpec & Owned)[];
  problems: { id: string; message: string }[];
}
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const importModule = (url: string): Promise<EditorModule> => import(/* @vite-ignore */ url);

export class EditorRuntime {
  private commands = new Map<string, Command>();
  private ids = new Set<string>();
  private loaded = new Map<string, { module?: EditorModule; cleanup: Dispose[] }>();
  private listeners = new Set<Dispose>();
  private events = new Map<keyof EditorEvents, Set<(data: never) => void>>();
  private shortcuts = new Map<string, ShortcutSpec & Owned>();
  private snapshot: RuntimeSnapshot = { menus: [], toolbar: [], panels: [], problems: [] };
  private disposed = false;
  private loading: Promise<void> = Promise.resolve();

  constructor(
    private host: EditorHost,
    private importer = importModule,
  ) {
    this.commands.set('editor.save', () => this.host.project.save());
    this.commands.set('editor.run', () => this.host.run());
    this.commands.set('editor.stop', () => this.host.stop());
    for (const id of this.commands.keys()) this.ids.add(id);
  }
  subscribe = (fn: Dispose): Dispose => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = (): RuntimeSnapshot => this.snapshot;
  private update(patch: Partial<RuntimeSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) fn();
  }
  report(id: string, error: unknown) {
    this.update({
      problems: [
        ...this.snapshot.problems.filter((p) => p.id !== id),
        { id, message: messageOf(error) },
      ],
    });
  }
  async execute(id: string, ...args: unknown[]): Promise<unknown> {
    const command = this.commands.get(id);
    if (!command) throw new Error(t('error.pluginCommandMissing', { id }));
    return command(...args);
  }
  emit<K extends keyof EditorEvents>(type: K, data: EditorEvents[K]): void {
    for (const listener of this.events.get(type) ?? []) listener(data as never);
  }
  handleKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.repeat || e.isComposing) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    for (const shortcut of this.shortcuts.values()) {
      if (!matchesShortcut(shortcut.keys, e)) continue;
      e.preventDefault();
      void this.execute(shortcut.command).catch((error) => this.report(shortcut.owner, error));
      return;
    }
  };
  load(manifests: readonly Manifest[], search: string): Promise<void> {
    this.loading = this.loading.then(async () => {
      if (this.disposed || rescueMode(search)) return;
      const disabled = disabledExtensions();
      for (const manifest of [...manifests].sort((a, b) => a.id.localeCompare(b.id))) {
        if (this.disposed) return;
        const spec = manifest.editor;
        if (!spec || manifest.builtin || disabled.has(manifest.id) || this.loaded.has(manifest.id))
          continue;
        const record: { module?: EditorModule; cleanup: Dispose[] } = { cleanup: [] };
        this.loaded.set(manifest.id, record);
        try {
          if (spec.apiVersion !== 1)
            throw new Error(t('error.pluginApiVersion', { version: String(spec.apiVersion) }));
          const path = spec.entry.split('/').map(encodeURIComponent).join('/');
          record.module = await this.importer(
            `/api/extensions/${encodeURIComponent(manifest.id)}/asset/${path}`,
          );
          if (this.disposed) return;
          if (typeof record.module.activate !== 'function')
            throw new Error(t('error.pluginActivateMissing'));
          await record.module.activate(this.api(manifest.id, record.cleanup));
          if (this.disposed) {
            this.clean(record.cleanup);
            return;
          }
        } catch (error) {
          this.clean(record.cleanup);
          try {
            await record.module?.deactivate?.();
          } catch {
            /* Keep the activation error. */
          }
          record.module = undefined;
          this.report(manifest.id, error);
        }
      }
    });
    return this.loading;
  }
  private clean(cleanup: Dispose[]) {
    for (const dispose of cleanup.splice(0).reverse()) {
      try {
        dispose();
      } catch (error) {
        console.error(error);
      }
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [id, record] of this.loaded) {
      this.clean(record.cleanup);
      try {
        await record.module?.deactivate?.();
      } catch (error) {
        this.report(id, error);
      }
    }
    this.events.clear();
  }
  private api(owner: string, cleanup: Dispose[]): EditorAPI {
    const track = (dispose: Dispose) => {
      let done = false;
      const once = () => {
        if (!done) {
          done = true;
          dispose();
        }
      };
      cleanup.push(once);
      return once;
    };
    const register = (local: string, add: (id: string) => Dispose): Dispose => {
      if (this.disposed) throw new Error(t('error.pluginRuntimeClosed'));
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(local)) throw new Error(t('error.pluginInvalidId', { id: local }));
      const id = `${owner}.${local}`;
      if (this.ids.has(id)) throw new Error(t('error.pluginDuplicateId', { id }));
      const remove = add(id);
      this.ids.add(id);
      return track(() => {
        remove();
        this.ids.delete(id);
      });
    };
    const action = (kind: 'menus' | 'toolbar', spec: ActionSpec) =>
      register(spec.id, (id) => {
        this.update({ [kind]: [...this.snapshot[kind], { ...spec, id, owner }] });
        return () => this.update({ [kind]: this.snapshot[kind].filter((s) => s.id !== id) });
      });
    return {
      apiVersion: 1,
      extensionId: owner,
      commands: {
        register: (id, command) =>
          register(id, (full) => {
            this.commands.set(full, command);
            return () => {
              this.commands.delete(full);
            };
          }),
        execute: (id, ...args) => this.execute(id, ...args),
      },
      ui: {
        registerMenu: (spec) => action('menus', spec),
        registerToolbarButton: (spec) => action('toolbar', spec),
        registerPanel: (spec) =>
          register(spec.id, (id) => {
            this.update({ panels: [...this.snapshot.panels, { ...spec, id, owner }] });
            return () => this.update({ panels: this.snapshot.panels.filter((p) => p.id !== id) });
          }),
        registerShortcut: (spec) =>
          register(spec.id, (id) => {
            validateShortcut(spec.keys);
            if (
              [...this.shortcuts.values()].some(
                (s) => normalizeKeys(s.keys) === normalizeKeys(spec.keys),
              )
            ) {
            throw new Error(t('error.pluginShortcutRegistered', { shortcut: spec.keys }));
            }
            this.shortcuts.set(id, { ...spec, id, owner });
            return () => {
              this.shortcuts.delete(id);
            };
          }),
        registerStyle: (id, css) =>
          register(id, (full) => {
            const style = document.createElement('style');
            style.dataset.extension = full;
            style.textContent = css;
            document.head.append(style);
            return () => style.remove();
          }),
      },
      workspace: this.host.workspace,
      project: this.host.project,
      events: {
        on: (event, handler) => {
          const wrapped = (data: never) => {
            try {
              handler(data);
            } catch (error) {
              this.report(owner, error);
            }
          };
          const set = this.events.get(event) ?? new Set();
          set.add(wrapped);
          this.events.set(event, set);
          return track(() => {
            set.delete(wrapped);
          });
        },
      },
    };
  }
}
const normalizeKeys = (keys: string) =>
  keys
    .toLowerCase()
    .split('+')
    .map((key) => key.trim())
    .sort()
    .join('+');
function validateShortcut(keys: string) {
  const parts = keys
    .toLowerCase()
    .split('+')
    .map((s) => s.trim());
  if (
    !parts.at(-1) ||
    parts.slice(0, -1).some((s) => !['mod', 'ctrl', 'meta', 'alt', 'shift'].includes(s))
  ) {
    throw new Error(t('error.pluginShortcutInvalid', { shortcut: keys }));
  }
}
export function matchesShortcut(
  keys: string,
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): boolean {
  const parts = keys
    .toLowerCase()
    .split('+')
    .map((s) => s.trim());
  const key = parts.pop();
  const mod = parts.includes('mod');
  return (
    event.key.toLowerCase() === key &&
    (mod
      ? event.ctrlKey || event.metaKey
      : event.ctrlKey === parts.includes('ctrl') && event.metaKey === parts.includes('meta')) &&
    event.altKey === parts.includes('alt') &&
    event.shiftKey === parts.includes('shift')
  );
}
