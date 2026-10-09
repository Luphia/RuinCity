import Link from "next/link";

import { IconArrowRight, cta, glass, label, link } from "@/components/hud";

import { budgetConfig } from "@/lib/server/config";
import { BIBLE_SUMMARY_ZH } from "@/lib/world/bible";
import { MAX_SCENES, TEXTURES_PER_BLOCK } from "@/lib/world/plan";
import { MODEL_PROFILES, PAINTERS, SURVEYORS } from "@/lib/world/pricing";

export const metadata = { title: "怎麼運作" };

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

export default function About() {
  const c = budgetConfig();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-5 leading-relaxed sm:py-8">
      <section className={`${glass} flex flex-col gap-2 p-5`}>
        <div className={label}>RuinCity · 怎麼運作</div>
        <h1 className="text-3xl font-semibold tracking-wide text-white">千年之後</h1>
        <p className="text-white/70">
          把地球依經緯度切成 0.01° × 0.01° 的區塊（在臺北約 1.0 × 1.1 公里），
          用大家的捐款請 AI 畫出每一塊在人類離開一千年後的樣子。從臺北 101 開始，
          哪一塊先蓋好，取決於誰為它捐款。
        </p>
      </section>

      <section className={`${glass} flex flex-col gap-2 p-5`}>
        <h2 className="text-lg font-semibold text-white">世界觀</h2>
        <ul className="list-disc pl-5 text-white/70 marker:text-sky-200/70">
          {BIBLE_SUMMARY_ZH.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </section>

      <section className={`${glass} flex flex-col gap-2 p-5`}>
        <h2 className="text-lg font-semibold text-white">一塊地圖怎麼蓋</h2>
        <ol className="list-decimal pl-5 text-white/70 marker:text-sky-200/70">
          <li>勘查：在塊內 10×10 個點查 Google 街景，選出最多 {MAX_SCENES} 個標記座標（免費）</li>
          <li>地圖參數：看地圖與幾張代表性街景，定下這一塊的地貌、水位、植被、材質與每個標記的說明</li>
          <li>標記座標場景圖：每個標記一張「一千年後」的地面景像（最多 {MAX_SCENES} 張）</li>
          <li>正射地圖底圖：俯視、北朝上、剛好框住這一塊 —— 世界地圖上看到的就是它</li>
          <li>3D 圖資：與底圖對齊的高度圖，疊起來就是 3D 地景</li>
          <li>材質貼圖：{TEXTURES_PER_BLOCK} 張可平鋪的材質，供 3D 使用</li>
        </ol>
        <p className="text-white/70">
          <b className="text-white">完成前無法進入。</b>施工中只公開四個數字：預計所需 Token、換算金額、已花費
          Token、已花費金額，以及一份逐項列出算法的預算書。
        </p>
      </section>

      <section className={`${glass} flex flex-col gap-2 p-5`}>
        <h2 className="text-lg font-semibold text-white">誰來畫：依捐款金額投票</h2>
        <p className="text-white/70">
          每一筆捐款都可以選一家模型（也可以不投）。每一張圖開工的那一刻計票，
          得票金額最高的那一家來畫。所以施工途中只要有人捐款改變了票數，
          下一張就會換模型 —— 同一塊裡會有兩家的筆觸，是設計的一部分。
        </p>
        <ul className="list-disc pl-5 text-white/70 marker:text-sky-200/70">
          {PAINTERS.map((p) => (
            <li key={p}>
              {MODEL_PROFILES[p].company} · {MODEL_PROFILES[p].displayName}
            </li>
          ))}
        </ul>
        <p className="text-white/70">同票時依上面的順序決定；沒有任何人投票時用平台預設。</p>
        <p className="text-white/70">
          <b className="text-white">畫面必須擬真。</b>
          每一張圖都要看起來像在現場拍的照片：地面是紀實攝影、地圖是航測正射影像、材質是掃描貼圖，
          不是插畫、不是概念圖、不是遊戲畫面。只有畫得出照片的模型能被投票。
        </p>
        <p className="text-white/70">
          「地圖參數」那一步只寫設定、不出圖，由勘查員負責，不參與投票：
          {SURVEYORS.map((p) => MODEL_PROFILES[p].displayName).join("，沒有的話由 ")}；兩家都沒有就用預設參數。
        </p>
      </section>

      <section className={`${glass} flex flex-col gap-2 p-5`}>
        <h2 className="text-lg font-semibold text-white">錢花在哪裡</h2>
        <ul className="list-disc pl-5 text-white/70 marker:text-sky-200/70">
          <li>建設 token：各步驟實際用掉的 token × 該模型的公開費率</li>
          <li>參考影像費：Google 街景與地圖靜態圖的每次請求費</li>
          <li>失敗重試準備 {pct(c.retryReserveRate)}、匯率與價格波動緩衝 {pct(c.volatilityRate)}：只對還沒做的步驟提列，沒用完列為結餘</li>
          <li>
            地圖資料 {c.retentionMonths / 12} 年保存：Boltchain SwarmStorage {c.swarmReplicas} 個副本加站內 {c.storageReplicas}{" "}
            份。容量、讀寫與傳輸以 AWS S3 的收費為參考（US${c.storageUsdPerGbMonth}/GB‧月），保存委託的手續費以 Ethereum
            主網的 gas 為參考（{c.gasPriceGwei} gwei × US${c.ethUsd.toLocaleString("en-US")}/ETH）。完工時一次撥入保存基金
          </li>
          <li>伺服器運算與資料庫分攤：每塊 US${c.computeUsdPerBlock}</li>
          <li>平台管理費：{c.platformFeeRate > 0 ? pct(c.platformFeeRate) : "0%（不抽成）"}</li>
          <li>金流手續費 {pct(c.paymentFeeRate)} + 每筆 NT${c.paymentFeeFixedTwd}、稅金與規費 {pct(c.taxRate)}、退款與拒付準備 {pct(c.chargebackRate)}</li>
        </ul>
        <p className="text-white/70">
          金額以美元計價、以新台幣（目前 1 美元 = {c.twdPerUsd} 元）收款；每筆捐款入帳時記下當時的匯率。
        </p>
      </section>

      <section className={`${glass} flex flex-col gap-2 p-5`}>
        <h2 className="text-lg font-semibold text-white">永久保存：任何人都能重建</h2>
        <p className="text-white/70">
          每一塊完成後，所有的圖、座標、地圖參數、3D 的渲染規格，以及一個不連網、不依賴任何函式庫的檢視器，
          會打包成一個 IPFS 資料夾。它的 CID 由內容決定：同樣的內容永遠是同一個 CID，任何人都能用標準的 IPFS 工具重算。
        </p>
        <p className="text-white/70">
          這個資料夾交給 Boltchain 的 SwarmStorage 付費保存：合約隨機抽出 {c.swarmReplicas} 個節點各存一份，每個 epoch
          抽查，保存失敗會被罰款並換人。任何 Boltchain 節點的閘道都能把整包取回來；打開裡面的 index.html，就是同一個場景。
        </p>
        <p className="text-white/70">
          AI 繪製無法重現（同一個提示詞畫兩次是兩張圖），所以重建用的是當初畫出來的成品，而不是重畫一次。
        </p>
        <p className="text-white/70">
          每一包都以{" "}
          <a href="https://creativecommons.org/publicdomain/zero/1.0/" className={link} rel="license">
            CC0 1.0
          </a>{" "}
          釋出（寫在包裡的 scene.json）：任何人都可以複製、修改、散布與商業使用，不需要徵求同意。
        </p>
      </section>

      <p className="pt-2">
        <Link href="/world" className={cta}>
          進入世界地圖 <IconArrowRight className="h-4 w-4" />
        </Link>
      </p>
    </main>
  );
}
