import { WorldMap } from "@/components/WorldMap";
import { budgetConfig } from "@/lib/server/config";

/**
 * 世界地圖，視角從臺北 101 開始。開場畫面（`/`）的「進入城市」就是進到這裡。
 *
 * 底圖樣式可以用 `MAP_STYLE_URL` 換掉（例如自架的圖磚，或離線用的 `/map-style-blank.json`）；
 * 預設是 OpenFreeMap（OpenStreetMap 資料，免金鑰）。
 *
 * ★ 不用 `NEXT_PUBLIC_` 前綴：那會在 build 時寫死進程式碼，換底圖就得重新 build。
 *   在伺服器端讀、當 prop 傳下去，部署時改環境變數就生效。
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "世界地圖" };

export default function WorldPage() {
  const styleUrl = process.env.MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/liberty";
  return <WorldMap styleUrl={styleUrl} twdPerUsd={budgetConfig().twdPerUsd} />;
}
