import * as Blockly from 'blockly/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerManifests } from './setup';
import { buildContext } from '../ir/context';
import { loadProject } from '../ir/deserialize';
import { serializeWorkspace } from '../ir/serialize';
import { jsonParseCandidates, matchesJsonContainer, wrapJsonText } from './jsonParse';
import type { Manifest } from '../types/manifest';
import type { BlockyardProjectIR as ProjectIR } from '../types/project';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILTINS = resolve(HERE, '../../../../backend/blockyard/interpreter/builtins');
const PANEL = resolve(HERE, '../../../../backend/blockyard/_bundled/panel/manifest.yaml');
let ctx: ReturnType<typeof buildContext>;

beforeAll(() => {
  const manifests = [
    ...readdirSync(BUILTINS).filter((f) => f.endsWith('.yaml'))
      .map((f) => parseYaml(readFileSync(join(BUILTINS, f), 'utf8')) as Manifest),
    parseYaml(readFileSync(PANEL, 'utf8')) as Manifest,
  ];
  ctx = buildContext(registerManifests(manifests).blocks);
});

function lineChart(text: string) {
  const workspace = new Blockly.Workspace();
  const project: ProjectIR = {
    formatVersion: 1, meta: { id: 'p', name: 'p' },
    extensions: [{ id: 'panel', version: '0.1.0' }], variables: {}, procedures: {},
    scripts: [{ id: 's', top: 'chart', x: 0, y: 0 }],
    blocks: { chart: { opcode: 'panel.line_chart', parent: null, next: null,
      inputs: { data: { kind: 'literal', value: text } }, fields: {}, mutation: null, ui: null } },
  };
  loadProject(project, workspace, ctx);
  return { workspace, block: workspace.getBlockById('chart')! };
}

describe('JSON 容器判斷', () => {
  it('依 list / object / json 區分根節點', () => {
    expect(matchesJsonContainer('[1, 2, 3]', 'list')).toBe(true);
    expect(matchesJsonContainer('{"a": 1}', 'list')).toBe(false);
    expect(matchesJsonContainer('{"a": 1}', 'object')).toBe(true);
    expect(matchesJsonContainer('[]', 'object')).toBe(false);
    expect(matchesJsonContainer('null', 'object')).toBe(false);
    expect(matchesJsonContainer('[]', 'json')).toBe(true);
    expect(matchesJsonContainer('{}', 'json')).toBe(true);
    expect(matchesJsonContainer('12', 'json')).toBe(false);
    expect(matchesJsonContainer('[', 'json')).toBe(false);
  });
});

describe('積木上方的解析提示', () => {
  it('只有型別相符的合法 JSON 文字會成為候選', () => {
    expect(jsonParseCandidates(lineChart('[3, 1, 4]').workspace, ctx)).toMatchObject([
      { blockId: 'chart', inputName: 'data', expected: 'list', text: '[3, 1, 4]' },
    ]);
    expect(jsonParseCandidates(lineChart('{"a": 1}').workspace, ctx)).toEqual([]);
    expect(jsonParseCandidates(lineChart('還沒打完[').workspace, ctx)).toEqual([]);
  });

  it('按下後建立解析積木，並把原文字搬進去', () => {
    const { workspace, block } = lineChart('[3, 1, 4]');
    const shadow = block.getInput('data')!.connection!.targetBlock()!;
    const parser = wrapJsonText(shadow, 'list');
    expect(block.getInput('data')!.connection!.targetBlock()).toBe(parser);

    const saved = serializeWorkspace(workspace, ctx, { meta: { id: 'p', name: 'p' } });
    expect(saved.blocks?.chart?.inputs?.data).toMatchObject({ kind: 'block', id: parser!.id });
    expect(saved.blocks?.[parser!.id]?.inputs?.text).toEqual({
      kind: 'literal', value: '[3, 1, 4]',
    });
  });
});
