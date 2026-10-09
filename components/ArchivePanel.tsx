/**
 * 「永久保存」：這一塊的場景包在哪裡、誰在保存、任何人怎麼重建它。
 */

import type { ArchiveView } from "@/lib/server/archive-view";

export function ArchivePanel({ archive }: { archive: ArchiveView | null }) {
  if (!archive) {
    return (
      <section data-testid="archive-panel" className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">永久保存</h2>
        <p className="text-ash text-sm">場景包打包中：完工後的下一輪排程會產生它的 CID。</p>
      </section>
    );
  }
  const a = archive;
  const active = a.deals.filter((d) => d.status === "ACTIVE");
  return (
    <section data-testid="archive-panel" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">永久保存</h2>
        <span className="text-ash text-xs" data-testid="archive-status">
          {a.statusLabel}
          {a.demo ? "（示範模式：沒有真的上鏈）" : ""}
        </span>
      </div>
      <p className="text-ash text-sm leading-relaxed">
        這一塊的所有圖、座標、渲染規格與檢視器打包成一個 IPFS 資料夾，由 Boltchain SwarmStorage
        付費委託多個節點保存、每個 epoch 抽查。任何人拿到這個資料夾，都能重建一模一樣的場景 ——
        不需要這個網站。
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-ash">場景包 CID</dt>
        <dd className="break-all font-mono text-xs" data-testid="scene-cid">
          {a.sceneCid}
        </dd>
        <dt className="text-ash">委託索引 CID</dt>
        <dd className="break-all font-mono text-xs" data-testid="deal-index-cid">
          {a.dealIndexCid}
        </dd>
        <dt className="text-ash">大小</dt>
        <dd>
          {a.sizeMb} MB · {a.blockCount} 個區塊
        </dd>
        <dt className="text-ash">保存到</dt>
        <dd>{a.retainUntil}</dd>
        <dt className="text-ash">授權</dt>
        <dd data-testid="scene-license">
          {a.license ? (
            <a href={a.license.url} className="text-rust underline" target="_blank" rel="license noreferrer">
              {a.license.name}
            </a>
          ) : (
            "（這一包早於授權欄位，未標示）"
          )}
          {a.license?.id === "CC0-1.0" ? <span className="text-ash text-xs"> · 任何人都可以複製、修改、散布與商業使用</span> : null}
        </dd>
      </dl>

      {a.deals.length ? (
        <ul className="flex flex-col gap-1 text-xs" data-testid="archive-deals">
          {a.deals.map((d) => (
            <li key={d.txHash} className="text-ash">
              {d.status === "ACTIVE"
                ? `委託 #${d.dealId} · ${d.replicas} 個副本${d.openReplicas !== null ? `（${d.openReplicas} 個在線）` : ""} · epoch ${d.startEpoch}–${d.endEpoch} · ${d.costBolt} BOLT`
                : d.status === "SUBMITTED"
                  ? `委託送出中（${d.epochs} 個 epoch · ${d.costBolt} BOLT）`
                  : `委託失敗：${d.error ?? "未知原因"}`}
              <span className="text-ash-deep"> · {d.network}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {a.lastError ? <p className="text-alarm text-xs">最近一次保存失敗：{a.lastError}（稍後自動重試）</p> : null}
      {active.length === 0 && !a.lastError && a.status === "PACKED" ? (
        <p className="text-ash-deep text-xs">平台尚未設定 Boltchain，或委託還在排隊。場景包已經可以下載與驗證。</p>
      ) : null}

      <div className="flex flex-wrap gap-3 text-sm">
        <a href={a.browseUrl} className="text-rust underline" target="_blank" rel="noreferrer" data-testid="archive-browse">
          用場景包裡的檢視器開啟
        </a>
        <a href={a.carUrl} className="text-rust underline" data-testid="archive-car">
          下載整包（CAR）
        </a>
        {a.gatewayCarUrls.map((u) => (
          <a key={u} href={u} className="text-rust underline" target="_blank" rel="noreferrer">
            從 Boltchain 閘道取回
          </a>
        ))}
      </div>
      <details className="text-ash text-xs">
        <summary className="cursor-pointer">自己驗證</summary>
        <div className="mt-2 flex flex-col gap-1 leading-relaxed">
          <p>
            在 RuinCity 原始碼裡：<code>pnpm scene:verify {a.sceneCid.slice(0, 12)}….car --extract ./scene</code>
            —— 重算 CID、核對每個檔案的 SHA-256，並把資料夾解出來。
          </p>
          <p>
            或用 Kubo 解開後重算：<code>{a.kuboCommand}</code>，結果應該是上面的場景包 CID。
          </p>
          <p>解出來的資料夾用任何 HTTP 伺服器開（例如 <code>python3 -m http.server</code>），就是同一個場景。</p>
        </div>
      </details>
    </section>
  );
}
