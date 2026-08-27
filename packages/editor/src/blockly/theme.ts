/**
 * 工作區外觀。
 *
 * 顏色**不放在這裡**：每顆積木的顏色來自它那份 manifest 的 `color`（§8.1），
 * 積木包自己決定要長什麼樣子。這份主題只管積木以外的東西——工作區背景、
 * 工具箱、flyout。
 */
import * as Blockly from 'blockly/core';

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

export const workspaceOptions: Partial<Blockly.BlocklyOptions> = {
  renderer: 'zelos',
  theme: blockyTheme,
  media: 'media/',
  grid: { spacing: 40, length: 3, colour: '#e2e4ee', snap: false },
  zoom: { controls: true, wheel: true, startScale: 0.75, minScale: 0.3, maxScale: 2 },
  move: { scrollbars: true, drag: true, wheel: true },
  trashcan: true,
  sounds: false,
};
