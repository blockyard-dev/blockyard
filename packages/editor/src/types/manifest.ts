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
  | 'string'
  | 'number'
  | 'boolean'
  | 'dropdown'
  | 'secret'
  | 'object'
  | 'list'
  | 'json'
  | 'code'
  | 'variable'
  | 'stack'
  | 'expression';
export type Default1 = unknown;
export type Label1 = string | null;
export type Help1 = string | null;
export type Source = string | null;
export type Options = OptionSpec[] | null;
export type Value = string;
export type Label2 = string | null;
export type Field = boolean;
export type Binds = boolean;
export type Reads = boolean;
export type Multiline = boolean;
export type Rows = number | null;
export type Interpolate = boolean | null;
export type Min = number | null;
export type Max = number | null;
export type Returns = ('any' | 'number' | 'string' | 'boolean' | 'list' | 'object') | null;
export type Blocking = boolean;
export type Deprecated = boolean;
export type Dynamic = boolean;
export type Alsocommand = boolean;
export type Terminal = boolean;
export type Name1 = string;
export type Type3 = string;
export type Yields = YieldSpec[];
export type Concurrency = ('drop' | 'queue' | 'restart' | 'parallel') | null;
export type Button = string;
export type Label3 = string;
export type Action = 'open_url' | 'open_config' | 'call' | 'create_procedure';
export type Url = string | null;
export type Handler = string | null;
export type Section = string | boolean;
export type Palette = (BlockSpec | ButtonSpec | SectionSpec)[];
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
  palette?: Palette;
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
  alsoCommand?: Alsocommand;
  terminal?: Terminal;
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
  binds?: Binds;
  reads?: Reads;
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
/**
 * 工具箱裡的非積木條目（D25、§7.2）。
 *
 * 它**不是積木**：沒有輸入孔、沒有回傳值、不會出現在畫布上、不進 IR、不會被
 * Run 執行——「開說明文件」「測一下 token 對不對」硬做成積木就是把它塞進一個
 * 不屬於它的形狀。
 *
 * **位置就是它在 `palette` 裡的位置**（§7.2）——寫在哪兩顆積木中間，畫出來就在
 * 那裡。`button:` 這個 key 同時是條目的種類與它的 id。
 */
export interface ButtonSpec {
  button: Button;
  label: Label3;
  action: Action;
  url?: Url;
  handler?: Handler;
}
/**
 * 工具箱的分段（§7.2、§8.1）。
 *
 * `section: true` 只斷開，字串另外在上面放一行標題：
 *
 * ```yaml
 * palette:
 *   - opcode: divide
 *   - section: true        # 從這裡起是新的一段（只斷開）
 *   - opcode: gt
 *   - section: 文字        # 斷開，並在上面放一行標題
 *   - opcode: contains
 * ```
 *
 * 宣告的是**語意**（「這裡是一段的開頭」），不是版面——間隔多大、標題長什麼
 * 樣子由編輯器決定（`toolbox.ts`）。寫成 `gap: 24` 就是把留白的決定權發給每一
 * 個積木包作者，而使用者看到的是同一份工具箱。
 */
export interface SectionSpec {
  section: Section;
}

/** 這份檔案的入口型別。schema 的 `title` 決定了上面那個名字。 */
export type Manifest = BlockyExtensionManifest;
