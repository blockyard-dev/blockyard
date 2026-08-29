/**
 * 自動產生，不要手改。
 *
 * 來源：packages/shared-schema/project.schema.json
 * 重新產生：cd packages/editor && npm run gen:types
 */
export type Formatversion = number;
export type Id = string;
export type Name = string;
export type Createdat = string | null;
export type Updatedat = string | null;
export type Id1 = string;
export type Version = string;
export type Extensions = ExtensionRef[];
export type Firstseen = string | null;
export type Name1 = string;
export type Id2 = string;
export type Name2 = string;
export type Type = string;
export type Params = ProcParam[];
export type Returns = ('any' | 'number' | 'string' | 'boolean' | 'list' | 'object') | null;
export type Body = string | null;
export type Definitionblock = string | null;
export type X = number;
export type Y = number;
export type Id3 = string;
export type Top = string;
export type X1 = number;
export type Y1 = number;
export type Enabled = boolean;
export type Scripts = Script[];
export type Opcode = string;
export type Parent = string | null;
export type Next = string | null;
export type Kind = 'literal';
export type Value = unknown;
export type Kind1 = 'template';
export type Value1 = string;
export type Refs = {
  [k: string]: unknown;
}[];
export type Whole = boolean;
export type Kind2 = 'block';
export type Id4 = string;
export type Kind3 = 'stack';
export type Id5 = string | null;
export type Mutation = {
  [k: string]: unknown;
} | null;
export type Ui = {
  [k: string]: unknown;
} | null;

/**
 * 積木專案的中介表示（IR）。設計文件 §4。
 */
export interface BlockyProjectIR {
  formatVersion?: Formatversion;
  meta?: Meta;
  extensions?: Extensions;
  variables?: Variables;
  procedures?: Procedures;
  scripts?: Scripts;
  blocks?: Blocks;
}
export interface Meta {
  id?: Id;
  name?: Name;
  createdAt?: Createdat;
  updatedAt?: Updatedat;
  [k: string]: unknown;
}
export interface ExtensionRef {
  id: Id1;
  version: Version;
}
export interface Variables {
  [k: string]: VariableIndex;
}
/**
 * §4.5：這**不是宣告的結果，而是索引**。
 *
 * 存檔時掃過所有積木彙整而成，只供變數監看面板、名稱自動完成與靜態檢查使用。
 * 刪掉整個欄位再重新產生不影響執行語意。
 */
export interface VariableIndex {
  firstSeen?: Firstseen;
}
export interface Procedures {
  [k: string]: Procedure;
}
/**
 * 一個自訂函式（§4.6）。
 *
 * `name` 是一份**簽章模板**而不是一個名字（D26）：`"跳 %(a1) 次 到 %(a2)"`
 * 畫出來是 `跳 (10) 次 到 [左]`。佔位符引用的是參數的 **id**，不是名稱——
 * 名稱是使用者隨時會改的東西，而模板不該跟著壞掉。
 *
 * 一個 `%(` 都沒有的簽章是**合法的相容模式**（排版退回
 * `呼叫 <名稱> 參數名: (孔)`），不是舊資料：AI 生成的 IR（D5）多半長那樣。
 */
export interface Procedure {
  name: Name1;
  params?: Params;
  returns?: Returns;
  body?: Body;
  definitionBlock?: Definitionblock;
  x?: X;
  y?: Y;
}
export interface ProcParam {
  id: Id2;
  name: Name2;
  type?: Type;
}
export interface Script {
  id: Id3;
  top: Top;
  x?: X1;
  y?: Y1;
  enabled?: Enabled;
}
export interface Blocks {
  [k: string]: Block;
}
export interface Block {
  opcode: Opcode;
  parent?: Parent;
  next?: Next;
  inputs?: Inputs;
  fields?: Fields;
  mutation?: Mutation;
  ui?: Ui;
}
export interface Inputs {
  [k: string]: LiteralInput | TemplateInput | BlockInput | StackInput;
}
/**
 * 使用者直接輸入的值。
 *
 * §4.7：`literal` 維持「笨資料」——解譯器**不掃描它找 `${`**。含插值的
 * 字串在存檔時就會被解析成 TemplateInput，因此一個正當寫著 `${HOME}` 的
 * shell 指令不會被偷偷替換。
 */
export interface LiteralInput {
  kind?: Kind;
  value?: Value;
}
/**
 * 含 `${}` 插值的字串（§4.7）。
 */
export interface TemplateInput {
  kind?: Kind1;
  value: Value1;
  refs?: Refs;
  whole?: Whole;
}
/**
 * 由 reporter / boolean 積木求值。
 */
export interface BlockInput {
  kind?: Kind2;
  id: Id4;
}
/**
 * C 型積木的內部堆疊（迴圈體、if 分支）。
 */
export interface StackInput {
  kind?: Kind3;
  id?: Id5;
}
export interface Fields {
  [k: string]: unknown;
}

/** 這份檔案的入口型別。schema 的 `title`（"Blocky Project IR"）決定了上面那個名字。 */
export type ProjectIR = BlockyProjectIR;
