/**
 * 自動產生，不要手改。
 *
 * 來源：packages/shared-schema/manifest.schema.json
 * 重新產生：cd packages/editor && npm run gen:types
 */
export type Manifestversion = 1;
export type Id = string;
export type Name = string;
export type Version = string;
export type Author = string | null;
export type Description = string | null;
export type Color = string | null;
export type Permissions = ('net' | 'fs.read' | 'fs.write' | 'subprocess' | 'env')[];
export type Requirements = string[];
export type Key = string;
export type Type = 'string' | 'number' | 'boolean' | 'secret';
export type Label = string | null;
export type Help = string | null;
export type Default = unknown;
export type Config = ConfigSpec[];
export type Opcode = string;
export type Type1 = 'command' | 'reporter' | 'boolean' | 'hat';
export type Text = string;
export type Type2 =
  'string' | 'number' | 'boolean' | 'dropdown' | 'secret' | 'object' | 'list' | 'json' | 'code' | 'variable' | 'stack';
export type Default1 = unknown;
export type Label1 = string | null;
export type Help1 = string | null;
export type Source = string | null;
export type Options = OptionSpec[] | null;
export type Value = string;
export type Label2 = string | null;
export type Field = boolean;
export type Multiline = boolean;
export type Rows = number | null;
export type Interpolate = boolean | null;
export type Min = number | null;
export type Max = number | null;
export type Returns = ('any' | 'number' | 'string' | 'boolean' | 'list' | 'object') | null;
export type Blocking = boolean;
export type Deprecated = boolean;
export type Dynamic = boolean;
export type Name1 = string;
export type Type3 = string;
export type Yields = YieldSpec[];
export type Concurrency = ('drop' | 'queue' | 'restart' | 'parallel') | null;
export type Blocks = BlockSpec[];
export type Builtin = boolean;

/**
 * 一個命名空間的積木宣告。內建與積木包共用（設計文件 §7.2、D21）。
 */
export interface BlockyExtensionManifest {
  manifestVersion?: Manifestversion;
  id: Id;
  name: Name;
  version: Version;
  author?: Author;
  description?: Description;
  color?: Color;
  permissions?: Permissions;
  requirements?: Requirements;
  config?: Config;
  blocks?: Blocks;
  builtin?: Builtin;
}
/**
 * 使用者要填的設定。`secret` 型別存進金鑰庫（§12.1）。
 */
export interface ConfigSpec {
  key: Key;
  type?: Type;
  label?: Label;
  help?: Help;
  default?: Default;
}
/**
 * 一顆積木的宣告。`opcode` 是**不帶命名空間**的短名。
 */
export interface BlockSpec {
  opcode: Opcode;
  type: Type1;
  text: Text;
  args?: Args;
  returns?: Returns;
  blocking?: Blocking;
  deprecated?: Deprecated;
  dynamic?: Dynamic;
  yields?: Yields;
  concurrency?: Concurrency;
}
export interface Args {
  [k: string]: ArgSpec;
}
/**
 * 一個參數的宣告。
 */
export interface ArgSpec {
  type: Type2;
  default?: Default1;
  label?: Label1;
  help?: Help1;
  source?: Source;
  options?: Options;
  field?: Field;
  multiline?: Multiline;
  rows?: Rows;
  interpolate?: Interpolate;
  min?: Min;
  max?: Max;
}
/**
 * 靜態下拉的一個選項（內建積木用）。
 *
 * 積木包的下拉是**動態**的（`source` 指向 `@dropdown` 函式），因為選項來自
 * 外部服務；內建積木的下拉是**固定**的（`unit` 只有那六個），選項就是宣告的
 * 一部分，沒有人可以去問。
 */
export interface OptionSpec {
  value: Value;
  label?: Label2;
}
/**
 * hat 綁進 thread-local 的變數（§5.4 第 2 層，唯讀）。
 */
export interface YieldSpec {
  name: Name1;
  type?: Type3;
}

/** 這份檔案的入口型別。schema 的 `title` 決定了上面那個名字。 */
export type Manifest = BlockyExtensionManifest;
