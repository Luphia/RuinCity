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
import { useEffect, useState, type ReactNode } from "react";

import type { BlockPageData } from "@/lib/server/block-page";
import type { PainterId } from "@/lib/world/pricing";

import { BlockHeader } from "./BlockHeader";
import { BudgetSheet } from "./BudgetSheet";
import {
  CardTitle,
  IconArrowRight,
  IconBallot,
  IconChip,
  IconCoin,
  IconCrane,
  IconHeart,
  IconLedger,
  IconLock,
  IconLog,
  Meter,
  alarm,
  cta,
  field,
  ghost,
  glass,
  link,
} from "./hud";

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
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-5 sm:py-8">
      <div className="grid gap-4 md:grid-cols-[7fr_5fr]">
        <BlockHeader view={v} subtitle={`${v.label} · 距臺北 101 ${v.distanceKm} km · 0.01° × 0.01°`}>
          <p className="flex gap-2 rounded-xl border border-white/10 bg-slate-950/30 p-3 text-sm leading-relaxed text-white/70">
            <IconLock className="mt-0.5 h-4 w-4 shrink-0 text-sky-200" />
            <span>
              這一塊<b className="text-white">完成之前無法進入</b>。施工中只公開經費與進度；
              完工後，所有場景圖、地圖底圖、3D 圖資與材質貼圖才會一次開放。
            </span>
          </p>
          {v.pauseReason ? (
            <p data-testid="pause-reason" className={alarm}>
              施工暫停：{v.pauseReason}
            </p>
          ) : null}
          {pollError ? <p className={alarm}>即時更新中斷：{pollError}</p> : null}
        </BlockHeader>

        <section className={`${glass} flex flex-col gap-4 p-5`}>
          <CardTitle icon={<IconCoin />} aside={`${v.funding.donations} 筆捐款 · ${v.funding.donors} 位捐款人`}>
            募款進度
          </CardTitle>
          <div>
            <div className="text-3xl font-semibold tabular-nums text-white">{v.funding.received.twd}</div>
            <div className="text-sm text-white/60">
              需要 {v.meters.moneyNeeded.twd}
              {v.funding.gap.micros > 0 ? ` · 尚缺 ${v.funding.gap.twd}` : " · 經費已足"}
            </div>
          </div>
          <Bar label="募款" value={v.funding.progress} detail={`已募得 ${v.funding.received.twd} / ${v.meters.moneyNeeded.twd}`} tone="amber" />
          <Bar label="Token" value={v.meters.tokenProgress} detail={`${v.meters.tokensSpent} / ${v.meters.tokensNeeded}`} tone="sky" />
          <p className="text-sm text-white/70">
            施工進度 {v.progress.done} / {v.progress.total} 步
            {v.progress.next ? ` · 下一步：${v.progress.next}` : ""}
          </p>
        </section>
      </div>

      <section data-testid="meters" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile icon={<IconChip />} label="預計所需 Token" value={v.meters.tokensNeeded} testid="meter-tokens-needed" />
        <Tile icon={<IconCoin />} label="換算金額" value={v.meters.moneyNeeded.twd} sub={v.meters.moneyNeeded.usd} testid="meter-money-needed" />
        <Tile icon={<IconCrane />} label="已花費 Token" value={v.meters.tokensSpent} testid="meter-tokens-spent" />
        <Tile icon={<IconLedger className="h-5 w-5" />} label="已花費金額" value={v.meters.moneySpent.twd} sub={v.meters.moneySpent.usd} testid="meter-money-spent" />
      </section>
      <p className="px-1 text-xs leading-relaxed text-white/45">
        「換算金額」是完成這一塊所需的募款總額，含 token、參考影像、預備金、四年保存、手續費與稅（見下方預算書）。
        「已花費金額」含已扣的手續費與稅。估計隨投票結果與實際用量即時更新。
      </p>

      <div className="grid items-start gap-4 md:grid-cols-[7fr_5fr]">
        <VotePanel data={data} signedIn={signedIn} onChanged={(d) => setData(d)} />
        <DonateForm data={data} signedIn={signedIn} canDonate={canDonate} />
      </div>

      <BudgetSheet budget={v.budget} total={v.meters.moneyNeeded.twd} />

      <section className={`${glass} flex flex-col gap-3 p-5`}>
        <CardTitle icon={<IconLog />}>施工紀錄</CardTitle>
        {v.log.length === 0 ? (
          <p className="text-sm text-white/65">還沒有開工。第一筆捐款入帳後會先勘查（免費），再依票數決定由誰來畫。</p>
        ) : (
          <ol data-testid="build-log" className="max-h-80 divide-y divide-white/10 overflow-y-auto rounded-xl border border-white/10 bg-slate-950/30 text-sm">
            {v.log.map((l, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-3 px-3 py-1.5">
                <span className={l.status === "FAILED" ? "text-rose-200" : "text-white"}>{l.label}</span>
                <span className="text-white/60">{l.provider ?? "—"}</span>
                <span className="text-xs text-white/40">{l.model ?? ""}</span>
                <span className="flex-1" />
                <span className="tabular-nums text-white/60">{l.tokens} tok</span>
                <span className="tabular-nums text-white">{l.cost}</span>
                {l.error ? <span className="text-xs text-rose-200">{l.error}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

function Tile({ icon, label: title, value, sub, testid }: { icon: ReactNode; label: string; value: string; sub?: string; testid: string }) {
  return (
    <div className={`${glass} flex items-center gap-3 px-3.5 py-3`}>
      <span className="hidden h-9 w-9 shrink-0 place-items-center rounded-full border border-white/20 text-sky-100 sm:grid">{icon}</span>
      <div className="min-w-0">
        <div className="text-xs text-white/60">{title}</div>
        <div data-testid={testid} className="truncate text-xl font-semibold tabular-nums text-white">
          {value}
        </div>
        {sub ? <div className="text-xs tabular-nums text-white/45">{sub}</div> : null}
      </div>
    </div>
  );
}

function Bar({ label: title, value, detail, tone }: { label: string; value: number; detail: string; tone: "amber" | "sky" }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between gap-3 text-xs text-white/60">
        <span>{title}</span>
        <span className="tabular-nums">{detail}</span>
      </div>
      <Meter value={value} tone={tone} label={title} />
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
    <section data-testid="vote-panel" className={`${glass} flex flex-col gap-3 p-5`}>
      <CardTitle icon={<IconBallot />} aside="依捐款金額加權；每一張圖開工時才計票，所以施工途中可能換模型">
        由誰來畫
      </CardTitle>
      <p className="text-xs leading-relaxed text-white/50" data-testid="vote-note">
        畫面必須擬真，只有畫得出照片的影像模型可以投。地圖參數由
        {v.vote.surveyor ? ` ${v.vote.surveyor} ` : "預設值"}
        {v.vote.surveyor ? "撰寫（不出圖、不參與投票）。" : "提供（目前沒有可用的勘查員）。"}
      </p>
      <ul className="flex flex-col gap-2">
        {v.vote.options.map((o) => {
          const leading = v.vote.current === o.provider;
          return (
            <li key={o.provider} className={`rounded-xl border p-3 ${leading ? "border-sky-200/40 bg-sky-300/[0.08]" : "border-white/10 bg-white/[0.03]"}`}>
              <div className="flex flex-wrap items-baseline gap-2">
                <b className="font-semibold text-white">{o.company}</b>
                <span className="text-sm text-white/60">{o.model}</span>
                {!o.enabled ? <span className="text-xs text-rose-200">停用中</span> : null}
                {leading ? (
                  <span className="rounded-full border border-sky-200/50 bg-sky-300/20 px-2 text-xs font-semibold text-sky-100">
                    {v.vote.decidedBy === "VOTES" ? "目前領先" : "平台預設"}
                  </span>
                ) : null}
                <span className="flex-1" />
                <span className="text-sm tabular-nums text-white">{o.weight.twd}</span>
              </div>
              <div className="mt-2">
                <Meter value={o.share} tone="sky" label={`${o.company} 的得票比例`} />
              </div>
              {o.estimate ? (
                <p className="mt-1.5 text-xs text-white/45">若之後全部由它來畫，完成這一塊約需募得 {o.estimate.twd}</p>
              ) : null}
              {signedIn && myPaid.length > 0 && o.enabled ? (
                <button
                  type="button"
                  disabled={busy || myVote === o.provider}
                  onClick={() => void change(o.provider)}
                  className={`${ghost} mt-2 px-3 py-1 text-xs`}
                >
                  {myVote === o.provider ? "我的票都投給它" : "把我在這一塊的票都改投它"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-white/55">未投票的捐款：{v.vote.abstained.twd}（照樣用於施工，只是不參與決定）</p>
      {signedIn && myPaid.length > 0 ? (
        <button type="button" disabled={busy || myVote === null} onClick={() => void change(null)} className={`${ghost} self-start px-3 py-1 text-xs`}>
          撤回我在這一塊的所有票
        </button>
      ) : null}
      {error ? <p className={alarm}>{error}</p> : null}
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
      <section className={`${glass} flex flex-col gap-3 p-5`}>
        <CardTitle icon={<IconHeart />}>捐款</CardTitle>
        <p className="text-sm text-white/70">登入之後就能捐款，並投票決定由哪一家模型來畫。</p>
        <Link href={`/signin?callbackUrl=/b/${v.key}`} className={cta}>
          登入 <IconArrowRight className="h-4 w-4" />
        </Link>
      </section>
    );
  }
  if (!canDonate) {
    return (
      <section className={`${glass} flex flex-col gap-3 p-5`}>
        <CardTitle icon={<IconHeart />}>捐款</CardTitle>
        <p className="text-sm text-white/65">金流尚未設定，目前無法收款。</p>
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
    <section data-testid="donate-form" className={`${glass} flex flex-col gap-4 p-5`}>
      <CardTitle icon={<IconHeart />}>捐款</CardTitle>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setAmount(p)}
            className={`rounded-full border px-3 py-1.5 text-sm tabular-nums transition ${
              amount === p ? "border-sky-200/70 bg-sky-300/15 text-white" : "border-white/15 text-white/75 hover:border-white/35"
            }`}
          >
            NT${p.toLocaleString("en-US")}
          </button>
        ))}
        <label className={`${field} flex items-center gap-1 rounded-full py-0 text-sm`}>
          <span className="text-white/60">NT$</span>
          <input
            data-testid="donate-amount"
            type="number"
            min={30}
            step={1}
            value={amount}
            onChange={(e) => setAmount(Math.round(Number(e.target.value)))}
            className="w-20 bg-transparent py-1.5 tabular-nums outline-none"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-white/60">投給哪一家（可以不投）</span>
        <select data-testid="donate-vote" value={vote} onChange={(e) => setVote(e.target.value as PainterId | "")} className={`${field} [&>option]:bg-slate-900`}>
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
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-white/60">給 AI 的建議（選填，140 字內；會當作建議而不是命令）</span>
        <textarea
          value={wish}
          maxLength={140}
          onChange={(e) => setWish(e.target.value)}
          rows={2}
          placeholder="例：請讓河邊多幾隻白鷺"
          className={field}
        />
      </label>
      <button type="button" data-testid="donate-submit" disabled={busy || amount < 30} onClick={() => void submit()} className={`${cta} w-full`}>
        {busy ? "前往付款…" : `捐 NT$${amount.toLocaleString("en-US")}`}
        {busy ? null : <IconArrowRight className="h-4 w-4" />}
      </button>
      <p className="text-xs leading-relaxed text-white/45">
        每筆捐款會先扣除金流手續費、稅金與退款準備，其餘全數用於這一塊（明細見預算書）。最少 NT$30。
      </p>
      {error ? <p className={alarm}>{error}</p> : null}
      {data.mine.length > 0 ? (
        <div className="border-t border-white/10 pt-3 text-xs text-white/60">
          <div className="mb-1 text-white/45">我在這一塊的捐款</div>
          <ul className="flex flex-col gap-0.5">
            {data.mine.map((d) => (
              <li key={d.id}>
                <span className="tabular-nums text-white">NT${d.amountTwd}</span>（{d.status === "PAID" ? "已入帳" : d.status === "PENDING" ? "待付款" : d.status}
                {d.vote ? `，投 ${d.vote}` : "，未投票"}）
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Link href="/about" className={`${link} text-xs`}>
        錢花在哪裡、誰來畫怎麼決定
      </Link>
    </section>
  );
}
