"use client";

/**
 * 集市畫面。對應 docs/03-economy.md §5。
 *
 * ★ 這個元件不做規則判斷。能不能掛、上限多少，都由伺服器算好傳進來；
 *   按下去之後 Server Action 會**再驗一次**。
 */

import { useState, useTransition } from "react";

import type { ListingView, MarketBoard, MarketResult } from "@/app/actions/market";
import type { Amounts } from "@/lib/game/settle";
import { RESOURCE_NAME } from "@/lib/game/resource-icon";
import { ResourceIcon } from "@/components/ui/ResourceIcon";

/** ★ `<option>` 裡塞不了 SVG，所以下拉選單用**全名**；列表用圖示 */
const RESOURCE_LABEL = RESOURCE_NAME;
const RESOURCE_KEYS = ["grain", "timber", "stone", "iron"] as const satisfies readonly (keyof Amounts)[];

const REJECTION_TEXT: Record<string, string> = {
  NO_ALLIANCE: "沒有聯盟就無法交易 —— 這是刻意的，去加入一個或去搶",
  NOT_SAME_ALLIANCE: "只能跟同一聯盟的人交易",
  NO_MARKET: "掛單需要集市。先在一格領土上蓋一座",
  LISTING_LIMIT: "掛單數已滿（2 × 集市等級）",
  INSUFFICIENT_RESOURCES: "資源不足",
  DAILY_CAP: "今日轉移量已達上限",
  SAME_RESOURCE: "同種資源不能互換",
  NON_POSITIVE: "數量要大於零",
  SELF_TRADE: "不能承接自己的單",
  UNTRADABLE: "這種資源不可交易",
  LISTING_GONE: "這張單已經被接走或撤掉了",
};

export interface MarketViewProps {
  readonly board: MarketBoard;
  readonly onCreate: (
    offerResource: string,
    offerAmount: number,
    wantResource: string,
    wantAmount: number,
  ) => Promise<MarketResult>;
  readonly onAccept: (listingId: number) => Promise<MarketResult>;
  readonly onCancel: (listingId: number) => Promise<MarketResult>;
}

