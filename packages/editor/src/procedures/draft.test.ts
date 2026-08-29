/**
 * 簽章模板與「創建積木」對話框的編輯模型（§4.6、§8.5、D26）。
 *
 * 兩層：純函數那一半（分段 ↔ IR、驗證）直接測；預覽積木那一半走**真的工作
 * 區**——把積木建出來、讀回欄位、再存成 IR。只驗「產生的定義長什麼樣」會漏
 * 掉這個對話框真正的來源：使用者打的字在**積木上**，不在 draft 裡。
 */
import * as Blockly from 'blockly/core';
import { describe, expect, it } from 'vitest';
import {
  buildDeclaration,
  defineDeclarationShadows,
  readSegmentTexts,
} from '../blockly/declaration';
import { SHADOW_FIELD } from '../blockly/define';
import { callText, definitionText, displayName } from '../blockly/signature';
import {
  addLabel,
  addParam,
  applyTexts,
  blankDraft,
  draftIssue,
  fromProcedure,
  nextParamId,
  removeSegment,
  setSegmentType,
  toProcedure,
  type Draft,
} from './draft';
import type { Procedure } from '../types/project';

const JUMP: Procedure = {
  name: '跳 %(a1) 次 到 %(a2)',
  params: [
    { id: 'a1', name: '次數', type: 'number' },
    { id: 'a2', name: '方向', type: 'string' },
  ],
  returns: null,
};

/** 相容模式：一個 `%(` 都沒有的簽章（D5 生成的 IR 多半長這樣）。 */
const SUM: Procedure = {
  name: '加總',
  params: [{ id: 'a1', name: '清單', type: 'list' }],
  returns: 'number',
};

describe('簽章模板（D26）', () => {
  it('呼叫積木的文字就是模板本身', () => {
    expect(callText(JUMP)).toBe('跳 %(a1) 次 到 %(a2)');
  });

  it('沒有佔位符時退回相容排版，不是壞掉', () => {
    expect(callText(SUM)).toBe('呼叫 加總 清單: %(a1)');
  });

  it('沒有參數的函式，簽章就是整顆積木的文字', () => {
    // 相容排版只在「有參數、但簽章沒說它們排在哪裡」時才需要。沒有參數時
    // 補一個「呼叫」是多的——Scratch 的無參數自訂積木也只畫名字。
    expect(callText({ name: '打招呼', params: [], returns: null })).toBe('打招呼');
  });

  it('顯示用的名稱把 id 換成參數名——畫面上不該出現 IR 的 key', () => {
    expect(displayName(JUMP)).toBe('跳 (次數) 次 到 (方向)');
    expect(displayName(SUM)).toBe('加總 (清單)');
  });

  it('定義帽子與呼叫積木是同一份模板，只多一個動詞', () => {
    // `%()` 沒有換成名字：帽子上那幾格是**真的輸入孔**，裡面放的是拖得出去
    // 的參數晶片（§4.6、`blockly/params.ts`）。畫出來讀起來仍然是
    // 「定義 跳 (次數) 次 到 (方向)」——括號裡那顆是積木不是文字。
    expect(definitionText(JUMP)).toBe('定義 跳 %(a1) 次 到 %(a2)');
    expect(callText(JUMP)).toBe('跳 %(a1) 次 到 %(a2)');
  });

  it('沒有模板的相容排版，帽子與呼叫排一樣的版', () => {
    const proc = { name: '加總', params: [{ id: 'a1', name: '清單', type: 'list' as const }], returns: null };
    expect(definitionText(proc)).toBe('定義 加總 清單: %(a1)');
    expect(callText(proc)).toBe('呼叫 加總 清單: %(a1)');
  });
});

describe('IR ↔ 分段', () => {
  it('模板拆成 [標籤][參數][標籤][參數]', () => {
    expect(fromProcedure(JUMP).segments).toEqual([
      { kind: 'label', text: '跳' },
      { kind: 'param', id: 'a1', name: '次數', type: 'number' },
      { kind: 'label', text: '次 到' },
      { kind: 'param', id: 'a2', name: '方向', type: 'string' },
    ]);
  });

  it('來回不變形', () => {
    expect(toProcedure(fromProcedure(JUMP))).toEqual({
      name: JUMP.name,
      params: JUMP.params,
      returns: null,
    });
  });

  it('相容模式還原成「名字 + 依序排開的參數」', () => {
    const draft = fromProcedure(SUM);
    expect(draft.segments).toEqual([
      { kind: 'label', text: '加總' },
      { kind: 'param', id: 'a1', name: '清單', type: 'list' },
    ]);
    // 按下確定就升級成模板——那是一次明確的編輯，不是偷偷改寫。
    expect(toProcedure(draft).name).toBe('加總 %(a1)');
  });

  it('沒有參數的函式存出來就是一個名字，不帶佔位符', () => {
    const draft: Draft = { segments: [{ kind: 'label', text: '打招呼' }], returns: null };
    expect(toProcedure(draft).name).toBe('打招呼');
  });

  it('模板漏掉的參數留著，不會因為打開一次對話框就消失', () => {
    // 後端存檔時就擋（§4.6），所以這是「真的拿到了壞資料」的處置。
    const broken: Procedure = { ...JUMP, name: '跳 %(a1) 次' };
    const draft = fromProcedure(broken);
    expect(draft.segments.filter((s) => s.kind === 'param')).toHaveLength(2);
  });
});

