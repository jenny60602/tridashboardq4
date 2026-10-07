# 事件監聽（取代 HTML 事件屬性）

`index.html` 原本在畫面字串裡寫 `onclick="…"`、`onchange="…"` 等 HTML 事件屬性，參數直接拼進 JavaScript 程式碼。現在全部 145 個改成：

- 畫面產生時用 `uiEvent(事件, 動作, [參數], 輸入轉換, 停止冒泡)` 輸出 `data-ui-<事件>="…"`，內容是已 HTML 跳脫的 JSON。
- 檔案最後每種事件只在 `document` 掛一個監聽器 `dispatchUiEvent()`，它只執行 `UI_ACTIONS` 白名單裡對應該事件的動作，不執行字串程式碼，也不接受任意全域函式名稱。參數只能是字串、數字、布林或 null。
- 輸入值的轉換（`value`、`checked`、空字串轉 null／0、`trim`、分期數 1～24）集中在 `UI_INPUTS`，行為與原本的內嵌程式相同。
- 原本 `event.stopPropagation()` 的位置以 `stop` 旗標保留；拖放的 `dragover`／`dragleave`／`drop` 樣式切換與子列、任務容器的區分不變。
- 未登入（`ME` 為空）時只允許「登入」按鈕與密碼欄的 Enter；其他動作一律不執行。伺服器仍會用通行證再檢查身分，這只是畫面層的防護。

各操作函式（`window.setField` 等）、登入流程、財務權限與同步邏輯都沒有改。

## 新增按鈕時

```js
`<button ${uiEvent('click','toggleExpand',[String(p.id)])}>展開</button>`
`<input ${uiEvent('change','setField',[String(p.id),'notes'],'value')}>`
```

然後把動作名稱加入 `UI_ACTIONS` 對應事件的清單；`tests/events.test.cjs` 會檢查每個用到的動作都在白名單內、且對應的 `window` 函式存在。

`scripts/convert-inline-events.py` 是這次一次性轉換用的工具，保留供審查；遇到無法辨識的寫法會直接報錯，不會猜。

## 尚未處理

畫面仍以 `innerHTML` 產生（輸出已跳脫）。改成 DOM 節點建立，以及正式網站的 Content-Security-Policy，留待之後另外處理。
