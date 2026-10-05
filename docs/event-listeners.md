這次將 `index.html` 的 112 個 HTML 事件屬性（click、change、keydown、dragstart、dragover、dragleave、drop）改成 `data-ui-*` JSON 資料與固定事件監聽器。

`uiEvent()` 只輸出已轉義的 JSON；`dispatchUiEvent()` 只接受對應事件的 `UI_ACTIONS` 明確清單，不執行字串、不從任意全域函式名稱呼叫。重繪或重新登入不會重新註冊監聽器。既有操作函式與登入、財務權限判斷保持原位。

沿原事件路徑處理，可保留子元素停止冒泡、Drive 連結正常開啟，以及拖放子列和任務容器的差別。`change` 仍用 `change`，並保留勾選、字串、空值轉 null／0、發票號碼 trim、期數限制與連結輸入元素參照。

本 PR 接續登入限制 PR #2，因此以 `security/require-login-to-view` 為比較基準。它不新增 GAS 變更，不合併或部署；前端發布仍需遵守既有登入限制部署順序。

驗證只能使用 `tests/fixtures/` 的虛構資料與本機記憶體 API。禁止將正式資料、權限表、GAS 回應或 Git 歷史真實名單匯入測試；原先讀歷史名單的測試已移除。預覽方式見 [合成資料測試](synthetic-testing.md)。

本次完成 HTML 事件屬性遷移，仍保留既有的 `innerHTML` 畫面生成與輸出轉義。逐步改成 DOM 節點建立及正式 CSP 可另行處理；本機測試頁使用的 CSP 不代表正式網站已部署 CSP。
