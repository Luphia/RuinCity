/**
 * 影像的後處理：所有畫師的輸出都在這裡正規化。**伺服器專用**（sharp）。
 *
 * - 三家回來的格式、尺寸各不相同（PNG / JPEG / 由 SVG 轉出來的 PNG），
 *   存進資料庫前一律轉成 WebP，並產生一張縮圖給世界地圖用。
 * - Claude 畫的 SVG 在這裡**淨化並點陣化**：資料庫裡從來不存 SVG，
 *   網站也從來不送 SVG 給瀏覽器 —— SVG 是可以夾帶腳本的文件，不是單純的圖。
 */

import "server-only";

import sharp from "sharp";

import type { Aspect } from "@/lib/world/prompts";

import type { ImageBytes } from "./painter";

/** 各比例的輸出像素（寬 × 高）。長邊 1024–1536，與三家模型的預設輸出相當 */
export function aspectSize(aspect: Aspect): { width: number; height: number } {
  switch (aspect) {
    case "16:9":
      return { width: 1536, height: 864 };
    case "1:1":
      return { width: 1024, height: 1024 };
    case "4:5":
      return { width: 1024, height: 1280 };
    case "5:4":
      return { width: 1280, height: 1024 };
    case "3:4":
      return { width: 1024, height: 1365 };
    case "4:3":
      return { width: 1365, height: 1024 };
  }
}

export const THUMB_WIDTH = 384;

export interface StoredImage {
  readonly webp: Uint8Array;
  readonly thumb: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * 正規化成 WebP + 縮圖。
 *
 * ★ 地圖塊要**剛好**是那一塊的比例，否則貼回地圖上會被拉歪 ——
 *   模型不一定照比例畫（有的只會出 1024² 或 1536×1024），所以這裡強制裁成目標比例
 *   （`cover` 取中央）。街景同理統一成 16:9。
 */
export async function normalizeImage(img: ImageBytes, aspect: Aspect): Promise<StoredImage> {
  const { width, height } = aspectSize(aspect);
  const base = sharp(Buffer.from(img.data), { limitInputPixels: 64_000_000 }).rotate();
  const webp = await base.clone().resize(width, height, { fit: "cover" }).webp({ quality: 84 }).toBuffer();
  const thumb = await base
    .clone()
    .resize(THUMB_WIDTH, Math.round((THUMB_WIDTH * height) / width), { fit: "cover" })
    .webp({ quality: 72 })
    .toBuffer();
  return { webp: new Uint8Array(webp), thumb: new Uint8Array(thumb), width, height };
}

export async function imageDimensions(img: ImageBytes): Promise<{ width: number; height: number }> {
  const m = await sharp(Buffer.from(img.data)).metadata();
  return { width: m.width ?? 0, height: m.height ?? 0 };
}

/**
 * 從模型的回答裡取出 SVG 並淨化。
 *
 * 白名單太難維護（SVG 的元素與屬性幾百個），所以用黑名單擋掉**會往外伸手**的東西：
 * 腳本、事件屬性、外部參照、foreignObject（可以嵌 HTML）、DOCTYPE/ENTITY（XXE）。
 * 點陣化交給 librsvg —— 它本來就不執行腳本，這裡是第二道。
 */
export function extractSvg(text: string): string | null {
  const start = text.search(/<svg[\s>]/i);
  const end = text.lastIndexOf("</svg>");
  if (start < 0 || end < start) return null;
  let svg = text.slice(start, end + "</svg>".length);
  svg = svg
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!ENTITY[\s\S]*?>/gi, "")
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script[^>]*\/>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    // 只允許指向同一份文件內部（#id）或內嵌 data: 的參照
    .replace(/\s(?:xlink:)?href\s*=\s*("(?!#|data:image\/)[^"]*"|'(?!#|data:image\/)[^']*')/gi, "")
    .replace(/url\(\s*(['"]?)(?!#)[^)]*\1\s*\)/gi, "none");
  if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) {
    svg = svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return svg;
}

export async function rasterizeSvg(svg: string, aspect: Aspect): Promise<ImageBytes> {
  const { width, height } = aspectSize(aspect);
  const png = await sharp(Buffer.from(svg), { density: 144, limitInputPixels: 64_000_000 })
    .resize(width, height, { fit: "cover" })
    .png()
    .toBuffer();
  return { mime: "image/png", data: new Uint8Array(png) };
}
