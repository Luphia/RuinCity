import { MapView } from "@/components/map/MapView";

export const metadata = { title: "地圖 · RuinCity" };

/**
 * 賽季地圖。**公開路由，不需登入。**
 *
 * 地形 chunk 本來就是 CDN 上的靜態檔（`docs/01` §3.2），
 * 而五項公平性驗證的數字要在封盤期公開（`docs/13` §3）——
 * 想登記的人本來就該先看得到這一季的地圖長什麼樣、公不公平。
 *
 * 玩家自己的狀態（我的據點、我的行軍）要等 M2 有 session 之後才疊上來。
 */
export default function MapPage() {
  return <MapView />;
}
