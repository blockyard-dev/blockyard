/**
 * 工作區外觀。
 *
 * 顏色**不放在這裡**：每顆積木的顏色來自它那份 manifest 的 `color`（§8.1），
 * 積木包自己決定要長什麼樣子。這份主題只管積木以外的東西——工作區背景、
 * 工具箱、flyout。
 */
import * as Blockly from 'blockly/core';
import { registerContinuousToolbox } from '@blockly/continuous-toolbox';

export const blockyTheme = Blockly.Theme.defineTheme('blocky', {
  name: 'blocky',
  base: Blockly.Themes.Zelos,
  componentStyles: {
    workspaceBackgroundColour: '#f7f7fb',
    toolboxBackgroundColour: '#ffffff',
    toolboxForegroundColour: '#33333d',
    flyoutBackgroundColour: '#eceef5',
    flyoutForegroundColour: '#33333d',
    flyoutOpacity: 1,
    scrollbarColour: '#c8ccdc',
    insertionMarkerColour: '#33333d',
    insertionMarkerOpacity: 0.3,
    cursorColour: '#33333d',
  },
  // 帽子由積木自己的 `style.hat` 決定（見 define.ts 的 applyShape）。全域打開
  // 的話，`return`、`stop` 這種沒有上接點的 cap 積木也會長出帽子。
  startHats: false,
});

/**
 * §8.1 的工具箱版面：**一條連續的捲動軸**。
 *
 * 所有分類接在同一個 flyout 裡，點分類是**捲到那一段**而不是換一份清單。這讓
 * 「我不知道那顆積木在哪一類」從一個要先答對才問得出口的問題，變成滑一遍就
 * 解決的問題——那正是新使用者最常有的處境。
 *
 * 它順帶解掉「固定寬度」那一條：flyout 只有一份，寬度就是所有積木裡最寬的
 * 那一顆，切換分類時不會再變——而畫布正是使用者在對齊積木的地方，它不該
 * 因為左邊換了一份清單就整個左右跳動。
 *
 * 註冊是覆寫式的（plugin 用 `allowOverrides`），重複呼叫安全。
 */
registerContinuousToolbox();

export const workspaceOptions: Partial<Blockly.BlocklyOptions> = {
  renderer: 'zelos',
  theme: blockyTheme,
  plugins: {
    toolbox: 'ContinuousToolbox',
    flyoutsVerticalToolbox: 'ContinuousFlyout',
    metricsManager: 'ContinuousMetrics',
  },
  media: 'media/',
  grid: { spacing: 40, length: 3, colour: '#e2e4ee', snap: false },
  zoom: { controls: true, wheel: true, startScale: 0.75, minScale: 0.3, maxScale: 2 },
  move: { scrollbars: true, drag: true, wheel: true },
  trashcan: true,
  sounds: false,
};