export function MarketView(props: MarketViewProps) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const [offer, setOffer] = useState<keyof Amounts>("stone");
  const [offerAmount, setOfferAmount] = useState("500");
  const [want, setWant] = useState<keyof Amounts>("timber");
  const [wantAmount, setWantAmount] = useState("400");

  const act = (fn: () => Promise<MarketResult>) => {
    startTransition(async () => {
      const r = await fn();
      setMessage(r.ok ? null : (REJECTION_TEXT[r.reason ?? ""] ?? r.reason ?? "無法執行"));
    });
  };

  const remaining = Math.max(0, props.board.dailyCap - props.board.transferredToday);

  if (props.board.allianceId === null) {
    return (
      <main className="mx-auto max-w-md px-6 py-16 text-[#e8dcc0]">
        <h1 className="text-2xl font-bold">集市</h1>
        <p className="mt-3 text-sm leading-relaxed opacity-80">
          交易<b>僅限同一聯盟成員</b>。你還沒有聯盟，所以沒有可以交易的對象。
        </p>
        <p className="mt-3 text-sm leading-relaxed opacity-60">
          資源不能跨類轉換，所以「石頭滿了但木頭見底」遲早會發生。
          到時候你只有兩條路：加入聯盟跟盟友換，或者去搶。
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 bg-[#1a1614] p-4 text-[#e8dcc0]">
      <header>
        <h1 className="text-lg font-bold">集市</h1>
        <p className="text-[11px] opacity-60">
          聯盟內交易 · 無稅 · 掛單需集市，承接不需要
        </p>
      </header>

      <section className="grid grid-cols-2 gap-2 text-xs" data-testid="market-limits">
        <div className="rounded border border-[#4a413a] bg-[#2e2723] p-2">
          <div className="opacity-60">集市等級</div>
          <div className="tabular-nums">
            Lv{props.board.marketLevel} · 可掛 {props.board.listingCap} 單
          </div>
        </div>
        <div className="rounded border border-[#4a413a] bg-[#2e2723] p-2">
          <div className="opacity-60">今日可再轉移</div>
          <div className={`tabular-nums ${remaining === 0 ? "text-[#c4442f]" : ""}`}>
            {remaining.toLocaleString()} / {props.board.dailyCap.toLocaleString()}
          </div>
        </div>
      </section>

      {/* ── 掛單 ── */}
      <section className="rounded border border-[#4a413a] bg-[#2e2723] p-3">
        <h2 className="mb-2 text-sm font-bold">掛單</h2>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <label className="flex flex-col gap-1">
            <span className="opacity-60">我付出</span>
            <div className="flex gap-1">
              <select
                value={offer}
                onChange={(e) => setOffer(e.target.value as keyof Amounts)}
                className="rounded border border-[#4a413a] bg-[#1a1614] px-1 py-1"
              >
                {RESOURCE_KEYS.map((r) => (
                  <option key={r} value={r}>
                    {RESOURCE_LABEL[r]}
                  </option>
                ))}
              </select>
              <input
                value={offerAmount}
                onChange={(e) => setOfferAmount(e.target.value)}
                inputMode="numeric"
                className="w-full rounded border border-[#4a413a] bg-[#1a1614] px-2 py-1 tabular-nums"
              />
            </div>
          </label>
          <label className="flex flex-col gap-1">
            <span className="opacity-60">我要換</span>
            <div className="flex gap-1">
              <select
                value={want}
                onChange={(e) => setWant(e.target.value as keyof Amounts)}
                className="rounded border border-[#4a413a] bg-[#1a1614] px-1 py-1"
              >
                {RESOURCE_KEYS.map((r) => (
                  <option key={r} value={r}>
                    {RESOURCE_LABEL[r]}
                  </option>
                ))}
              </select>
              <input
                value={wantAmount}
                onChange={(e) => setWantAmount(e.target.value)}
                inputMode="numeric"
                className="w-full rounded border border-[#4a413a] bg-[#1a1614] px-2 py-1 tabular-nums"
              />
            </div>
          </label>
        </div>
        <button
          type="button"
          disabled={pending}
          data-testid="create-listing"
          onClick={() =>
            act(() =>
              props.onCreate(offer, Number(offerAmount) || 0, want, Number(wantAmount) || 0),
            )
          }
          className="mt-2 w-full rounded border border-[#a35a3a] px-2 py-1.5 text-xs disabled:opacity-40"
        >
          掛上去
        </button>
        <p className="mt-1 text-[10px] opacity-50">掛單當下就扣款，資源進入託管；撤單可退回。</p>
      </section>

      {/* ── 看板 ── */}
      <section>
        <h2 className="mb-2 text-sm font-bold">聯盟掛單</h2>
        {props.board.listings.length === 0 ? (
          <p className="rounded border border-[#4a413a] bg-[#2e2723] p-3 text-xs opacity-60">
            目前沒有掛單。
          </p>
        ) : (
          <ul className="space-y-2" data-testid="listing-board">
            {props.board.listings.map((l) => (
              <Row
                key={l.id}
                listing={l}
                pending={pending}
                onAccept={() => act(() => props.onAccept(l.id))}
                onCancel={() => act(() => props.onCancel(l.id))}
              />
            ))}
          </ul>
        )}
      </section>

      {message ? (
        <p data-testid="market-message" className="rounded bg-[#6e3a26] px-3 py-2 text-xs">
          {message}
        </p>
      ) : null}
    </main>
  );
}

function Row({
  listing,
  pending,
  onAccept,
  onCancel,
}: {
  listing: ListingView;
  pending: boolean;
  onAccept: () => void;
  onCancel: () => void;
}) {
  return (
    <li className="flex items-center justify-between rounded border border-[#4a413a] bg-[#2e2723] px-3 py-2 text-xs">
      <div>
        <div className="tabular-nums">
          <ResourceIcon kind={listing.offer.resource} /> {listing.offer.amount.toLocaleString()}
          <span className="mx-2 opacity-50">→</span>
          <ResourceIcon kind={listing.want.resource} /> {listing.want.amount.toLocaleString()}
        </div>
        <div className="text-[10px] tabular-nums opacity-60">
          匯率 {listing.rate.toFixed(2)}
          {listing.mine ? " · 你的單" : ""}
        </div>
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={listing.mine ? onCancel : onAccept}
        className="rounded border border-[#4a413a] px-3 py-1 disabled:opacity-40"
      >
        {listing.mine ? "撤單" : "承接"}
      </button>
    </li>
  );
}
