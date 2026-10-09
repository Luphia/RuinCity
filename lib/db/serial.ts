/**
 * 同一個行程內，對本機 SQLite 的所有存取排成一列。
 *
 * ## ★ 為什麼需要
 *
 * libSQL 的本機驅動是**同步**的：連線在 SQLite 的 busy handler 裡等鎖時，卡住的是整個 Node 事件迴圈。
 * 同一個行程裡如果一條連線拿著交易（`BEGIN IMMEDIATE`）、另一條連線要寫 ——
 * 第二條在 busy handler 裡空轉，拿著交易的那一條永遠等不到事件迴圈回來提交，
 * 兩邊一起卡到 busy timeout，然後 SQLITE_BUSY。（整合測試「同一筆付款通知同時送到」重現過這件事）
 *
 * 所以在行程內先用一把**非同步**的鎖排隊：一般查詢拿一下就放，交易從 BEGIN 拿到 COMMIT／ROLLBACK。
 * busy timeout 只剩下跨行程（web 與 worker）的情況要處理，而那時候等的是**另一個**行程，它會往前走。
 *
 * ★ 交易裡不可以用交易外的 `db`：它會排在自己後面，等不到。等超過 `waitMs` 會丟出明確的錯誤，而不是卡住。
 */

import type { Client, InStatement, ResultSet, Transaction, TransactionMode } from "@libsql/client";

type Release = () => void;

export function serializeClient(client: Client, waitMs: number): Client {
  let tail: Promise<void> = Promise.resolve();

  const lock = (what: string): Promise<Release> => {
    let release!: Release;
    const held = new Promise<void>((r) => (release = r));
    const prev = tail;
    tail = prev.then(() => held);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `等資料庫鎖超過 ${waitMs} ms（${what}）。最常見的原因：在交易的 callback 裡用了交易外的 db —— 一律用交易給的 tx。`,
            ),
          ),
        waitMs,
      );
    });
    return Promise.race([prev, timeout]).then(
      () => {
        clearTimeout(timer);
        let done = false;
        return () => {
          if (done) return;
          done = true;
          release();
        };
      },
      (e) => {
        // 放棄排隊：輪到我們時立刻讓給下一個
        void prev.then(() => release());
        throw e;
      },
    );
  };

  const locked =
    <A extends unknown[], R>(what: string, fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      const release = await lock(what);
      try {
        return await fn(...a);
      } finally {
        release();
      }
    };

  const wrapTransaction = (tx: Transaction, release: Release): Transaction =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        if (prop === "commit" || prop === "rollback") {
          return async () => {
            try {
              return await (target[prop] as () => Promise<void>).call(target);
            } finally {
              release();
            }
          };
        }
        if (prop === "close") {
          return () => {
            try {
              target.close();
            } finally {
              release();
            }
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });

  return new Proxy(client, {
    get(target, prop, receiver) {
      switch (prop) {
        case "execute":
          return locked("execute", (stmt: InStatement) => target.execute(stmt) as Promise<ResultSet>);
        case "batch":
          return locked("batch", (stmts: InStatement[], mode?: TransactionMode) => target.batch(stmts, mode));
        case "migrate":
          return locked("migrate", (stmts: InStatement[]) => target.migrate(stmts));
        case "executeMultiple":
          return locked("executeMultiple", (sql: string) => target.executeMultiple(sql));
        case "transaction":
          return async (mode?: TransactionMode) => {
            const release = await lock("transaction");
            try {
              return wrapTransaction(await target.transaction(mode), release);
            } catch (e) {
              release();
              throw e;
            }
          };
        default: {
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        }
      }
    },
  });
}
