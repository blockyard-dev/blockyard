import * as Blockly from 'blockly/core';
import { loadProject } from '../ir/deserialize';
import { buildContext } from '../ir/context';
import { registerProcedures } from '../blockly/procedures';
import type { RegisteredBlock } from '../blockly/define';
import type { BlockyardProjectIR as ProjectIR } from '../types/project';
import { t } from '../i18n';

class EditorChange extends Blockly.Events.Abstract {
  isBlank = false;
  type = 'blockyard_editor_change';
  constructor(
    workspace: Blockly.Workspace,
    private before: ProjectIR,
    private after: ProjectIR,
    private restore: (project: ProjectIR) => void,
  ) {
    super();
    this.workspaceId = workspace.id;
    this.recordUndo = true;
  }
  run(forward: boolean) {
    this.restore(forward ? this.after : this.before);
  }
}

export interface TransactionOptions {
  workspace: Blockly.Workspace;
  blocks: readonly RegisteredBlock[];
  snapshot(): ProjectIR;
  validate(project: ProjectIR): Promise<void>;
  /** Commit metadata, procedures and context synchronously, then notify React. */
  commit(project: ProjectIR): void;
  afterLoad?(workspace: Blockly.Workspace, project: ProjectIR): void;
}

/** Validate before mutation; one undo entry also restores procedure definitions and metadata. */
export async function applyEditorIR(
  project: ProjectIR,
  options: TransactionOptions,
): Promise<void> {
  const { workspace, blocks, snapshot, commit, afterLoad } = options;
  const next = structuredClone(project);
  const before = structuredClone(snapshot());
  await options.validate(next);
  if (JSON.stringify(snapshot()) !== JSON.stringify(before)) {
    throw new Error(t('error.pluginCanvasChanged'));
  }
  const context = (p: ProjectIR) =>
    buildContext([...blocks, ...registerProcedures(p.procedures ?? {})]);
  const scratch = new Blockly.Workspace();
  Blockly.Events.disable();
  try {
    loadProject(next, scratch, context(next));
  } finally {
    scratch.dispose();
    context(before);
    Blockly.Events.enable();
  }
  const restore = (p: ProjectIR) => {
    Blockly.Events.disable();
    try {
      const ctx = context(p);
      workspace.clear();
      loadProject(p, workspace, ctx);
      afterLoad?.(workspace, p);
      commit(structuredClone(p));
    } finally {
      Blockly.Events.enable();
    }
  };
  try {
    restore(next);
  } catch (error) {
    restore(before);
    throw error;
  }
  const group = Blockly.Events.getGroup();
  Blockly.Events.setGroup(true);
  try {
    Blockly.Events.fire(new EditorChange(workspace, before, next, restore));
  } finally {
    Blockly.Events.setGroup(group);
  }
}
