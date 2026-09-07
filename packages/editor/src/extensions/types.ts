import type { BlockyardProjectIR as ProjectIR } from '../types/project';

export type Dispose = () => void;
export type Command = (...args: unknown[]) => unknown | Promise<unknown>;
export interface ActionSpec {
  id: string;
  label: string;
  command: string;
}
export interface PanelSpec {
  id: string;
  title: string;
  mount(container: HTMLElement): void | Dispose;
}
export interface ShortcutSpec {
  id: string;
  keys: string;
  command: string;
}
export interface EditorEvents {
  'project.changed': { id: string; name: string | null };
  'workspace.changed': undefined;
  'selection.changed': string | null;
  'run.changed': { status: string; runId: string | null };
}
export interface EditorHost {
  workspace: {
    getIR(): ProjectIR;
    applyIR(project: ProjectIR): Promise<void>;
    getSelection(): string | null;
    select(id: string | null): void;
    focus(id: string): void;
  };
  project: { current(): EditorEvents['project.changed']; save(): Promise<void> };
  run(): Promise<void>;
  stop(): Promise<void>;
}
/** API v1. IDs passed to register methods are local; returned commands use `<extension>.<id>`. */
export interface EditorAPI {
  readonly apiVersion: 1;
  readonly extensionId: string;
  commands: {
    register(id: string, handler: Command): Dispose;
    execute(id: string, ...args: unknown[]): Promise<unknown>;
  };
  ui: {
    registerMenu(spec: ActionSpec): Dispose;
    registerToolbarButton(spec: ActionSpec): Dispose;
    registerPanel(spec: PanelSpec): Dispose;
    registerShortcut(spec: ShortcutSpec): Dispose;
    registerStyle(id: string, css: string): Dispose;
  };
  workspace: EditorHost['workspace'];
  project: EditorHost['project'];
  events: {
    on<K extends keyof EditorEvents>(event: K, handler: (data: EditorEvents[K]) => void): Dispose;
  };
}
export interface EditorModule {
  activate(editor: EditorAPI): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
