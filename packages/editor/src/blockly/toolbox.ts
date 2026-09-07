import type { Manifest } from '../types/manifest';
/**
 * manifest → 工具箱分類（§8.1 第 3 步）。
 *
 * 一份 manifest 一個分類，順序照 `GET /api/extensions` 吐出來的順序——後端
 * 已經把內建排在積木包前面（`api/extensions.py`），前端不再重排。
 */
import { isButtonEntry, isSectionEntry, type RegisteredBlock } from './define';
import { keyId } from '../api/client';
import type { ButtonSpec, ConfigSpec, Palette, PanelSpec } from '../types/manifest';

export interface ToolboxGroup {
  id: string;
  name: string;
  colour: string;
  builtin: boolean;
  /** 這個包宣告了哪幾格面板（§8.3）。**分頁是宣告出來的，不是資料生出來的。** */
  panels: PanelSpec[];
  /** manifest 的 `version` 與 `description`。**擴充功能面板要它們**——那張卡片
   * 上除了名字與顏色之外的全部文字都是這兩個欄位，而面板手邊只有分類。
   * 從 `blocks[0].manifest` 撈也拿得到，但那是「這個分類某一顆積木的 manifest」
   * ——一個分類的版本不是它第一顆積木的性質（同 `secrets` 放在這裡的理由）。 */
  version: string;
  description: string | null;
  /** manifest 的 `cover`：擴充功能面板那張卡上 16:9 那格要畫的圖，沒宣告就是
   * `null`（那格畫名字的第一個字）。
   *
   * **這裡放的是 manifest 原值，但沒有人拿它組網址**——封面的端點是
   * `/api/extensions/<id>/cover`，路徑由後端從 manifest 讀，request 一個字都不
   * 帶（見 `api/extensions.py::get_cover`）。所以這個欄位在前端唯一的用途是
   * 「這個包有沒有宣告封面」。留著原值而不是折成 boolean，是為了它跟
   * `version`／`description` 一樣讀得出自己是 manifest 的哪一格。 */
  cover: string | null;
  /** 這個分類註冊得出來的積木（`dynamic` 的不在裡面）。 */
  blocks: RegisteredBlock[];
  /** manifest 的 `palette`：積木、按鈕、分段的**順序**（§7.2）。 */
  palette: Palette;
  /** 純按鈕的 view，給 `App.tsx` 註冊回呼用。 */
  buttons: ButtonSpec[];
  /** manifest 的 `config` 裡的 secret 項（§12.1）。
   *
   * `open_config` 那顆按鈕要打開的就是這一把——而**按鈕本身說不出是哪一把**
   * （`ButtonSpec` 只有 id、label、action），所以那個資訊只能從這裡來。放在
   * 分類上而不是每次去 `blocks[0].manifest` 撈，是因為它是**這個分類**的性質，
   * 不是它某一顆積木的。 */
  secrets: ConfigSpec[];
}

/**
 * 一顆按鈕在 Blockly 註冊表裡的 key。
 *
 * 帶命名空間，因為兩個積木包都可以有一顆 id 是 `docs` 的按鈕，而
 * `registerButtonCallback` 是**整個工作區共用一張表**。
 */
export function buttonCallbackKey(manifestId: string, buttonId: string): string {
  return `blockyard:${manifestId}:${buttonId}`;
}

const DEFAULT_COLOUR = '#9966FF';

/** 「一把金鑰都還沒設定」。常數而不是每次 `new Set()`：`buildToolbox` 的預設
 * 值要是每次都換一個新物件，`App.tsx` 那個「這份工具箱是用哪一份名單畫的」
 * 的比對就永遠不相等。 */
const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * `open_config` 那顆按鈕會打開的是哪一把金鑰。
 *
 * 按鈕自己說不出來（`ButtonSpec` 只有 id、label、action），所以答案在 manifest
 * 的 `config` 裡——刻意的：一顆按鈕能指定金鑰，就等於一個包能送使用者去設定
 * 別人的那一把。宣告了兩把 secret 的包取第一把。
 *
 * 這個函式同時是 `App.tsx`（要開哪一格）與下面 `categoryEntries`（按鈕還要不要
 * 畫）的答案，寫成一份是因為那兩個問題的答案**必須**是同一把：不同的話，症狀
 * 是按鈕永遠不消失，或者消失了卻還有一把沒設定。
 */
export function configTarget(group: ToolboxGroup): ConfigSpec | undefined {
  return group.secrets[0];
}

