# /lib/engine — 結算引擎

> 世界狀態 = f(上次結算狀態, 期間內所有已排程事件, 時間)
> 而 f 必須是**確定性**且**冪等**的。

與 `/lib/game` 的分工：`/lib/game` 是純函式的規則，
`/lib/engine` 負責把規則接上資料庫與事件表，並處理併發與冪等。

| 檔案 | 內容 | 里程碑 |
| --- | --- | --- |
| `settle.ts` | `settlePlayer()` 雙軌結算（Pull / Push） | M2 |
| `events.ts` | 事件排程與 `FOR UPDATE SKIP LOCKED` 取用 | M2 |
