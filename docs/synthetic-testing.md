# 合成資料測試與本機預覽

所有測試只用 `tests/fixtures/dashboard-fixture.cjs` 的虛構專案、人名、金額與假密碼。不得放入正式資料、權限表、GAS 回應或從 Git 歷史取出的名單。

## 執行測試

```sh
node --test tests/*.test.cjs
```

瀏覽器測試需要 Playwright；沒有安裝時會自動略過並標示 skip（不算通過）。已全域安裝時可用 `NODE_PATH=<全域 node_modules> node --test tests/*.test.cjs`。

## 本機預覽

```sh
node scripts/preview-synthetic.cjs 8787
# 開 http://127.0.0.1:8787/
```

- 只綁定 127.0.0.1；API 是程序記憶體內的替身，重啟即重設，不寫檔、不連外。
- 啟動前把唯一的 `SHEET_API_URL` 換成本機路徑；若頁面仍含正式 Apps Script 網域就拒絕啟動。
- 保留正式頁面的 CSP，另外再加一層只允許同源連線的 CSP（兩者同時生效）；正式 CSP 以外的地方若仍出現 Apps Script 網域就拒絕啟動。
- `tests/xss.test.cjs` 把攻擊字串放進所有可編輯欄位並走過各畫面，確認沒有被注入的元素、沒有非 https 連結，並驗證 CSP 會擋下事件屬性、Excel 匯出在 CSP 下仍可用。
- 替身依 GAS v10 的約定運作：`GET ?ping=1` 回 `{api:4}`；`login` 用密碼換通行證；`read`／`write` 帶通行證並回傳 `me`、`state`（依角色移除財務欄位）與 `config`；`logout` 作廢通行證。

替身只用來操作畫面，**不代表正式 GAS 的三方合併、權限或部署驗證**。正式相容性仍要在部署協調時另外確認。