export function groupByManifest(blocks: RegisteredBlock[], manifests: readonly Manifest[] = blocks.map((b) => b.manifest)): ToolboxGroup[] {
  const groups = new Map<string, ToolboxGroup>();
  for (const manifest of manifests) {
    if (groups.has(manifest.id)) continue;
    groups.set(manifest.id, {
      id: manifest.id, name: manifest.name, colour: manifest.color ?? DEFAULT_COLOUR,
      builtin: manifest.builtin === true, panels: manifest.panels ?? [],
      version: manifest.version, description: manifest.description ?? null,
      cover: manifest.cover ?? null, blocks: [], palette: manifest.palette ?? [],
      buttons: (manifest.palette ?? []).filter(isButtonEntry),
      secrets: (manifest.config ?? []).filter((c) => c.type === 'secret'),
    });
  }
  for (const block of blocks) groups.get(block.manifest.id)?.blocks.push(block);
  return [...groups.values()];
}

/**
 * `deprecated: true` 的積木**註冊但不上架**：舊專案載得進來（不然會變成
 * §13.3 的未知積木），但沒有人能再拉出新的一顆。
 */
/**
 * 「讀一個變數」的那顆積木。**目前沒有人呼叫它**（見下）。
 *
 * 它是為了「函式分類要為每個參數各列一顆填好名字的 `取得 (參數名)`」而寫的
 * ——**不寫死 `data.get`**，讀的是 manifest 的 `reads` 宣告，與 `binds` 是同
 * 一條路線（D21：前端不認識任何一個 opcode）。一度想用推導（「reporter + 唯一
 * 參數是非 binds 的 variable」），但那條規則同時命中 `data.list_length`——
 * 宣告一模一樣，差別只在回傳的是值還是長度。所以它是一句宣告，不是一條猜測。
 *
 * **那個使用者沒了**：第五輪回饋把函式分類裡的參數改成與定義帽子上一樣的
 * `procedure.param` 膠囊（§4.6），不再是 `取得 (參數名)`。這個函式與它背後的
 * `reads` 宣告都留著——`reads` 說的仍然是一件真話，而「函式分類的介面之後還
 * 要改」——但它現在沒有消費者，記在 PROGRESS 第 2 節。
 */
export function findVariableReader(blocks: RegisteredBlock[]): { type: string; arg: string } | null {
  for (const block of blocks) {
    for (const [name, arg] of Object.entries(block.spec.args ?? {})) {
      if (arg.reads) return { type: block.type, arg: name };
    }
  }
  return null;
}

/**
 * 這個分類**收得起來嗎**（D31 的名單管不管得到它）。
 *
 * 抽成一份的理由是它有四個消費者——工具箱、擴充功能面板的卡片牆、分類欄右鍵
 * 選單、標頭那行計數。曾經有一版讓某些內建也收得起來，而那一版只接了前兩個：
 * 面板上加得進來、右鍵卻刪不掉。**一條規則的兩半分開走，其中一半會安靜地不
 * 存在**，而這次那一半是使用者按下右鍵才發現的。判準後來簡化掉了（面板搬進
 * `extensions/` 之後就是一般積木包），這個名字留著——四個消費者仍然在。
 */
export function isRemovable(group: ToolboxGroup): boolean {
  return !group.builtin;
}

/**
 * 工具箱上**這一刻該有的**那幾個分類（D31）。
 *
 * 內建的永遠在——它們是這個語言本身，沒有「要不要裝」這個問題。積木包則要
 * 先在擴充功能面板裡加進來：後端 `discover()` 到的每一個包都會被註冊（舊專案
 * 才載得進來，§13.3），但**註冊不等於上架**。
 *
 * **例外是宣告了 `optional` 的內建**（`panel`）。`builtin` 一直同時兼著兩件
 * 事：誰有權宣告內建專用的東西（D22），以及誰的分類永遠在工具箱上。這一格把
 * 後者分出來——面板是這個語言的一部分（積木包也用得到，走 `ctx.panel()`），
 * 但一個不畫圖表的人不需要那格分類一直佔著 60px 寬的那一直排。
 *
 * `enabled` 是 `undefined` 時全部都在。那不是「預設全開」的偏好，是**這個函式
 * 的呼叫者還沒有名單**：`registerManifests` 在載入專案之前就先畫一份工具箱，
 * 而那一份的用途只是讓 `Registration` 的形狀完整，畫面上那份永遠是
 * `buildProjectToolbox` 重畫的。
 */
