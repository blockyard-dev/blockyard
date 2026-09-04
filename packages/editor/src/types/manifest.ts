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
export type Cover = string | null;
export type Permissions = ('net' | 'fs.read' | 'fs.write' | 'subprocess' | 'env')[];
export type Requirements = string[];
export type Key = string;
export type Type = 'string' | 'number' | 'boolean' | 'secret';
export type Label = string | null;
export type Help = string | null;
export type Default = unknown;
export type Envvar = string | null;
export type Config = ConfigSpec[];
export type Id1 = string;
export type Name1 = string;
export type Entry = string;
export type Panels = PanelSpec[];
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
export type Depends = string[] | null;
export type Field = boolean;
export type Binds = boolean;
export type Reads = boolean;
export type Scope = string | null;
export type Writes = boolean;
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
export type Name2 = string;
export type Type3 = string;
export type Yields = YieldSpec[];
export type Concurrency = ('drop' | 'queue' | 'restart' | 'parallel') | null;
export type Label3 = string;
export type Min1 = number;
export type Max1 = number;
export type Before = string | null;
export type Button = string;
export type Label4 = string;
export type Action = 'open_url' | 'open_config' | 'call' | 'create_procedure';
export type Url = string | null;
export type Handler = string | null;
export type Section = string | boolean;
export type Palette = (BlockSpec | ButtonSpec | SectionSpec)[];
export type Builtin = boolean;

/**
 * 一個命名空間的積木宣告。內建與積木包共用（設計文件 §7.2、D21）。
 */
export interface BlockyardExtensionManifest {
  manifestVersion?: Manifestversion;
  id: Id;
  name: Name;
  version: Version;
  author?: Author;
  description?: Description;
  color?: Color;
  cover?: Cover;
  permissions?: Permissions;
  requirements?: Requirements;
  config?: Config;
  panels?: Panels;
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
  envVar?: Envvar;
}
/**
 * 積木包在編輯器裡的一格分頁（§8.3、§16 Q17 的 B 路線）。
 *
 * **分頁是宣告出來的，不是資料生出來的。** 早期版本讓「畫一塊面板」的標題就是
 * 身分——畫幾塊就有幾格。那條路在標題可以插值的世界裡沒有底：一個
 * `在圖表 ${i} 加點` 的迴圈會生出無限多分頁，而補丁（數量上限、被擠掉的計數、
 * 橫向捲的分頁列）全部是在替一個錯的模型止血。宣告之後分頁數由**裝了幾個包**
 * 決定，那三個補丁一起消失。
 *
 * 它同時是「面板屬於積木包、不屬於專案」這句話的落點：`project.json` 一個字
 * 都不記面板，它只記 `extensions`（§13.3，而且是算出來的）。
 *
 * `entry` 是**必填**：編輯器不畫面板的內容，它只給這格一個 `sandbox` 的
 * iframe。早期版本讓「不寫 entry」退回一組內建 widget（折線／表格／數值卡），
 * 而那條路的代價是**每加一種圖表就要改編輯器一次**——一個想畫 three.js 的包
 * 永遠等不到那一天。現在編輯器不知道什麼是折線圖，那是包的 `ui/` 的事。
 */
export interface PanelSpec {
  id: Id1;
  name: Name1;
  entry: Entry;
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
  repeat?: RepeatSpec | null;
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
  depends?: Depends;
  field?: Field;
  binds?: Binds;
  reads?: Reads;
  scope?: Scope;
  writes?: Writes;
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
 *
 * **名字可以交給使用者取**（D32）：同一顆 hat 上宣告一格同名的
 * `type: variable` + `binds: true`，那一格填什麼，這個 yield 就綁成什麼。
 * 沒有那一格就照這裡寫的名字綁——`when_cron` 的 `scheduled_at` 是那種。
 */
export interface YieldSpec {
  name: Name2;
  type?: Type3;
}
/**
 * 一組**可以重複**的參數（§16 Q19）。
 *
 * 在這個宣告出現之前，一顆積木的形狀完全由 manifest 決定，而 manifest 是靜態
 * 的——`args` 是一個固定的 dict（D21：內建與積木包同一條路）。可重複群組是這
 * 條規則的第一個例外，所以它刻意收得很窄：
 *
 * - **一顆積木最多一個 `repeat`。** 兩組可重複的東西要兩排 `+` `−`，而「這顆
 *   `+` 加的是哪一組」在畫面上沒有便宜的答案。真的需要的話那是下一次的題目。
 * - **群組裡不能再有群組。** 同上，而且巢狀的計數要進 IR 兩層。
 * - **形狀不變。** 重複的是參數，不是積木的類型：一顆 command 按幾次 `+` 還是
 *   command。所以 D20 的形狀驗證一行都不用改。
 *
 * 展開後的參數名是 `<參數名>_<n>`，n 從 1 開始（見 `BlockSpec.repeat_arg_name`）。
 * 份數存在 IR 的 `mutation` 裡（`{"repeat": n}`），**不動頂層形狀**——那是
 * `procedure.call` 已經在用的地方。
 */
export interface RepeatSpec {
  args: Args1;
  label: Label3;
  min?: Min1;
  max?: Max1;
  before?: Before;
}
export interface Args1 {
  [k: string]: ArgSpec;
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
  label: Label4;
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
export type Manifest = BlockyardExtensionManifest;
