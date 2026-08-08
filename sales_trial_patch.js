"use strict";

(() => {
  let salesDatabase = null;
  let salesByCustomerId = new Map();

  const style = document.createElement("style");
  style.textContent = `
  .sales-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:12px}
  .sales-summary>div{padding:10px;border:1px solid var(--line);border-radius:10px;background:#f9fafb}
  .sales-summary span{display:block;color:var(--muted);font-size:11px;margin-bottom:4px}
  .sales-summary strong{font-size:17px}
  .sales-table{overflow:hidden;border:1px solid var(--line);border-radius:10px}
  .sales-row{display:grid;grid-template-columns:minmax(150px,1fr) 62px 62px;align-items:center;border-top:1px solid var(--line);min-height:38px}
  .sales-row:first-child{border-top:0}
  .sales-row>div{padding:8px;text-align:center;font-size:13px}
  .sales-row .sales-product{text-align:left;overflow-wrap:anywhere}
  .sales-header{background:#f3f4f6;font-weight:800}
  .sales-empty{padding:16px;color:var(--muted);font-size:13px}
  @media(max-width:560px){
    .sales-summary{grid-template-columns:repeat(3,minmax(0,1fr))}
    .sales-row{grid-template-columns:minmax(125px,1fr) 54px 54px}
    .sales-summary strong{font-size:15px}
  }`;
  document.head.appendChild(style);

  function normalizeId(value) {
    return String(value ?? "").trim().replace(/\.0$/, "");
  }

  function normalizePerson(value) {
    return String(value || "").normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
  }

  function normalizeAddress(value) {
    return String(value || "")
      .normalize("NFKC")
      .toUpperCase()
      .replace(/[臺台]/g, "台")
      .replace(/[－—–]/g, "-")
      .replace(/\s+/g, "")
      .replace(/[，,。．]/g, "")
      .replace(/號之/g, "號");
  }

  function nameTokens(value) {
    const raw = String(value || "").normalize("NFKC").toUpperCase();
    const cleaned = raw
      .replace(/[()（）【】\[\]]/g, " ")
      .replace(/[_－—–]/g, "-")
      .replace(/[.,，。．/／]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const generic = [
      "商店","商行","超商","超市","便利商店","便利","購物中心","購物商場",
      "五金百貨","五金","百貨","菸酒","菸酒專賣店","洋酒","有限公司","股份有限公司",
      "店","PS"
    ];

    let compact = cleaned.replace(/\s/g, "");
    generic.forEach(word => { compact = compact.replaceAll(word, ""); });

    const parts = cleaned
      .split(/[\s\-]+/)
      .map(x => x.trim())
      .filter(Boolean)
      .filter(x => !generic.includes(x));

    if (compact) parts.push(compact);
    return [...new Set(parts.filter(x => x.length >= 2))];
  }

  function isSimilarStoreName(gtName, salesName) {
    const gt = normalize(gtName);
    const sales = normalize(salesName);

    if (!gt || !sales) return false;
    if (gt === sales) return true;
    if (gt.includes(sales) || sales.includes(gt)) return true;

    const gtTokens = nameTokens(gtName);
    const salesTokens = nameTokens(salesName);

    return gtTokens.some(a =>
      salesTokens.some(b =>
        a === b ||
        (a.length >= 3 && b.includes(a)) ||
        (b.length >= 3 && a.includes(b))
      )
    );
  }

  function sameAddress(a, b) {
    const x = normalizeAddress(a);
    const y = normalizeAddress(b);
    if (!x || !y) return false;
    if (x === y) return true;

    // 只接受「高度接近」地址，不做全資料庫地址猜測
    const minLen = Math.min(x.length, y.length);
    if (minLen < 8) return false;
    return x.includes(y) || y.includes(x);
  }

  function getSalesRecord(store) {
    if (!store || !salesDatabase || typeof normalize !== "function") return null;

    // 第一順位：經銷客戶編號
    const customerId = normalizeId(store.distributor_customer_id);
    if (customerId) {
      const idMatches = salesByCustomerId.get(customerId) || [];
      if (idMatches.length === 1) return idMatches[0];

      // 編號若意外重複，仍用經銷商確認
      if (idMatches.length > 1) {
        const distributor = normalize(store.distributor || "");
        const narrowed = idMatches.filter(item =>
          normalize(item.distributor || item.distributor_source || "") === distributor
        );
        return narrowed.length === 1 ? narrowed[0] : null;
      }
      return null;
    }

    // 第二順位：店名只負責產生「相似候選」
    let candidates = (salesDatabase.stores || []).filter(item =>
      isSimilarStoreName(store.store_name, item.store_name)
    );
    if (!candidates.length) return null;

    // 第三順位：確認經銷商
    const distributor = normalize(store.distributor || "");
    if (!distributor) return null;
    candidates = candidates.filter(item =>
      normalize(item.distributor || item.distributor_source || "") === distributor
    );
    if (!candidates.length) return null;

    // 第四順位：確認經銷業務
    const salesperson = normalizePerson(store.distributor_salesperson);
    if (!salesperson) return null;
    candidates = candidates.filter(item =>
      normalizePerson(item.salesperson) === salesperson
    );
    if (!candidates.length) return null;

    // 第五順位：地址做最後確認
    const address = normalizeAddress(store.address);
    if (!address) return null;
    candidates = candidates.filter(item => sameAddress(address, item.address));

    // 必須唯一，否則不匯出
    return candidates.length === 1 ? candidates[0] : null;
  }

  function formatSalesQty(value) {
    if (value === null || value === undefined || value === "") return "—";
    const num = Number(value);
    if (Number.isNaN(num)) return String(value);
    return Number.isInteger(num) ? String(num) : String(Math.round(num * 1000) / 1000);
  }

  function renderSalesData(store) {
    const record = getSalesRecord(store);

    if (!salesDatabase) {
      return `<section class="section"><h3>進貨品項資料</h3><div class="value">進貨資料載入中…</div></section>`;
    }
    if (!record) {
      return `<section class="section"><h3>進貨品項資料</h3><div class="value">此店目前無法安全配對進貨資料。</div></section>`;
    }

    const june = record.months?.["2026-06"] || { products: {} };
    const july = record.months?.["2026-07"] || { products: {} };
    const order = salesDatabase?.product_order || [];
    const products = order.filter(product =>
      june.products?.[product] !== undefined || july.products?.[product] !== undefined
    );

    const totalJune = june.ktg_total;
    const totalJuly = july.ktg_total;
    const diff = (typeof totalJune === "number" && typeof totalJuly === "number")
      ? totalJuly - totalJune
      : null;

    const rows = products.length
      ? products.map(product => `
        <div class="sales-row">
          <div class="sales-product">${escapeHtml(product)}</div>
          <div>${escapeHtml(formatSalesQty(june.products?.[product]))}</div>
          <div>${escapeHtml(formatSalesQty(july.products?.[product]))}</div>
        </div>`).join("")
      : `<div class="sales-empty">6–7 月無品項進貨紀錄。</div>`;

    return `<section class="section">
      <h3>進貨品項資料</h3>
      <div class="sales-summary">
        <div><span>6月 KT&G</span><strong>${escapeHtml(formatSalesQty(totalJune))}</strong></div>
        <div><span>7月 KT&G</span><strong>${escapeHtml(formatSalesQty(totalJuly))}</strong></div>
        <div><span>月增減</span><strong>${diff === null ? "—" : `${diff > 0 ? "+" : ""}${escapeHtml(formatSalesQty(diff))}`}</strong></div>
      </div>
      <div class="sales-table">
        <div class="sales-row sales-header"><div>品項</div><div>6月</div><div>7月</div></div>
        ${rows}
      </div>
      <p class="form-help">進貨資料僅在店家身分安全配對成功後顯示。</p>
    </section>`;
  }

  if (typeof renderGT === "function") {
    const originalRenderGT = renderGT;
    renderGT = function(store) {
      const html = originalRenderGT(store);
      const marker = '<section class="section"><h3>最近巡店歷程</h3>';
      return html.includes(marker)
        ? html.replace(marker, `${renderSalesData(store)}${marker}`)
        : html;
    };
  }

  fetch("data/sales_index.json", { cache: "no-store" })
    .then(response => {
      if (!response.ok) throw new Error(`sales_index.json HTTP ${response.status}`);
      return response.json();
    })
    .then(data => {
      salesDatabase = data;
      salesByCustomerId = new Map();

      (data.stores || []).forEach(item => {
        const id = normalizeId(item.customer_id);
        if (!id) return;
        if (!salesByCustomerId.has(id)) salesByCustomerId.set(id, []);
        salesByCustomerId.get(id).push(item);
      });

      console.info(`[SVMS] Safe sales matching loaded: ${data.stores?.length || 0} records / ${salesByCustomerId.size} customer IDs`);
    })
    .catch(error => {
      console.warn("[SVMS] Sales load failed:", error);
    });
})();