export function visibleGroups(
  groups: ToolboxGroup[],
  enabled?: ReadonlySet<string>,
): ToolboxGroup[] {
  const shown = enabled
    ? groups.filter((group) => !isRemovable(group) || enabled.has(group.id))
    : groups;
  // **收得起來的一律排在最後。** 使用者對這一欄的心智模型是「上面是語言、下面
  // 是我裝的東西」，而順序來自後端的 manifest 順序——那份順序現在剛好是對的，
  // 但這條讓它不再是「剛好」。stable partition，兩邊各自的相對順序都不動。
  return [...shown.filter((g) => !isRemovable(g)), ...shown.filter(isRemovable)];
}

/**
 * @param configured 已經設定好的金鑰（`keyId`）。`open_config` 的按鈕**設定完
 *   就收起來**（見 `categoryEntries`）。
 */
export function buildToolbox(
  groups: ToolboxGroup[],
  configured: ReadonlySet<string> = EMPTY,
): Record<string, unknown> {
  return {
    kind: 'categoryToolbox',
    contents: groups
      .filter((group) => group.palette.length > 0)
      .map((group) => ({
        kind: 'category',
        name: group.name,
        colour: group.colour,
        // Blockly 認得這個 key（`toolboxitemid || genUid()`），它讓一個分類的
        // DOM 問得回**是哪一個命名空間**——右鍵選單要的就是這件事。沒有它就
        // 只能拿分類名去比對文字，而名字是 manifest 寫的、可以重複。
        toolboxitemid: group.id,
        // `container` 會**取代**掉 Blockly 的預設 class，而不是加上去。Blockly
        // 自己那條「鍵盤導覽時把瀏覽器的預設焦點框關掉」的規則正好掛在
        // `.blocklyToolboxCategoryContainer:focus-visible` 上——只寫
        // `blockyard-category` 等於把那條規則甩掉，症狀是按方向鍵走到哪一格，那格
        // 就多一圈藍色的系統焦點框（實測）。**兩個 class 都要留著。**
        cssConfig: { container: 'blocklyToolboxCategoryContainer blockyard-category' },
        contents: categoryEntries(group, configured),
      }))
      .filter((category) => category.contents.length > 0),
  };
}

/**
 * flyout 的三種垂直間隔，單位是工作區單位（螢幕上還要乘 flyout 的縮放，見
 * `theme.ts` 的 `DEFAULT_SCALE`）。
 *
 * Blockly 的預設對每個條目都是 `Flyout.GAP_Y`（`MARGIN * 3` = 24），對這份工具箱
 * 來說太鬆，而且它讓「同一組運算」與「換一組」看起來一樣遠。這裡把距離變成一句
 * 話：**近的是一段，遠的是換一段**。
 *
 * 版面數字只有這裡有。manifest 的 `section` 說的是語意（§7.2）——哪裡是一段的
 * 開頭；多遠、標題長什麼樣子是編輯器的事，不然每個積木包各自決定留白。
 *
 * `BLOCK_GAP` **不能寫 0**：`BlockFlyoutInflater.gapForItem` 是
 * `!gap ? default : gap`，0 會被當成沒設定而退回 24。`kind: 'sep'` 那兩個沒有這
 * 條（`SeparatorFlyoutInflater` 收得下 0）。
 */
export const BLOCK_GAP = 12;
const SECTION_GAP = 40;
const LABEL_GAP = 8;

/**
 * 一個分類的全部條目，**照 manifest 的 `palette` 順序**（§7.2、§8.1、D25）。
 *
 * `palette` 是一份清單、三種條目：積木、按鈕、分段。寫在哪兩顆積木中間，畫出來
 * 就在那裡——所以這個函式沒有版面決策，只有展開：
 *
 * - **積木**：查得到註冊資訊、而且沒有 `deprecated` 才畫（`deprecated: true` 是
 *   「註冊但不上架」，舊專案載得進來但沒有人能再拉出新的一顆，§13.1）。`dynamic`
 *   的積木根本沒被註冊（`define.ts`），所以也查不到。
 * - **分段**：`sep`（+ 選填的標題）。相鄰的兩個 sep 由 Blockly 的
 *   `normalizeSeparators` 收成一個，而它 `splice` 掉的是**前面**那個——所以我們插
 *   的 sep 蓋掉上一顆積木自帶的 `BLOCK_GAP`，是取代不是相加。標題底下再補一個
 *   `LABEL_GAP`，同樣蓋掉 label 自帶的預設 24：標題要貼近它說明的那一段，不然它
 *   看起來像上一段的結尾。**分類的第一個條目不插 sep**——分類標題本身已經是斷點。
 * - **按鈕**：一個 `kind: 'button'` 條目。
 *
 * 版面數字（12 / 40 / 8）只有這裡有。manifest 說的是語意（「這裡是一段」「這裡
 * 有一顆按鈕」），多寬、標題長什麼樣子由編輯器決定，否則每個積木包各自決定留白。
 */
