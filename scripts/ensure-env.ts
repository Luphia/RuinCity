import "./load-env";

/**
 * `pnpm dev` 啟動前執行：AUTH_SECRET、CRON_SECRET 缺了就隨機產生並寫進 .env.local。
 * 已經有就什麼都不做（不會換掉 —— 換掉 AUTH_SECRET 會讓所有人被登出）。
 */

import { ensureSecretsForRun } from "./local-env";

ensureSecretsForRun((line) => console.log(`[env] ${line}`));
