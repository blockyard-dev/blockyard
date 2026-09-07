import * as Blockly from 'blockly/core';
import { describe, expect, it, vi } from 'vitest';
import { applyEditorIR } from './transaction';
import { registerManifests } from '../blockly/setup';
import { buildContext } from '../ir/context';
import { serializeWorkspace } from '../ir/serialize';
import type { BlockyardProjectIR as ProjectIR } from '../types/project';

function fixture() {
  const registration = registerManifests([
    {
      id: 'tx',
      name: 'TX',
      version: '1',
      palette: [{ opcode: 'value', type: 'reporter', text: 'value', returns: 'number' }],
    },
  ]);
  const ctx = buildContext(registration.blocks);
  const workspace = new Blockly.Workspace();
  let metadata = { formatVersion: 1, meta: { name: 'Before' } };
  const snapshot = () => serializeWorkspace(workspace, ctx, metadata) as ProjectIR;
  const commit = (p: ProjectIR) => {
    metadata = { formatVersion: p.formatVersion ?? 1, meta: { name: p.meta?.name ?? '' } };
  };
  return {
    workspace,
    snapshot,
    blocks: registration.blocks,
    commit,
    validate: vi.fn(async () => {}),
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
describe('editor IR transactions', () => {
  it('undo and redo restore the entire change including metadata', async () => {
    const f = fixture();
    try {
      await settle();
      f.workspace.clearUndo();
      const before = f.snapshot();
      const next: ProjectIR = {
        ...before,
        meta: { name: 'After' },
        scripts: [{ id: 's', top: 'b' }],
        blocks: { b: { opcode: 'tx.value', inputs: {} } },
      };
      await applyEditorIR(next, f);
      await settle();
      expect(f.workspace.getBlockById('b')).not.toBeNull();
      expect(f.snapshot().meta?.name).toBe('After');
      f.workspace.undo(false);
      await settle();
      expect(f.workspace.getAllBlocks(false)).toHaveLength(0);
      expect(f.snapshot().meta?.name).toBe('Before');
      f.workspace.undo(true);
      await settle();
      expect(f.workspace.getBlockById('b')).not.toBeNull();
      expect(f.snapshot().meta?.name).toBe('After');
    } finally {
      f.workspace.dispose();
    }
  });
  it('rejected validation never mutates the canvas', async () => {
    const f = fixture();
    const before = f.snapshot();
    try {
      f.validate.mockRejectedValueOnce(new Error('invalid'));
      await expect(applyEditorIR({ ...before, meta: { name: 'Bad' } }, f)).rejects.toThrow(
        'invalid',
      );
      expect(f.snapshot()).toEqual(before);
    } finally {
      f.workspace.dispose();
    }
  });
  it('rejects stale results when the canvas changes during validation', async () => {
    const f = fixture();
    try {
      f.validate.mockImplementationOnce(async () => {
        f.commit({ ...f.snapshot(), meta: { name: 'User edit' } });
      });
      await expect(applyEditorIR(f.snapshot(), f)).rejects.toThrow('畫布已變更');
      expect(f.snapshot().meta?.name).toBe('User edit');
    } finally {
      f.workspace.dispose();
    }
  });
  it('a deserialization failure leaves existing block objects intact', async () => {
    const f = fixture();
    try {
      const block = f.workspace.newBlock('tx.value');
      const before = f.snapshot();
      const invalid: ProjectIR = {
        ...before,
        scripts: [{ id: 'bad', top: 'bad' }],
        blocks: { bad: { opcode: 'procedure.call', inputs: {} } },
      };
      await expect(applyEditorIR(invalid, f)).rejects.toThrow();
      expect(f.workspace.getBlockById(block.id)).toBe(block);
    } finally {
      f.workspace.dispose();
    }
  });
});
