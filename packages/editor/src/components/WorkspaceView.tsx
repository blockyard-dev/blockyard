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
  const hostRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const workspace = Blockly.inject(host, {
      ...workspaceOptions,
      toolbox: toolbox as unknown as Blockly.utils.toolbox.ToolboxDefinition,
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
    // toolbox 換掉要重建工作區——這一步還沒有專案要保存，第 4 步接上存讀檔
    // 之後才需要改成 updateToolbox。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolbox]);

  return <div ref={hostRef} className="workspace" />;
}
