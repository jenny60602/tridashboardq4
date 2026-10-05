# 僅使用合成資料的本機測試

測試及預覽只使用虛構專案、人員、金額與假密碼。不得讀取歷史 Git 中的真實 catalog、執行真實 catalog 產生器、匯入正式備份，或在測試中使用公司帳密。現有登入測試只檢查公開前端的空 catalog 宣告及合成流程。

## 本機畫面預覽

```sh
node scripts/preview-synthetic.cjs
```

開啟 `http://127.0.0.1:4173/`。也可指定 `--port=4174`。伺服器只綁定 `127.0.0.1`，不開放其他網路介面。結束程序後，所有合成修改都會消失；重新啟動會回到 fixture。沒有資料檔案寫入、試算表操作或正式 GAS 呼叫。

頁面頂端會顯示醒目的「離線合成測試」標示，以及以下假密碼：

| 合成身分 | 假密碼 |
| --- | --- |
| admin | `fake-admin` |
| finance | `fake-finance` |
| owner | `fake-owner` |
| none／一般成員 | `fake-member` |

伺服器在記憶體中把唯一的 `SHEET_API_URL` 宣告替換成 `/__test_api__`。若宣告不是恰好一個，或替換後仍含 `script.google.com`，便拒絕提供頁面。原始 `index.html` 不會被改寫。

只提供首頁、固定的本機 XLSX vendor 檔，以及合成 API；其他路徑均拒絕。瀏覽器的 CSP 將連線限制在同一個本機 origin，並以 `script-src-attr 'none'` 禁止 inline event handler，讓預覽也能驗證事件委派流程。API 的讀寫只使用每個程序各自的記憶體資料；沒有舊 Git、私人 catalog、環境變數中的 API 設定或外部網路來源。

合成 API 提供簡化的角色遮蔽，方便檢查畫面與事件操作。**它不是正式 GAS 的替代實作**，不能用來證明正式後端的三方合併、權限保護、復原或部署是否正確。

## 離線 VM harness

`tests/helpers/offline-dashboard.cjs` 的 `makeHarness(t, options)` 使用替身 DOM、sessionStorage、localStorage、時間與 fetch。所有請求都必須有預先排入的合成回應，未預期的請求會使測試失敗；它沒有真實 fetch 或其他網路介面。

`options.createDOM({html, source})` 或 `options.dom` 可注入支援事件委派的專用 DOM，回傳 `document`、`nodes`（Map）、`whoami` 與 `scripts`（Array）。共用 harness 與舊登入 harness 會保留同一事件的多個 listener，並區分 capture／bubble 順序，避免把既有輸入或拖曳監聽器覆蓋掉。

本機測試不等同瀏覽器或正式部署驗收。任何新增測試 fixture 都應保持虛構資料，不要為了「貼近真實」複製公司內容。

```sh
node --test tests/auth-frontend.test.cjs tests/helpers/synthetic-environment.test.cjs
```

合成環境測試涵蓋 endpoint 替換與拒絕規則、固定路由與 CSP、假角色讀寫、程序間資料隔離、listener 保留，以及四種合成角色的實際畫面產生。`startPreview({port:0})` 可供測試取得系統分配的本機 port；測試結束應關閉回傳的 `server`。
