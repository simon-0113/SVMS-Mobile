"use strict";

(() => {
  let salesDatabase = null;
  let salesByName = new Map();
  let salesByDistributorName = new Map();
  let salesByDistributorCustomerId = new Map();
  let salesByAddress = new Map();

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

  function customerIdKey(distributor, customerId) {
    const d = String(distributor || "").trim();
    const c = String(customerId || "").trim().toUpperCase();
    return d && c ? `${normalize(d)}::${c}` : "";
  }

  function getSalesRecord(store) {
    if (!store || typeof normalize !== "function") return null;

    const distributor = String(store.distributor || "").trim();
    const customerId = String(store.distributor_customer_id || "").trim().toUpperCase();
    const nameKey = normalize(store.store_name);

    // 1. 最安全：經銷商 + 經銷客戶編號
    const cidKey = customerIdKey(distributor, customerId);
    if (cidKey) {
      const byId = salesByDistributorCustomerId.get(cidKey) || [];
      if (byId.length === 1) return byId[0];
      if (byId.length > 1) return null; // 不猜
    }

    // 2. 經銷商 + 店名
    if (distributor) {
      const directKey = `${normalize(distributor)}::${nameKey}`;
      const direct = salesByDistributorName.get(directKey) || [];
      if (direct.length === 1) return direct[0];
    }

    // 3. 只有資料足夠時才做地址確認
    const storeAddress = normalizeAddress(store.address);
    const candidates = salesByName.get(nameKey) || [];
    if (candidates.length === 1) {
      const candidate = candidates[0];
      const sameDistributor = !distributor || normalize(candidate.distributor || "") === normalize(distributor);
      const candidateAddress = normalizeAddress(candidate.address);
      const sameAddress = !storeAddress || !candidateAddress ||
        candidateAddress === storeAddress ||
        candidateAddress.includes(storeAddress) ||
        storeAddress.includes(candidateAddress);
      if (sameDistributor && sameAddress) return candidate;
    }

    return null;
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
    </section>`;
  }

  if (typeof renderGT === "function") {
    const originalRenderGT = renderGT;
    renderGT = function(store) {
      const html = originalRenderGT(store);
      const marker = '<section class="section"><h3>GT巡店資料</h3>';
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

      (data.stores || []).forEach(item => {
        const nameKey = normalize(item.store_name);
        if (!salesByName.has(nameKey)) salesByName.set(nameKey, []);
        salesByName.get(nameKey).push(item);

        const distributor = String(item.distributor || item.distributor_source || "").trim();
        if (distributor) {
          const directKey = `${normalize(distributor)}::${nameKey}`;
          if (!salesByDistributorName.has(directKey)) salesByDistributorName.set(directKey, []);
          salesByDistributorName.get(directKey).push(item);

          const idKey = customerIdKey(distributor, item.customer_id);
          if (idKey) {
            if (!salesByDistributorCustomerId.has(idKey)) salesByDistributorCustomerId.set(idKey, []);
            salesByDistributorCustomerId.get(idKey).push(item);
          }
        }

        const addressKey = normalizeAddress(item.address);
        if (addressKey) {
          if (!salesByAddress.has(addressKey)) salesByAddress.set(addressKey, []);
          salesByAddress.get(addressKey).push(item);
        }
      });

      console.info(`[SVMS] Sales loaded: ${data.stores?.length || 0} records / ${salesByDistributorCustomerId.size} exact distributor-customer keys`);
    })
    .catch(error => console.warn("[SVMS] Sales load failed:", error));
})();
