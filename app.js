(() => {
  "use strict";

  const HISTORY_KEY = "receiptHistory";
  const RATE_CACHE_PREFIX = "fxRate_";
  const RATE_MAX_AGE_MS = 60 * 60 * 1000; // 1時間
  const AUTO_MODE_KEY = "autoModeEnabled";

  const els = {
    imageInput: document.getElementById("imageInput"),
    ocrBtn: document.getElementById("ocrBtn"),
    autoModeToggle: document.getElementById("autoModeToggle"),
    previewRow: document.getElementById("previewRow"),
    ocrProgress: document.getElementById("ocrProgress"),
    progressFill: document.getElementById("progressFill"),
    progressLabel: document.getElementById("progressLabel"),
    receiptsSection: document.getElementById("receiptsSection"),
    receiptsContainer: document.getElementById("receiptsContainer"),
    currencyListTemplate: document.getElementById("currencyListTemplate"),
    receiptCardTemplate: document.getElementById("receiptCardTemplate"),
    historyEmpty: document.getElementById("historyEmpty"),
    historyList: document.getElementById("historyList"),
    clearHistoryBtn: document.getElementById("clearHistoryBtn"),
  };

  let selectedFiles = [];

  // ---------- 初期化 ----------
  function populateCurrencyList() {
    els.currencyListTemplate.innerHTML = CURRENCIES.map(
      (c) => `<option value="${c.code}">${c.name}</option>`
    ).join("");
  }

  function todayStr() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ---------- 自動読み取りモード ----------
  els.autoModeToggle.checked = localStorage.getItem(AUTO_MODE_KEY) === "true";
  els.autoModeToggle.addEventListener("change", () => {
    localStorage.setItem(AUTO_MODE_KEY, els.autoModeToggle.checked ? "true" : "false");
  });

  // ---------- 画像選択（複数） ----------
  els.imageInput.addEventListener("change", () => {
    selectedFiles = Array.from(els.imageInput.files || []);
    els.previewRow.innerHTML = "";
    selectedFiles.forEach((file, idx) => {
      const wrap = document.createElement("div");
      wrap.className = "thumb-wrap";
      wrap.dataset.idx = idx;
      const url = URL.createObjectURL(file);
      wrap.innerHTML = `<img src="${url}" alt="${escapeHtml(file.name)}"><span class="thumb-status"></span>`;
      els.previewRow.appendChild(wrap);
    });
    els.ocrBtn.disabled = selectedFiles.length === 0;
    if (selectedFiles.length > 0 && els.autoModeToggle.checked) {
      runOcr();
    }
  });

  function setThumbStatus(idx, text) {
    const wrap = els.previewRow.querySelector(`.thumb-wrap[data-idx="${idx}"]`);
    if (wrap) wrap.querySelector(".thumb-status").textContent = text;
  }

  // ---------- OCR実行(複数枚を順番に処理) ----------
  els.ocrBtn.addEventListener("click", () => runOcr());

  async function runOcr() {
    if (selectedFiles.length === 0) return;
    els.ocrBtn.disabled = true;
    els.imageInput.disabled = true;
    els.ocrProgress.hidden = false;
    els.receiptsSection.hidden = false;

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      setThumbStatus(i, "待機中");
      els.progressLabel.textContent = `画像 ${i + 1}/${selectedFiles.length} を準備中...`;
      els.progressFill.style.width = "0%";
      try {
        const { data } = await Tesseract.recognize(file, "eng+jpn", {
          logger: (m) => {
            if (m.status && typeof m.progress === "number") {
              const pct = Math.round(m.progress * 100);
              els.progressFill.style.width = `${pct}%`;
              els.progressLabel.textContent = `画像 ${i + 1}/${selectedFiles.length}: ${translateStatus(m.status)} ${pct}%`;
              setThumbStatus(i, `${pct}%`);
            }
          },
        });
        const text = data.text || "";
        const parsed = parseReceiptText(text);
        createReceiptCard(file, parsed, text);
        setThumbStatus(i, "完了");
      } catch (err) {
        setThumbStatus(i, "失敗");
        console.error(`画像 ${i + 1} の読み取りに失敗:`, err);
      }
    }

    els.ocrProgress.hidden = true;
    els.ocrBtn.disabled = false;
    els.imageInput.disabled = false;
    els.receiptsSection.scrollIntoView({ behavior: "smooth" });
  }

  function translateStatus(status) {
    const map = {
      "loading tesseract core": "エンジン読込中",
      "initializing tesseract": "初期化中",
      "loading language traineddata": "言語データ読込中",
      "initializing api": "API初期化中",
      "recognizing text": "文字認識中",
    };
    return map[status] || status;
  }

  // ---------- レシート解析 ----------
  const SKIP_KEYWORDS = [
    "total", "subtotal", "sub total", "tax", "vat", "gst", "change", "cash",
    "credit", "balance", "due", "amount", "tender", "visa", "master",
    "合計", "小計", "税", "消費税", "お釣り", "predomessage", "thank",
  ];

  function parseReceiptText(text) {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const storeName = guessStoreName(lines);
    const date = guessDate(text) || todayStr();
    const currency = guessCurrency(text);
    const items = extractItems(lines);

    return { storeName, date, currency, items };
  }

  function guessStoreName(lines) {
    for (const line of lines.slice(0, 5)) {
      const letters = line.replace(/[^A-Za-z぀-ヿ一-鿿]/g, "");
      if (letters.length >= 2) return line;
    }
    return lines[0] || "";
  }

  function guessDate(text) {
    const patterns = [
      { re: /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/, order: [1, 2, 3] },
      { re: /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/, order: [3, 1, 2] },
      { re: /(\d{4})年(\d{1,2})月(\d{1,2})日/, order: [1, 2, 3] },
    ];
    for (const p of patterns) {
      const m = text.match(p.re);
      if (m) {
        const y = m[p.order[0]];
        const mo = String(m[p.order[1]]).padStart(2, "0");
        const d = String(m[p.order[2]]).padStart(2, "0");
        if (Number(y) > 1990 && Number(y) < 2100 && Number(mo) <= 12 && Number(d) <= 31) {
          return `${y}-${mo}-${d}`;
        }
      }
    }
    return null;
  }

  function guessCurrency(text) {
    const counts = {};
    for (const c of CURRENCIES) {
      const re = new RegExp(`\\b${c.code}\\b`);
      if (re.test(text)) counts[c.code] = (counts[c.code] || 0) + 3;
    }
    for (const c of CURRENCIES) {
      for (const sym of c.symbols) {
        if (sym.length <= 1 && text.includes(sym)) {
          counts[c.code] = (counts[c.code] || 0) + 1;
        }
      }
    }
    let best = null;
    let bestScore = 0;
    for (const [code, score] of Object.entries(counts)) {
      if (score > bestScore) {
        best = code;
        bestScore = score;
      }
    }
    return best || "USD";
  }

  function extractItems(lines) {
    const items = [];
    const amountRe = /([\d]{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*$/;
    for (const rawLine of lines) {
      const lower = rawLine.toLowerCase();
      if (SKIP_KEYWORDS.some((kw) => lower.includes(kw))) continue;
      const line = rawLine.replace(/^[^\dA-Za-z぀-ヿ一-鿿]+/, "");
      const m = line.match(amountRe);
      if (!m) continue;
      const amountStr = m[1];
      const amount = parseAmount(amountStr);
      if (amount === null || amount <= 0) continue;
      let description = line.slice(0, m.index).trim();
      description = description.replace(/[x×]\s*\d+\s*$/i, "").trim();
      description = description.replace(/[-:*.\s]+$/, "").trim();
      if (!description) description = "品目";
      if (description.length > 60) continue;
      items.push({ description, amount });
    }
    if (items.length === 0) items.push({ description: "", amount: 0 });
    return items;
  }

  function parseAmount(str) {
    let s = str.trim().replace(/\s/g, "");
    const hasComma = s.includes(",");
    const hasDot = s.includes(".");
    if (hasComma && hasDot) {
      if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
        s = s.replace(/\./g, "").replace(",", ".");
      } else {
        s = s.replace(/,/g, "");
      }
    } else if (hasComma && !hasDot) {
      const parts = s.split(",");
      if (parts[parts.length - 1].length === 2) {
        s = s.replace(",", ".");
      } else {
        s = s.replace(/,/g, "");
      }
    }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  // ---------- レシートカード（複数を独立して管理） ----------
  function createReceiptCard(file, parsed, rawText) {
    const frag = els.receiptCardTemplate.content.cloneNode(true);
    const card = frag.querySelector(".receipt-card");
    const c = {
      root: card,
      thumb: card.querySelector(".rc-thumb"),
      filename: card.querySelector(".rc-filename"),
      storeName: card.querySelector(".rc-storeName"),
      date: card.querySelector(".rc-date"),
      currency: card.querySelector(".rc-currency"),
      itemsBody: card.querySelector(".rc-itemsBody"),
      addRow: card.querySelector(".rc-addRow"),
      totalForeign: card.querySelector(".rc-totalForeign"),
      totalJPY: card.querySelector(".rc-totalJPY"),
      rateInfo: card.querySelector(".rc-rateInfo"),
      refreshRate: card.querySelector(".rc-refreshRate"),
      rawDetails: card.querySelector(".rc-rawDetails"),
      rawText: card.querySelector(".rc-rawText"),
      discard: card.querySelector(".rc-discard"),
      save: card.querySelector(".rc-save"),
    };

    let currentRate = null; // { rate, fetchedAt, fromCache, currency }

    c.thumb.src = URL.createObjectURL(file);
    c.filename.textContent = file.name;
    c.storeName.value = parsed.storeName;
    c.date.value = parsed.date;
    c.currency.value = parsed.currency;
    c.rawText.textContent = rawText;
    c.rawDetails.hidden = false;

    function addItemRow(description = "", amount = "") {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input type="text" class="desc-input" value="${escapeHtml(description)}" placeholder="品目"></td>
        <td class="amount-cell"><input type="number" step="0.01" class="amount-input" value="${amount}"></td>
        <td><button type="button" class="row-del" title="削除">✕</button></td>
      `;
      tr.querySelector(".row-del").addEventListener("click", () => {
        tr.remove();
        renderTotals();
      });
      tr.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", renderTotals));
      c.itemsBody.appendChild(tr);
    }

    parsed.items.forEach((item) => addItemRow(item.description, item.amount));
    c.addRow.addEventListener("click", () => addItemRow());

    function getItems() {
      return Array.from(c.itemsBody.querySelectorAll("tr")).map((tr) => ({
        description: tr.querySelector(".desc-input").value,
        amount: parseFloat(tr.querySelector(".amount-input").value) || 0,
      }));
    }

    function sumForeign() {
      return getItems().reduce((sum, it) => sum + it.amount, 0);
    }

    function renderTotals() {
      const total = sumForeign();
      const code = c.currency.value.trim().toUpperCase() || "USD";
      c.totalForeign.textContent = `${total.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${code}`;
      if (currentRate && currentRate.currency === code) {
        const jpy = total * currentRate.rate;
        c.totalJPY.textContent = `¥${Math.round(jpy).toLocaleString()}`;
      } else {
        c.totalJPY.textContent = "レート取得中...";
      }
    }

    async function fetchRateAndRender(forceRefresh = false) {
      const code = c.currency.value.trim().toUpperCase() || "USD";
      c.rateInfo.textContent = "レート取得中...";
      try {
        const result = await getRate(code, forceRefresh);
        currentRate = { currency: code, ...result };
        const dt = new Date(result.fetchedAt);
        const cacheNote = result.fromCache ? "（キャッシュ）" : "";
        c.rateInfo.textContent =
          code === "JPY"
            ? "通貨がJPYのため換算不要です"
            : `1 ${code} = ${result.rate.toLocaleString(undefined, { maximumFractionDigits: 4 })} 円 ${cacheNote} (${dt.toLocaleString("ja-JP")})`;
      } catch (err) {
        c.rateInfo.textContent = "レート取得に失敗しました（オフラインの可能性）";
        currentRate = null;
      }
      renderTotals();
    }

    c.currency.addEventListener("change", () => fetchRateAndRender());
    c.refreshRate.addEventListener("click", () => fetchRateAndRender(true));

    c.discard.addEventListener("click", () => {
      if (confirm("このレシートを破棄しますか？")) card.remove();
    });

    c.save.addEventListener("click", () => {
      const items = getItems().filter((it) => it.description || it.amount);
      const code = c.currency.value.trim().toUpperCase() || "USD";
      const totalForeign = sumForeign();
      const totalJPY = currentRate && currentRate.currency === code
        ? Math.round(totalForeign * currentRate.rate)
        : null;

      const record = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        storeName: c.storeName.value || "(店名未入力)",
        date: c.date.value || todayStr(),
        currency: code,
        items,
        totalForeign,
        totalJPY,
        savedRate: currentRate && currentRate.currency === code ? currentRate.rate : null,
      };

      const history = loadHistory();
      history.unshift(record);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
      renderHistory();

      card.classList.add("saved");
      c.save.disabled = true;
      c.save.textContent = "✅ 保存済み";
    });

    els.receiptsContainer.appendChild(frag);
    fetchRateAndRender();
  }

  // ---------- 為替レート ----------
  async function getRate(code, forceRefresh) {
    if (code === "JPY") return { rate: 1, fetchedAt: Date.now(), fromCache: false };

    const cacheKey = RATE_CACHE_PREFIX + code;
    const cachedRaw = localStorage.getItem(cacheKey);
    const cached = cachedRaw ? JSON.parse(cachedRaw) : null;

    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < RATE_MAX_AGE_MS) {
      return { rate: cached.rate, fetchedAt: cached.fetchedAt, fromCache: true };
    }

    try {
      const res = await fetch(`https://open.er-api.com/v6/latest/${code}`);
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      if (data.result !== "success" || !data.rates || !data.rates.JPY) {
        throw new Error("Invalid response");
      }
      const rate = data.rates.JPY;
      const fetchedAt = Date.now();
      localStorage.setItem(cacheKey, JSON.stringify({ rate, fetchedAt }));
      return { rate, fetchedAt, fromCache: false };
    } catch (err) {
      if (cached) return { rate: cached.rate, fetchedAt: cached.fetchedAt, fromCache: true };
      throw err;
    }
  }

  // ---------- 履歴 ----------
  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
    } catch {
      return [];
    }
  }

  function renderHistory() {
    const history = loadHistory();
    els.historyEmpty.hidden = history.length > 0;
    els.clearHistoryBtn.hidden = history.length === 0;
    els.historyList.innerHTML = "";

    history.forEach((rec) => {
      const div = document.createElement("div");
      div.className = "history-item";
      const jpyLabel = rec.totalJPY !== null ? `¥${rec.totalJPY.toLocaleString()}` : "換算不明";
      div.innerHTML = `
        <div class="hi-top"><span>${escapeHtml(rec.storeName)}</span><span>${jpyLabel}</span></div>
        <div class="hi-sub">${rec.date} ・ ${rec.totalForeign.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${rec.currency}</div>
        <div class="hi-detail" hidden>
          <table>${rec.items.map((it) => `<tr><td>${escapeHtml(it.description || "-")}</td><td style="text-align:right">${it.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${rec.currency}</td></tr>`).join("")}</table>
          <div class="hi-actions"><button type="button" class="btn btn-small btn-danger del-history">削除</button></div>
        </div>
      `;
      div.addEventListener("click", (e) => {
        if (e.target.closest(".del-history")) return;
        const detail = div.querySelector(".hi-detail");
        detail.hidden = !detail.hidden;
      });
      div.querySelector(".del-history").addEventListener("click", () => {
        const remaining = loadHistory().filter((r) => r.id !== rec.id);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(remaining));
        renderHistory();
      });
      els.historyList.appendChild(div);
    });
  }

  els.clearHistoryBtn.addEventListener("click", () => {
    if (confirm("全ての履歴を削除しますか？")) {
      localStorage.removeItem(HISTORY_KEY);
      renderHistory();
    }
  });

  // ---------- 起動 ----------
  populateCurrencyList();
  renderHistory();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => {
        console.warn("Service Worker登録に失敗しました:", err);
      });
    });
  }
})();
