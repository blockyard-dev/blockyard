import * as Blockly from 'blockly/core';
import { t } from '../i18n';

export type BlockExportFormat = 'svg' | 'png';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PADDING = 24;
const MAX_PNG_EDGE = 4096;

// SVG 離開原頁面後讀不到原本 cascade 的樣式。只帶繪圖用的 computed
// properties；顏色會在這裡解析成實值，不把 CSS 變數留到下載後才猜。
const PAINT_PROPERTIES = [
  'color',
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-opacity',
  'opacity',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'letter-spacing',
  'visibility',
] as const;

/** 將原頁面算好的 SVG 外觀寫進副本，供預覽與下載共用。 */
export function inlineSvgPaintStyles(source: SVGElement, clone: SVGElement): void {
  const sourceNodes = [source, ...source.querySelectorAll<SVGElement>('*')];
  const cloneNodes = [clone, ...clone.querySelectorAll<SVGElement>('*')];
  for (let index = 0; index < sourceNodes.length; index += 1) {
    const sourceNode = sourceNodes[index];
    const target = cloneNodes[index];
    if (!sourceNode || !target) continue;
    const computed = getComputedStyle(sourceNode);
    for (const property of PAINT_PROPERTIES) {
      const value = computed.getPropertyValue(property);
      if (value) target.style.setProperty(property, value);
    }
  }
}

/** 下載整面畫布上的積木；不含背景、網格、工具箱、捲軸與控制按鈕。 */
export async function downloadWorkspaceBlocks(
  workspace: Blockly.WorkspaceSvg,
  format: BlockExportFormat,
  projectName = 'blocks',
): Promise<void> {
  const drawing = await blockSvg(workspace);
  const blob = format === 'svg' ? drawing.blob : await svgToPng(drawing);
  download(blob, `${safeFilename(projectName)}.${format}`);
}

interface SvgDrawing {
  blob: Blob;
  width: number;
  height: number;
}

async function blockSvg(workspace: Blockly.WorkspaceSvg): Promise<SvgDrawing> {
  if (workspace.getAllBlocks(false).length === 0) throw new Error(t('blockly.exportEmpty'));

  const bounds = workspace.getBlocksBoundingBox();
  const width = Math.max(1, Math.ceil(bounds.getWidth() + PADDING * 2));
  const height = Math.max(1, Math.ceil(bounds.getHeight() + PADDING * 2));
  const root = document.createElementNS(SVG_NS, 'svg');
  root.setAttribute('xmlns', SVG_NS);
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  root.setAttribute('viewBox', `0 0 ${width} ${height}`);

  // Blockly 的 renderer 會在 defs 放濾鏡、漸層與 clipPath。它們不是背景，積木
  // 本身會引用，所以連同定義一起帶走。
  const defs = workspace.getParentSvg().querySelector('defs');
  if (defs) root.appendChild(defs.cloneNode(true));

  const sourceCanvas = workspace.getCanvas();
  const canvas = sourceCanvas.cloneNode(true) as SVGGElement;
  inlineSvgPaintStyles(sourceCanvas, canvas);
  // getBlocksBoundingBox() 與積木 canvas 都是 workspace coordinates。覆寫目前的
  // 捲動／縮放 transform，讓輸出永遠依全部積木裁切，而不是只截使用者眼前一角。
  canvas.setAttribute('transform', `translate(${PADDING - bounds.left} ${PADDING - bounds.top})`);
  root.appendChild(canvas);

  await inlineImages(root);
  const xml = new XMLSerializer().serializeToString(root);
  return {
    blob: new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }),
    width,
    height,
  };
}

async function inlineImages(root: SVGSVGElement): Promise<void> {
  await Promise.all(
    [...root.querySelectorAll<SVGImageElement>('image')].map(async (image) => {
      const href = image.getAttribute('href') ?? image.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (!href || href.startsWith('data:')) return;
      try {
        const response = await fetch(new URL(href, window.location.href));
        if (!response.ok) throw new Error(String(response.status));
        image.setAttribute('href', await dataUrl(await response.blob()));
        image.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
      } catch {
        // 一個載不進來的圖片欄位不能讓整面積木都匯不出去；移除那張圖，積木的
        // 形狀、文字與其他欄位仍完整保留。
        image.remove();
      }
    }),
  );
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(t('error.exportEmbed')));
    reader.readAsDataURL(blob);
  });
}

async function svgToPng(drawing: SvgDrawing): Promise<Blob> {
  const url = URL.createObjectURL(drawing.blob);
  try {
    const image = await loadImage(url);
    const scale = Math.min(2, MAX_PNG_EDGE / drawing.width, MAX_PNG_EDGE / drawing.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(drawing.width * scale));
    canvas.height = Math.max(1, Math.round(drawing.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error(t('error.exportCanvas'));
    // 刻意不 fill：PNG 背景保持透明。
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error(t('error.exportPng'));
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(t('error.exportSvgPng')));
    image.src = url;
  });
}

function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim() || 'blocks';
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const SVG_MENU_ID = 'blockyard_workspace_export_svg';
const PNG_MENU_ID = 'blockyard_workspace_export_png';

export function registerWorkspaceExportMenus(
  callback: (format: BlockExportFormat) => void,
): () => void {
  const registry = Blockly.ContextMenuRegistry.registry;
  for (const id of [SVG_MENU_ID, PNG_MENU_ID]) {
    if (registry.getItem(id)) registry.unregister(id);
  }
  const precondition = (scope: Blockly.ContextMenuRegistry.Scope) =>
    scope.workspace && scope.workspace.getAllBlocks(false).length > 0 ? 'enabled' : 'disabled';
  registry.register({
    id: SVG_MENU_ID,
    scopeType: Blockly.ContextMenuRegistry.ScopeType.WORKSPACE,
    weight: 6,
    preconditionFn: precondition,
    displayText: t('blockly.exportSvg'),
    callback: () => callback('svg'),
  });
  registry.register({
    id: PNG_MENU_ID,
    scopeType: Blockly.ContextMenuRegistry.ScopeType.WORKSPACE,
    weight: 6.1,
    preconditionFn: precondition,
    displayText: t('blockly.exportPng'),
    callback: () => callback('png'),
  });
  return () => {
    registry.unregister(SVG_MENU_ID);
    registry.unregister(PNG_MENU_ID);
  };
}
