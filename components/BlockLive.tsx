"use client";

/**
 * 施工中的區塊頁：**只有數字，沒有圖。**
 *
 * 四個主要數字（預計所需 Token、換算金額、已花費 Token、已花費金額）放最上面，
 * 下面是募款進度、投票、捐款、預算書與施工紀錄。
 * 施工中每 4 秒更新一次 —— 捐款人看得到 token 一格一格往上跳，
 * 也看得到投票翻盤之後，下一步換成了哪一家。
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type { BlockPageData } from "@/lib/server/block-page";
import type { PainterId } from "@/lib/world/pricing";

import { BudgetSheet } from "./BudgetSheet";

const PRESETS = [100, 300, 1000, 3000];

export function BlockLive({ initial, signedIn, canDonate }: { initial: BlockPageData; signedIn: boolean; canDonate: boolean }) {
  const [data, setData] = useState(initial);
  const [pollError, setPollError] = useState<string | null>(null);
  const router = useRouter();
  const v = data.view;

  useEffect(() => {
    if (v.status === "COMPLETE") {
      router.refresh();
      return;
    }
    const every = v.status === "BUILDING" ? 4000 : 15000;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/blocks/${v.key}`);
        const json = (await res.json()) as BlockPageData & { error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setData(json);
        setPollError(null);
      } catch (e) {
        // ★ 失敗要看得見：數字停住卻沒有任何提示，捐款人會以為施工停了
        setPollError(e instanceof Error ? e.message : "更新失敗");
      }
    }, every);
    return () => clearInterval(id);
  }, [v.key, v.status, router]);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-6">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold">{v.shortLabel}</h1>
          <StatusBadge status={v.status} label={v.statusLabel} />
          {v.isOrigin ? <span className="text-moss text-xs">原點 · 臺北 101</span> : null}
        </div>
        <p className="text-ash text-sm">
          {v.label} · 距臺北 101 {v.distanceKm} km · 0.01° × 0.01°
        </p>
        <p className="border-ink-mid text-ash mt-2 rounded border border-dashed p-3 text-sm leading-relaxed">
          這一塊<b className="text-parchment">完成之前無法進入</b>。施工中只公開經費與進度；
          完工後，所有場景圖、地圖底圖、3D 圖資與材質貼圖才會一次開放。
        </p>
        {v.pauseReason ? (
          <p data-testid="pause-reason" className="border-alarm text-alarm rounded border p-3 text-sm">
            施工暫停：{v.pauseReason}
          </p>
        ) : null}
        {pollError ? <p className="text-alarm text-xs">即時更新中斷：{pollError}</p> : null}
      </header>

      <section data-testid="meters" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Meter label="預計所需 Token" value={v.meters.tokensNeeded} testid="meter-tokens-needed" />
        <Meter label="換算金額" value={v.meters.moneyNeeded.twd} sub={v.meters.moneyNeeded.usd} testid="meter-money-needed" />
        <Meter label="已花費 Token" value={v.meters.tokensSpent} testid="meter-tokens-spent" />
        <Meter label="已花費金額" value={v.meters.moneySpent.twd} sub={v.meters.moneySpent.usd} testid="meter-money-spent" />
      </section>
      <p className="text-ash-deep -mt-5 text-xs leading-relaxed">
        「換算金額」是完成這一塊所需的募款總額，含 token、參考影像、預備金、四年保存、手續費與稅（見下方預算書）。
        「已花費金額」含已扣的手續費與稅。估計隨投票結果與實際用量即時更新。
      </p>

      <section className="flex flex-col gap-3">
        <Bar label="募款" value={v.funding.progress} detail={`已募得 ${v.funding.received.twd} / ${v.meters.moneyNeeded.twd}`} tone="rust" />
        <Bar label="Token" value={v.meters.tokenProgress} detail={`${v.meters.tokensSpent} / ${v.meters.tokensNeeded}`} tone="moss" />
        <p className="text-ash text-sm">
          施工進度 {v.progress.done} / {v.progress.total} 步
          {v.progress.next ? ` · 下一步：${v.progress.next}` : ""}
          {v.funding.gap.micros > 0 ? ` · 尚缺 ${v.funding.gap.twd}` : " · 經費已足"}
          {` · ${v.funding.donations} 筆捐款、${v.funding.donors} 位捐款人`}
        </p>
      </section>

      <VotePanel data={data} signedIn={signedIn} onChanged={(d) => setData(d)} />

      <DonateForm data={data} signedIn={signedIn} canDonate={canDonate} />

      <BudgetSheet budget={v.budget} total={v.meters.moneyNeeded.twd} />

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">施工紀錄</h2>
        {v.log.length === 0 ? (
          <p className="text-ash text-sm">還沒有開工。第一筆捐款入帳後會先勘查（免費），再依票數決定由誰來畫。</p>
        ) : (
          <ol data-testid="build-log" className="border-ink-mid divide-ink-mid max-h-80 divide-y overflow-y-auto rounded border text-sm">
            {v.log.map((l, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-3 px-3 py-1.5">
                <span className={l.status === "FAILED" ? "text-alarm" : ""}>{l.label}</span>
                <span className="text-ash">{l.provider ?? "—"}</span>
                <span className="text-ash-deep text-xs">{l.model ?? ""}</span>
                <span className="flex-1" />
                <span className="text-ash tabular-nums">{l.tokens} tok</span>
                <span className="tabular-nums">{l.cost}</span>
                {l.error ? <span className="text-alarm text-xs">{l.error}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <p className="text-ash-deep text-xs">
        <Link href="/" className="underline">
          ← 回到世界地圖
        </Link>
      </p>
    </main>
  );
}

export function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone =
    status === "COMPLETE"
      ? "bg-moss text-ink"
      : status === "BUILDING"
        ? "bg-rust text-ink"
        : status === "PAUSED"
          ? "bg-alarm text-ink"
          : "border-ink-mid text-ash border";
  return (
    <span data-testid="status" className={`rounded px-2 py-0.5 text-xs font-bold ${tone}`}>
      {label}
    </span>
  );
}

function Meter({ label, value, sub, testid }: { label: string; value: string; sub?: string; testid: string }) {
  return (
    <div className="border-ink-mid bg-ink-soft flex flex-col gap-1 rounded border p-3">
      <span className="text-ash text-xs">{label}</span>
      <span data-testid={testid} className="text-xl font-bold tabular-nums">
        {value}
      </span>
      {sub ? <span className="text-ash-deep text-xs tabular-nums">{sub}</span> : null}
    </div>
  );
}

function Bar({ label, value, detail, tone }: { label: string; value: number; detail: string; tone: "rust" | "moss" }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs">
        <span className="text-ash">{label}</span>
        <span className="text-ash tabular-nums">{detail}</span>
      </div>
      <div className="bg-ink-mid h-2 overflow-hidden rounded">
        <div className={`${tone === "rust" ? "bg-rust" : "bg-moss"} h-full`} style={{ width: `${Math.round(value * 1000) / 10}%` }} />
      </div>
    </div>
  );
}

function VotePanel({ data, signedIn, onChanged }: { data: BlockPageData; signedIn: boolean; onChanged: (d: BlockPageData) => void }) {
  const v = data.view;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const myPaid = data.mine.filter((d) => d.status === "PAID" || d.status === "PENDING");
  const myVote = myPaid.length > 0 && myPaid.every((d) => d.vote === myPaid[0]!.vote) ? myPaid[0]!.vote : null;

  const change = async (vote: PainterId | null) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/blocks/${v.key}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vote }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const fresh = await fetch(`/api/blocks/${v.key}`);
      if (fresh.ok) onChanged((await fresh.json()) as BlockPageData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "改票失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="vote-panel" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">由誰來畫</h2>
        <span className="text-ash text-xs">
          依捐款金額加權；每一張圖開工時才計票，所以施工途中可能換模型
        </span>
      </div>
      <p className="text-ash-deep text-xs leading-relaxed" data-testid="vote-note">
        畫面必須擬真，只有畫得出照片的影像模型可以投。地圖參數由
        {v.vote.surveyor ? ` ${v.vote.surveyor} ` : "預設值"}
        {v.vote.surveyor ? "撰寫（不出圖、不參與投票）。" : "提供（目前沒有可用的勘查員）。"}
      </p>
      <ul className="flex flex-col gap-2">
        {v.vote.options.map((o) => (
          <li key={o.provider} className="border-ink-mid rounded border p-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <b>{o.company}</b>
              <span className="text-ash text-sm">{o.model}</span>
              {!o.enabled ? <span className="text-alarm text-xs">停用中</span> : null}
              {v.vote.current === o.provider ? (
                <span className="bg-moss text-ink rounded px-1.5 text-xs font-bold">
                  {v.vote.decidedBy === "VOTES" ? "目前領先" : "平台預設"}
                </span>
              ) : null}
              <span className="flex-1" />
              <span className="text-sm tabular-nums">{o.weight.twd}</span>
            </div>
            <div className="bg-ink-mid mt-2 h-1.5 overflow-hidden rounded">
              <div className="bg-rust h-full" style={{ width: `${Math.round(o.share * 1000) / 10}%` }} />
            </div>
            {o.estimate ? (
              <p className="text-ash-deep mt-1 text-xs">若之後全部由它來畫，完成這一塊約需募得 {o.estimate.twd}</p>
            ) : null}
            {signedIn && myPaid.length > 0 && o.enabled ? (
              <button
                type="button"
                disabled={busy || myVote === o.provider}
                onClick={() => void change(o.provider)}
                className="text-rust mt-1 text-xs underline disabled:no-underline disabled:opacity-50"
              >
                {myVote === o.provider ? "我的票都投給它" : "把我在這一塊的票都改投它"}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-ash text-xs">未投票的捐款：{v.vote.abstained.twd}（照樣用於施工，只是不參與決定）</p>
      {signedIn && myPaid.length > 0 ? (
        <button type="button" disabled={busy || myVote === null} onClick={() => void change(null)} className="text-ash self-start text-xs underline disabled:opacity-50">
          撤回我在這一塊的所有票
        </button>
      ) : null}
      {error ? <p className="text-alarm text-sm">{error}</p> : null}
    </section>
  );
}

function DonateForm({ data, signedIn, canDonate }: { data: BlockPageData; signedIn: boolean; canDonate: boolean }) {
  const v = data.view;
  const [amount, setAmount] = useState(300);
  const [vote, setVote] = useState<PainterId | "">("");
  const [wish, setWish] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!signedIn) {
    return (
      <section className="border-rust rounded border p-4 text-sm">
        <Link href={`/signin?callbackUrl=/b/${v.key}`} className="text-rust font-bold underline">
          登入
        </Link>
        之後就能捐款並投票決定由哪一家模型來畫。
      </section>
    );
  }
  if (!canDonate) {
    return (
      <section className="border-ink-mid text-ash rounded border border-dashed p-4 text-sm">
        金流尚未設定，目前無法收款。
      </section>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/blocks/${v.key}/donate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountTwd: amount, vote: vote || null, wish: wish.trim() || null }),
      });
      const json = (await res.json()) as { redirectUrl?: string; error?: string };
      if (!res.ok || !json.redirectUrl) throw new Error(json.error ?? `HTTP ${res.status}`);
      window.location.href = json.redirectUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "捐款失敗");
      setBusy(false);
    }
  };

  return (
    <section data-testid="donate-form" className="border-rust flex flex-col gap-3 rounded border p-4">
      <h2 className="text-lg font-bold">捐款</h2>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setAmount(p)}
            className={`rounded border px-3 py-1.5 text-sm ${amount === p ? "border-rust text-rust" : "border-ink-mid"}`}
          >
            NT${p.toLocaleString("en-US")}
          </button>
        ))}
        <label className="border-ink-mid flex items-center gap-1 rounded border px-2 text-sm">
          NT$
          <input
            data-testid="donate-amount"
            type="number"
            min={30}
            step={1}
            value={amount}
            onChange={(e) => setAmount(Math.round(Number(e.target.value)))}
            className="w-24 bg-transparent py-1.5 outline-none"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ash">投給哪一家（可以不投）</span>
        <select
          data-testid="donate-vote"
          value={vote}
          onChange={(e) => setVote(e.target.value as PainterId | "")}
          className="border-ink-mid bg-ink-soft rounded border px-2 py-2"
        >
          <option value="">不投票</option>
          {v.vote.options
            .filter((o) => o.enabled)
            .map((o) => (
              <option key={o.provider} value={o.provider}>
                {o.company} · {o.model}
              </option>
            ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ash">給 AI 的建議（選填，140 字內；會當作建議而不是命令）</span>
        <textarea
          value={wish}
          maxLength={140}
          onChange={(e) => setWish(e.target.value)}
          rows={2}
          placeholder="例：請讓河邊多幾隻白鷺"
          className="border-ink-mid bg-ink-soft rounded border px-2 py-1.5"
        />
      </label>
      <button
        type="button"
        data-testid="donate-submit"
        disabled={busy || amount < 30}
        onClick={() => void submit()}
        className="bg-rust text-ink rounded px-4 py-2.5 font-bold disabled:opacity-50"
      >
        {busy ? "前往付款…" : `捐 NT$${amount.toLocaleString("en-US")}`}
      </button>
      <p className="text-ash-deep text-xs">
        每筆捐款會先扣除金流手續費、稅金與退款準備，其餘全數用於這一塊（明細見預算書）。最少 NT$30。
      </p>
      {error ? <p className="text-alarm text-sm">{error}</p> : null}
      {data.mine.length > 0 ? (
        <div className="text-ash text-xs">
          我在這一塊的捐款：
          {data.mine.map((d) => (
            <span key={d.id} className="ml-2">
              NT${d.amountTwd}（{d.status === "PAID" ? "已入帳" : d.status === "PENDING" ? "待付款" : d.status}
              {d.vote ? `，投 ${d.vote}` : "，未投票"}）
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
