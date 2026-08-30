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
export type Section = string | boolean;
export type Blocks = BlockSpec[];
export type Id1 = string;
export type Label3 = string;
export type Action = 'open_url' | 'open_config' | 'call' | 'create_procedure';
export type Url = string | null;
export type Handler = string | null;
export type Before = string | null;
export type After = string | null;
export type Buttons = ButtonSpec[];
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
  buttons?: Buttons;
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
  section?: Section;
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
 * **位置由 `before` / `after` 指名**（沒寫就是分類最上面，Scratch 放「製作積木」
 * 的位置）。它們指的是同一份 manifest 裡某顆積木的 opcode 短名——「這顆按鈕
 * 屬於那顆積木旁邊」，而不是「第 3 個位置」：宣告的是關係，序號會在別人插一顆
 * 積木時默默指到別的地方去。
 *
 * **刻意不做成一份 `toolbox:` 版面清單**，理由與 §7.2 對 `section` 的決定同一
 * 條：那份清單要把每顆積木再列一次，於是加一顆積木要改兩個地方，漏了就不會出現
 * 在工具箱裡——而「兩份會漂移」是這份文件反覆付過錢的東西。掛在按鈕上的一個
 * 可選欄位不動任何人。
 */
export interface ButtonSpec {
  id: Id1;
  label: Label3;
  action: Action;
  url?: Url;
  handler?: Handler;
  before?: Before;
  after?: After;
}

/** 這份檔案的入口型別。schema 的 `title` 決定了上面那個名字。 */
export type Manifest = BlockyExtensionManifest;