describe('版面編輯', () => {
  it('加參數用沒被佔走的 id', () => {
    const draft = fromProcedure(JUMP);
    expect(nextParamId(draft)).toBe('a3');
    expect(toProcedure(addParam(draft, 'boolean')).name).toBe('跳 %(a1) 次 到 %(a2) %(a3)');
  });

  it('刪掉中間那一格，簽章跟著少一段', () => {
    const draft = removeSegment(fromProcedure(JUMP), 1);
    const proc = toProcedure(draft);
    expect(proc.name).toBe('跳 次 到 %(a2)');
    expect(proc.params).toHaveLength(1);
  });

  it('說明文字是模板裡的一段純文字，不是第三種參數', () => {
    const proc = toProcedure(addLabel(fromProcedure(SUM)));
    expect(proc.params).toHaveLength(1);
    expect(proc.name).toBe('加總 %(a1) 說明文字');
  });

  it('換型別只動那一格', () => {
    const draft = setSegmentType(fromProcedure(JUMP), 1, 'boolean');
    expect(toProcedure(draft).params?.[0]?.type).toBe('boolean');
  });

  it('參數名稱套 §4.5 的字元限制', () => {
    const draft = applyTexts(fromProcedure(JUMP), { 1: ' 次 數${x}. ' });
    expect(toProcedure(draft).params?.[0]?.name).toBe('次 數x');
  });
});

describe('存不存得下去（draftIssue）', () => {
  it('至少要有一段名字', () => {
    const draft: Draft = { segments: [{ kind: 'label', text: '  ' }], returns: null };
    expect(draftIssue(draft)).toMatch('名字');
  });

  it('說明文字不能含 %(——那會讓簽章引用一個不存在的參數', () => {
    const draft: Draft = { segments: [{ kind: 'label', text: '折扣 %(x)' }], returns: null };
    expect(draftIssue(draft)).toMatch('%(');
  });

  it('單獨的 % 沒問題', () => {
    const draft: Draft = { segments: [{ kind: 'label', text: '折扣 50%' }], returns: null };
    expect(draftIssue(draft)).toBeNull();
  });

  it('參數名稱不能重複——函式體讀的是名字', () => {
    const draft = applyTexts(fromProcedure(JUMP), { 1: '同名', 3: '同名' });
    expect(draftIssue(draft)).toMatch('重複');
  });

  it('參數名稱不能是空的', () => {
    expect(draftIssue(applyTexts(fromProcedure(JUMP), { 1: '' }))).toMatch('名字');
  });

  it('預設的那份 draft 直接存得下去', () => {
    expect(draftIssue(blankDraft())).toBeNull();
  });
});

describe('預覽積木', () => {
  function build(draft: Draft): { workspace: Blockly.Workspace; block: Blockly.Block } {
    defineDeclarationShadows();
    const workspace = new Blockly.Workspace();
    const built = buildDeclaration(draft);
    const block = Blockly.serialization.blocks.append(built.state, workspace);
    return { workspace, block };
  }

  it('標籤是欄位、參數是孔裡的一顆白色名稱格', () => {
    const { block } = build(fromProcedure(JUMP));
    expect(block.getFieldValue('s0')).toBe('跳');
    expect(block.getInput('s1')?.connection?.targetBlock()?.getFieldValue(SHADOW_FIELD)).toBe('次數');
    expect(block.getFieldValue('s2')).toBe('次 到');
  });

  it('形狀跟著「有沒有回傳值」走', () => {
    expect(build({ ...fromProcedure(JUMP), returns: null }).block.outputConnection).toBeNull();
    expect(build({ ...fromProcedure(JUMP), returns: 'number' }).block.outputConnection).not.toBeNull();
    // 布林回傳值是六角形，與 §4.6 的呼叫積木一致。
    expect(build({ ...fromProcedure(JUMP), returns: 'boolean' }).block.outputConnection?.getCheck())
      .toEqual(['Boolean']);
  });

  it('布林參數的名稱格也是六角形——預覽不在形狀上說謊', () => {
    const { block } = build(setSegmentType(fromProcedure(JUMP), 1, 'boolean'));
    const shadow = block.getInput('s1')?.connection?.targetBlock();
    expect(shadow?.outputConnection?.getCheck()).toEqual(['Boolean']);
    expect(shadow?.getFieldValue(SHADOW_FIELD)).toBe('次數');
  });

  it('積木上改的字讀得回來，而且存得成 IR', () => {
    const draft = fromProcedure(JUMP);
    const { block } = build(draft);

    // 使用者在預覽上打字：真相在積木上，不在 draft 裡。
    block.setFieldValue('飛', 's0');
    block.getInput('s1')?.connection?.targetBlock()?.setFieldValue('回數', SHADOW_FIELD);

    const proc = toProcedure(applyTexts(draft, readSegmentTexts(block, draft)));
    expect(proc.name).toBe('飛 %(a1) 次 到 %(a2)');
    expect(proc.params?.[0]?.name).toBe('回數');
  });
});
