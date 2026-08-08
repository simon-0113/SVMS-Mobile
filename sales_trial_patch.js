"use strict";

(() => {
  let salesDatabase = null;
  let salesByName = new Map();
  let salesByDistributorName = new Map();

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

  function formatSalesQty(value) {
    if (value === null || value === undefined || value === "") return "—";
    const num = Number(value);
    if (Number.isNaN(num)) return String(value);
    return Number.isInteger(num) ? String(num) : String(Math.round(num * 1000) / 1000);
  }

  function normalizeAddress(value) {
    return String(value || "")
      .normalize("NFKC")
      .toUpperCase()
      .replace(/[台臺]/g, "台")
      .replace(/[\s_\-－—()（）【】[\]．。、,，./／]/g, "");
  }

  function getSalesRecord(store) {
    if (!store || typeof normalize !== "function") return null;

    const nameKey = normalize(store.store_name);
    const distributor = String(store.distributor || "").trim();

    // 第一順位：經銷商 + 店名
    if (distributor) {
      const directKey = `${normalize(distributor)}::${nameKey}`;
      const direct = salesByDistributorName.get(directKey) || [];
      if (direct.length === 1) return direct[0];

      if (direct.length > 1) {
        const storeAddress = normalizeAddress(store.address);
        if (storeAddress) {
          const addressMatch = direct.find(item => {
            const candidateAddress = normalizeAddress(item.address);
            return candidateAddress &&
              (candidateAddress === storeAddress ||
               candidateAddress.includes(storeAddress) ||
               storeAddress.includes(candidateAddress));
          });
          if (addressMatch) return addressMatch;
        }
        return direct[0];
      }
    }

    // 第二順位：同店名 + 地址
    const candidates = salesByName.get(nameKey) || [];
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];

    const storeAddress = normalizeAddress(store.address);
    if (storeAddress) {
      const addressMatch = candidates.find(item => {
        const candidateAddress = normalizeAddress(item.address);
        return candidateAddress &&
          (candidateAddress === storeAddress ||
           candidateAddress.includes(storeAddress) ||
           storeAddress.includes(candidateAddress));
      });
      if (addressMatch) return addressMatch;
    }

    // 最後才使用單純店名 fallback
    const sameDistributor = distributor
      ? candidates.find(item => normalize(item.distributor || "") === normalize(distributor))
      : null;
    if (sameDistributor) return sameDistributor;

    return candidates[0];
  }

  function renderSalesData(store) {
    const record = getSalesRecord(store);

    if (!salesDatabase) {
      return `<section class="section"><h3>進貨品項資料</h3><div class="value">進貨資料載入中…</div></section>`;
    }
    if (!record) {
      return `<section class="section"><h3>進貨品項資料</h3><div class="value">此店尚無 6–7 月進貨資料。</div></section>`;
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
      <p class="form-help">僅顯示 6 月或 7 月有進貨數值的品項。</p>
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
      salesByName = new Map();
      salesByDistributorName = new Map();

      (data.stores || []).forEach(item => {
        const nameKey = normalize(item.store_name);
        if (!salesByName.has(nameKey)) salesByName.set(nameKey, []);
        salesByName.get(nameKey).push(item);

        const distributor = String(item.distributor || "").trim();
        if (distributor) {
          const directKey = `${normalize(distributor)}::${nameKey}`;
          if (!salesByDistributorName.has(directKey)) salesByDistributorName.set(directKey, []);
          salesByDistributorName.get(directKey).push(item);
        }
      });

      console.info(`[SVMS] Sales loaded: ${data.stores?.length || 0} records / ${salesByName.size} unique names / ${salesByDistributorName.size} distributor-name keys`);
    })
    .catch(error => {
      console.warn("[SVMS] Sales load failed:", error);
    });
})();