function categoryEntries(
  group: ToolboxGroup,
  configured: ReadonlySet<string>,
): Record<string, unknown>[] {
  // 用 Blockly 的 type 而不是 opcode 當 key：`procedure.call#p_x` 有很多顆，而它們
  // 的 `spec.opcode` 全都是 `call`（見下面那段「專案資料生成的積木」）。
  const registered = new Map(group.blocks.map((block) => [block.type, block]));
  const rendered = new Set<string>();
  const entries: Record<string, unknown>[] = [];

  for (const entry of group.palette) {
    if (isSectionEntry(entry)) {
      if (entries.length > 0) entries.push({ kind: 'sep', gap: SECTION_GAP });
      if (typeof entry.section === 'string') {
        entries.push(
          // 這一行標題**不是分類標題**。continuous-toolbox 靠「文字比對得到分類
          // 名」認分類邊界，所以 `theme.ts` 用這個 class 把它排除掉——否則一段叫
          // 「運算」的標題會被當成運算分類的起點，捲動定位跟著錯。
          { kind: 'label', text: entry.section, 'web-class': 'blockyard-section-label' },
          { kind: 'sep', gap: LABEL_GAP },
        );
      }
      continue;
    }

    if (isButtonEntry(entry)) {
      if (isDone(entry, group, configured)) continue;
      entries.push({
        kind: 'button',
        text: entry.label,
        callbackKey: buttonCallbackKey(group.id, entry.button),
        // Blockly 把 `web-class` 原封不動放到那個 `<g>` 上（`FlyoutButton` 的
        // `this.cssClass`）。這是**唯一**能對按鈕下樣式的掛勾——它畫的三個 SVG
        // 元素都沒有我們認得的 class。
        'web-class': 'blockyard-flyout-button',
      });
      continue;
    }

    const block = registered.get(`${group.id}.${entry.opcode}`);
    if (!block || block.spec.deprecated) continue;
    entries.push(toToolboxBlock(block));
    rendered.add(block.type);
  }

  // **專案資料生成的積木接在後面**（§4.6）：每個自訂函式一顆 `procedure.call#p_x`，
  // 而 palette 裡只有那顆 `dynamic: true` 的原型——原型本身不上架，生出來的要上。
  // 認法是「註冊了、但 palette 沒有列到它」，所以之後再有別種生成積木也不必改這裡。
  for (const block of group.blocks) {
    if (!rendered.has(block.type) && !block.spec.deprecated) entries.push(toToolboxBlock(block));
  }

  return entries;
}

/**
 * 這顆按鈕現在還有沒有事情可做。
 *
 * `open_config` 是**一次性的**：它把使用者送去貼一把金鑰，貼完之後那顆按鈕每
 * 次捲過都在問一個答案永遠是「沒有」的問題。所以它設定完就收起來——工具箱上
 * 剩下的都是還沒做的事。
 *
 * **換金鑰的路沒有跟著消失**：右上角的金鑰面板一直都在，而那才是「管理已經有
 * 的東西」該去的地方。這顆按鈕從頭到尾只解決一件事——第一次那一把要去哪裡填。
 *
 * 別的動作（`open_url`、`call`）沒有「做完了」這個狀態，所以只有這一種會消失。
 */
function isDone(entry: ButtonSpec, group: ToolboxGroup, configured: ReadonlySet<string>): boolean {
  if (entry.action !== 'open_config') return false;
  const secret = configTarget(group);
  return secret !== undefined && configured.has(keyId({ extId: group.id, key: secret.key }));
}

/**
 * 影子積木只能掛在工具箱條目上（Blockly 的 JSON 積木定義沒有宣告影子的地方），
 * 所以 `define.ts` 算好的 `shadows` 在這裡才貼上去。
 */
function toToolboxBlock(block: RegisteredBlock): Record<string, unknown> {
  const entry: Record<string, unknown> = { kind: 'block', type: block.type, gap: BLOCK_GAP };
  if (Object.keys(block.fields).length > 0) entry.fields = block.fields;
  const inputs = Object.entries(block.shadows);
  if (inputs.length > 0) {
    entry.inputs = Object.fromEntries(
      inputs.map(([name, shadow]) => [
        name,
        { shadow: { type: shadow.type, fields: shadow.fields } },
      ]),
    );
  }
  return entry;
}
