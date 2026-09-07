import * as Blockly from 'blockly/core';
import { inlineSvgPaintStyles } from './export';
import { t } from '../i18n';

const PREVIEW_WIDTH = 960;
const PREVIEW_HEIGHT = 540;

/**
 * 把使用者存檔當下看見的 Blockly 工作區縮成 16:9 WebP。
 *
 * clone 而不搬動原 SVG：截圖不能讓正在看的畫布跳一下。Blockly 的樣式有一部分
 * 是 inject 時動態插入的，因此把可讀的 stylesheet 一起塞進 SVG，否則 canvas
 * 只會得到有形狀、沒有字體與顏色的積木。
 */
export async function captureWorkspacePreview(workspace: Blockly.WorkspaceSvg): Promise<Blob | null> {
  const source = workspace.getParentSvg();
  const bounds = source.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;

  const clone = source.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(bounds.width));
  clone.setAttribute('height', String(bounds.height));
  clone.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
  inlineSvgPaintStyles(source, clone);
  // Blockly 的垃圾桶／縮放控制會引用 /media 下的外部圖片。SVG 自己顯示時沒問題，
  // 但它被畫進 canvas 後會讓畫布變成不可匯出的 tainted canvas；卡片封面不需要
  // 這些控制圖示，拿掉後積木與工作區本身仍完整保留。
  clone.querySelectorAll('image').forEach((node) => node.remove());

  const svg = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = PREVIEW_WIDTH;
    canvas.height = PREVIEW_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#f7f7fb';
    ctx.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
    const scale = Math.max(PREVIEW_WIDTH / bounds.width, PREVIEW_HEIGHT / bounds.height);
    const width = bounds.width * scale;
    const height = bounds.height * scale;
    ctx.drawImage(image, (PREVIEW_WIDTH - width) / 2, (PREVIEW_HEIGHT - height) / 2, width, height);
    return await canvasBlob(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(t('error.previewSvg')));
    image.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82));
}
