/**
 * 示範用的假畫師與假參考來源。**不連任何外部服務、不花任何錢。**
 *
 * `FAKE_PROVIDERS=1` 時三家都換成這裡的實作：本機開發、E2E、
 * 以及「還沒有任何一把金鑰也想看看整個流程」的時候用。
 *
 * ★ 它刻意回報**表上的典型用量**作為 usage —— 帳、估計、投票、換模型
 *   全部照真的跑，唯一假的只有圖本身。這樣示範模式才驗得到捐款人看到的數字。
 *
 * ★ 兩家畫師的假圖長得不一樣（色調），施工途中換模型時看得出來。
 *   假圖**不是**擬真的 —— 它只是讓流程跑得動，畫面上的「示範模式」標記就是在說這件事。
 */

import "server-only";

import { blockOf, blockBounds, sameBlock, type LatLng } from "@/lib/world/grid";
import type { MapParams } from "@/lib/world/params";
import { MODEL_PROFILES, type PaidStepKind, type ProviderId } from "@/lib/world/pricing";

import type { ReferenceSource } from "./google-maps";
import { aspectSize, rasterizeSvg } from "./image";
import { PainterError, type Painter } from "./painter";

function fakeParams(provider: ProviderId, markers: number): MapParams {
  return {
    biome: "humid subtropical forest over a ruined city",
    waterLevel: "marshy",
    vegetationDensity: 0.8,
    ruinState: "Most buildings are green mounds; a few hollow towers remain.",
    palette: ["deep green", "rust", "grey"],
    landmarks: [],
    materials: [
      "moss-covered cracked concrete",
      "asphalt split by roots",
      "forest floor with ferns",
      "rusted steel",
      "brick rubble with vines",
      "muddy water with reeds",
      "banyan roots over stone",
      "weathered tile fragments",
    ],
    markers: Array.from({ length: markers }, (_, i) => ({ index: i, caption: `Demo viewpoint ${i}` })),
    fieldNote: `示範模式的勘查筆記（${MODEL_PROFILES[provider].displayName}）。`,
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTE: Record<ProviderId, { sky: string; ground: string; accent: string; label: string }> = {
  google: { sky: "#9fb7a4", ground: "#3e5a33", accent: "#7f9a5a", label: "Gemini" },
  openai: { sky: "#a7b4c6", ground: "#34474f", accent: "#6f8d8a", label: "GPT Image" },
  anthropic: { sky: "#e3cfb0", ground: "#6e4b33", accent: "#c8794a", label: "Claude" },
};

function fakeSvg(provider: ProviderId, kind: PaidStepKind, seedText: string, w: number, h: number): string {
  const r = rng(hash(`${provider}:${kind}:${seedText}`));
  const c = PALETTE[provider];
  const shapes: string[] = [];
  if (kind === "SCENE") {
    shapes.push(`<rect width="${w}" height="${h * 0.55}" fill="${c.sky}"/>`);
    shapes.push(`<rect y="${h * 0.55}" width="${w}" height="${h * 0.45}" fill="${c.ground}"/>`);
    for (let i = 0; i < 9; i++) {
      const bw = 60 + r() * 140;
      const bh = 80 + r() * 260;
      const x = r() * w;
      shapes.push(
        `<rect x="${x.toFixed(0)}" y="${(h * 0.55 - bh).toFixed(0)}" width="${bw.toFixed(0)}" height="${bh.toFixed(0)}" fill="${c.accent}" opacity="0.55"/>`,
      );
    }
    for (let i = 0; i < 40; i++) {
      shapes.push(
        `<circle cx="${(r() * w).toFixed(0)}" cy="${(h * 0.5 + r() * h * 0.5).toFixed(0)}" r="${(10 + r() * 50).toFixed(0)}" fill="${c.ground}" opacity="0.7"/>`,
      );
    }
  } else if (kind === "DSM") {
    shapes.push(`<rect width="${w}" height="${h}" fill="#333"/>`);
    for (let i = 0; i < 50; i++) {
      const g = Math.floor(60 + r() * 190);
      shapes.push(
        `<circle cx="${(r() * w).toFixed(0)}" cy="${(r() * h).toFixed(0)}" r="${(20 + r() * 110).toFixed(0)}" fill="rgb(${g},${g},${g})" opacity="0.6"/>`,
      );
    }
  } else if (kind === "TEXTURE") {
    shapes.push(`<rect width="${w}" height="${h}" fill="${c.accent}"/>`);
    for (let i = 0; i < 120; i++) {
      shapes.push(
        `<circle cx="${(r() * w).toFixed(0)}" cy="${(r() * h).toFixed(0)}" r="${(4 + r() * 30).toFixed(0)}" fill="${r() > 0.5 ? c.ground : c.sky}" opacity="0.5"/>`,
      );
    }
  } else {
    shapes.push(`<rect width="${w}" height="${h}" fill="${c.ground}"/>`);
    for (let i = 0; i < 60; i++) {
      shapes.push(
        `<circle cx="${(r() * w).toFixed(0)}" cy="${(r() * h).toFixed(0)}" r="${(20 + r() * 90).toFixed(0)}" fill="${c.accent}" opacity="0.35"/>`,
      );
    }
    const y = h * (0.3 + r() * 0.4);
    shapes.push(
      `<path d="M0 ${y.toFixed(0)} C ${w * 0.3} ${(y - 120).toFixed(0)}, ${w * 0.6} ${(y + 140).toFixed(0)}, ${w} ${(y + 20).toFixed(0)}" stroke="#4f7a8c" stroke-width="46" fill="none" opacity="0.8"/>`,
    );
  }
  shapes.push(
    `<rect x="12" y="12" width="230" height="44" rx="6" fill="#1a1614" opacity="0.7"/>` +
      `<text x="26" y="42" font-family="sans-serif" font-size="22" fill="#e8dcc0">DEMO · ${c.label}</text>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${shapes.join("")}</svg>`;
}

export function fakePainter(provider: ProviderId): Painter {
  const profile = MODEL_PROFILES[provider];
  return {
    provider,
    model: profile.model,
    async paint(req) {
      const usage = profile.typical[req.kind];
      if (!usage) throw new PainterError("BAD_REQUEST", `${profile.displayName} 不做 ${req.kind}`);
      const seed = req.parts.map((p) => (p.kind === "text" ? p.text : `img:${p.image.data.byteLength}`)).join("|");
      if (req.output === "text") {
        const markers = (seed.match(/^\d+: lat /gm) ?? []).length;
        return { output: "text", text: JSON.stringify(fakeParams(provider, markers)), usage, model: profile.model };
      }
      const { width, height } = aspectSize(req.aspect);
      const image = await rasterizeSvg(fakeSvg(provider, req.kind, seed, width, height), req.aspect);
      return { output: "image", image, usage, model: profile.model, note: `示範模式（${profile.displayName}）` };
    },
  };
}

/** 假的街景來源：大約三分之二的探針「找得到」全景，位置固定落在塊內 */
export function fakeReferenceSource(): ReferenceSource {
  const solid = async (color: string, w: number, h: number) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${color}"/></svg>`;
    return rasterizeSvg(svg, "16:9");
  };
  return {
    async nearestPano(near: LatLng) {
      const h = hash(`${near.lat.toFixed(6)},${near.lng.toFixed(6)}`);
      if (h % 3 === 0) return null;
      const block = blockOf(near);
      const b = blockBounds(block);
      // 往塊中心挪一點點，保證在塊內
      const location = {
        lat: near.lat + (b.south + (b.north - b.south) / 2 - near.lat) * 0.1,
        lng: near.lng + (b.west + (b.east - b.west) / 2 - near.lng) * 0.1,
      };
      if (!sameBlock(blockOf(location), block)) return null;
      return { panoId: `fake-${h.toString(36)}`, location, date: "2025-01" };
    },
    streetView: () => solid("#8a8f94", 640, 360),
    layout: () => solid("#d9d9d9", 466, 514),
  };
}
