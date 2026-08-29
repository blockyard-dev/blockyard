/**
 * Blockly 工作區。
 *
 * §8.2：workspace 本身是 uncontrolled，**不放進 React state**。React 只負責
 * 把 div 掛上去、把 toolbox 換掉；積木的增刪改由 Blockly 自己管，只有在存檔
 * 或執行時才把它導出來。反過來做（每個 Blockly event 都 setState）會讓拖曳
 * 一路重繪。
 */
import { useEffect, useRef } from 'react';
import * as Blockly from 'blockly/core';
import { workspaceOptions } from '../blockly/theme';

interface Props {
  toolbox: Record<string, unknown>;
  onReady?: (workspace: Blockly.WorkspaceSvg) => void;
}

export function WorkspaceView({ toolbox, onReady }: Props) {
  const toolboxRef = useRef(toolbox);
  const hostRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  // 第一次的 toolbox 是 inject 時就帶進去的，不必再更新一次。
  const firstToolbox = useRef(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const workspace = Blockly.inject(host, {
      ...workspaceOptions,
      toolbox: toolboxRef.current as unknown as Blockly.utils.toolbox.ToolboxDefinition,
    });
    workspaceRef.current = workspace;
    onReady?.(workspace);

    // 容器尺寸變了 Blockly 不會自己知道（它畫在固定尺寸的 SVG 上）。
    const observer = new ResizeObserver(() => Blockly.svgResize(workspace));
    observer.observe(host);

    return () => {
      observer.disconnect();
      workspace.dispose();
      workspaceRef.current = null;
    };
    // **只建一次。** toolbox 是會變的（建立一個函式就多一顆呼叫積木，§8.5），
    // 而重建工作區等於把使用者畫布上的東西全部丟掉再讀一次。換 toolbox 走
    // 下面那條 `updateToolbox`。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 工具箱換掉（新增或改了一個函式）。
   *
   * `updateToolbox` 只換分類的內容，不動工作區。continuous-toolbox 的 flyout
   * 是**一條連續的捲動軸**（見 theme.ts），內容在 `init` 時就展開好了，所以
   * 換完要叫它重讀一次——沒有這一句，新的呼叫積木要等使用者點一下別的分類
   * 才會出現。
   */
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || firstToolbox.current) {
      firstToolbox.current = false;
      return;
    }
    workspace.updateToolbox(toolbox as unknown as Blockly.utils.toolbox.ToolboxDefinition);
    (workspace.getToolbox() as { refreshSelection?: () => void } | null)?.refreshSelection?.();
  }, [toolbox]);

  return <div ref={hostRef} className="workspace" />;
}
