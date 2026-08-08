"use strict";

let database = null;
let productCatalog = null;
let currentStore = null;

const SESSION_KEY = "svms_mobile_today_session_v2";
const SESSION_BACKUP_KEY = "svms_mobile_today_session_v2_backup";
const SESSION_DB_NAME = "svms_mobile_session_backup";
const SESSION_DB_STORE = "session";
const SESSION_DB_RECORD = "today_session";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const text = (value, fallback = "—") => value === null || value === undefined || value === "" ? fallback : String(value);
const escapeHtml = value => text(value, "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function localDateISO() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function formatTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
}

function normalize(value) {
  let result = text(value, "").normalize("NFKC").toUpperCase().replace(/[\s_\-－—()（）【】[\]．。、,，./／]/g, "");
  [["7-ELEVEN", "711"], ["7ELEVEN", "711"], ["7-11", "711"], ["全家便利商店", "FM"], ["FAMILYMART", "FM"], ["全家", "FM"], ["萊爾富便利商店", "HL"], ["HILIFE", "HL"], ["萊爾富", "HL"], ["OKMART", "OK"], ["OK超商", "OK"]]
    .forEach(([from, to]) => { result = result.replaceAll(from, to); });
  return result;
}

function stripPrefix(value) {
  const normalized = normalize(value);
  for (const prefix of ["711", "FM", "HL", "OK"]) if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  return normalized;
}

function scoreStore(query, store) {
  const full = normalize(query);
  const stripped = stripPrefix(query);
  const names = new Set([normalize(store.store_name), stripPrefix(store.store_name), ...(store.aliases || []).map(normalize)]);
  if (names.has(full) || names.has(stripped)) return 100;
  if ([...names].some(name => full && name.includes(full))) return 80;
  if ([...names].some(name => name && full.includes(name))) return 70;
  return 0;
}

function searchStores(query, limit = 15) {
  if (!database || !query.trim()) return [];
  const ranked = database.stores.map(store => ({ store, score: scoreStore(query, store) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.store.store_name.localeCompare(b.store.store_name));
  if (!ranked.length) return [];
  const top = ranked[0].score;
  return (top >= 80 ? ranked.filter(item => item.score === top) : ranked).slice(0, limit).map(item => item.store);
}

function showView(id, title) {
  $$(".view").forEach(view => { view.hidden = view.id !== id; });
  $("#pageTitle").textContent = title;
  $("#backButton").hidden = id === "homeView";
  if (id === "sessionView") renderSession();
  window.scrollTo(0, 0);
}

function info(label, value, full = false) {
  return `<div class="info ${full ? "full" : ""}"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(text(value))}</span></div>`;
}

function pills(values) {
  if (!values?.length) return `<span class="value">—</span>`;
  return `<div class="pills">${values.map(item => `<span class="pill">${escapeHtml(item)}</span>`).join("")}</div>`;
}

function renderHistory(history) {
  if (!history?.length) return `<div class="value">—</div>`;
  return history.slice(0, 5).map(item => `<div class="history-item"><div class="history-date">${escapeHtml(text(item["巡店日期"]))}</div><div class="history-detail">${[["配合度", item["配合度"]], ["銷售", item["銷售"]], ["備註", item["備註"]], ["機會點", item["機會點"]]].filter(([, v]) => v).map(([k, v]) => `${escapeHtml(k)}：${escapeHtml(v)}`).join("<br>") || "—"}</div></div>`).join("");
}


function gtDisplayName(store) {
  const distributor = text(store?.distributor, "").trim();
  return distributor ? `${store.store_name}（${distributor}）` : store.store_name;
}

function renderGT(store) {
  return `<article class="card"><div class="card-head"><h2>${escapeHtml(gtDisplayName(store))}</h2><div class="meta">GT｜${escapeHtml(text(store.city))} ${escapeHtml(text(store.district))}</div></div>
    <section class="section"><h3>GT查核資料</h3><div class="info-grid">${info("經銷商", store.distributor)}${info("經銷商業務", store.distributor_salesperson)}${info("地址", store.address, true)}${info("合作等級", store.audit_cooperation)}${info("簽約型態", store.contract_type)}${info("簽約格數", store.contract_slots)}${info("陳列獎金", store.display_bonus)}<div class="info full"><span class="label">查核陳列</span>${pills(store.audit_display)}</div><div class="info full"><span class="label">查核分布</span>${pills(store.audit_distribution)}</div></div></section>
    <section class="section"><h3>GT巡店資料</h3><div class="info-grid">${info("最近巡店日期", store.visit_date)}${info("配合度", store.visit_cooperation)}${info("客群", store.visit_customer_group)}${info("銷售", store.visit_sales)}${info("機會點", store.visit_opportunity, true)}${info("備註", store.visit_note, true)}</div></section>
    <section class="section"><h3>最近巡店歷程</h3>${renderHistory(store.visit_history)}</section>
    <section class="section"><button class="update-launch" type="button" data-start-update>開始巡店更新</button></section></article>`;
}

function renderCVS(store) {
  return `<article class="card"><div class="card-head"><h2>${escapeHtml(store.store_name)}</h2><div class="meta">${escapeHtml(text(store.channel))}｜${escapeHtml(text(store.city))} ${escapeHtml(text(store.district))}</div></div>
    <section class="section"><h3>門市資料</h3><div class="info-grid">${info("最近巡店日期", store.visit_date)}${info("小煙架", store.small_rack)}${info("LINE OA", store.line_oa)}${info("配合度", store.cooperation)}${info("客群", store.customer_group, true)}${info("銷售", store.sales, true)}${info("備註", store.note, true)}</div></section>
    <section class="section"><button class="update-launch" type="button" data-start-update>開始巡店更新</button></section></article>`;
}

function renderStore(store) {
  currentStore = store;
  $("#emptyState").hidden = true;
  $("#results").hidden = false;
  $("#results").innerHTML = store.channel === "GT" ? renderGT(store) : renderCVS(store);
  $("[data-start-update]").addEventListener("click", () => openUpdate(store));
  $("#suggestions").hidden = true;
}

function renderMatches(matches) {
  $("#emptyState").hidden = true;
  $("#results").hidden = false;
  if (!matches.length) {
    const query = $("#storeQuery").value.trim();
    $("#results").innerHTML = `<div class="not-found"><strong>最新正式資料中未找到。</strong><p>若這是尚未建立資料的 CVS 門市，可直接新增巡店。</p><button id="addNewCVSButton" class="add-cvs-button" type="button">新增 CVS 店家</button></div>`;
    $("#addNewCVSButton").addEventListener("click", () => openUpdate(createNewCVSStore(query)));
    return;
  }
  if (matches.length === 1) return renderStore(matches[0]);
  $("#results").innerHTML = `<h2 class="multiple-title">找到 ${matches.length} 個可能店家</h2><div class="match-list">${matches.map((store, index) => `<button class="match-button" data-index="${index}" type="button"><strong>${escapeHtml(store.channel === "GT" ? gtDisplayName(store) : store.store_name)}</strong><span>${escapeHtml(text(store.channel))}｜${escapeHtml(text(store.city))} ${escapeHtml(text(store.district))}</span></button>`).join("")}</div>`;
  $$(".match-button").forEach(button => button.addEventListener("click", () => renderStore(matches[Number(button.dataset.index)])));
}

function fieldHTML(id, label, value = "", type = "text", full = false) {
  return `<div class="form-field ${full ? "full" : ""}"><label for="${id}">${escapeHtml(label)}</label><input id="${id}" type="${type}" value="${escapeHtml(value)}"></div>`;
}

function selectHTML(id, label, options, selected = "", full = false) {
  return `<div class="form-field ${full ? "full" : ""}"><label for="${id}">${escapeHtml(label)}</label><select id="${id}">${options.map(option => `<option value="${escapeHtml(option.value ?? option)}" ${(option.value ?? option) === selected ? "selected" : ""}>${escapeHtml((option.label ?? option) || "—")}</option>`).join("")}</select></div>`;
}

function textareaHTML(id, label, value = "") {
  return `<div class="form-field full"><label for="${id}">${escapeHtml(label)}</label><textarea id="${id}">${escapeHtml(value)}</textarea></div>`;
}

function productStatusTable(saved = {}) {
  const groups = productCatalog?.groups || [];
  const standalone = productCatalog?.standalone || [];
  const rows = products => products.map(product => {
    const status = saved[product] || "";
    return `<div class="product-row" data-product="${escapeHtml(product)}"><div class="product-name">${escapeHtml(product)}</div>${["display", "distribution", "out_of_stock"].map(value => `<label class="status-cell"><input type="checkbox" name="product_${escapeHtml(product)}" value="${value}" ${status === value ? "checked" : ""}><span>${value === "display" ? "陳列" : value === "distribution" ? "分布" : "缺貨"}</span></label>`).join("")}</div>`;
  }).join("");
  return `<div class="product-status"><div class="product-row product-header"><div>品項</div><div>陳列</div><div>分布</div><div>缺貨</div></div>${groups.map(group => `<div class="series-title">${escapeHtml(group.series)}</div>${rows(group.products)}`).join("")}${standalone.length ? `<div class="series-title">其他</div>${rows(standalone)}` : ""}</div><p class="form-help">所有品項預設空白；每個品項只能選擇一種狀態。</p>`;
}

function bindProductStatusControls() {
  $$(".product-row[data-product]").forEach(row => {
    const controls = [...row.querySelectorAll('input[type="checkbox"]')];
    controls.forEach(control => control.addEventListener("change", () => {
      if (!control.checked) return;
      controls.forEach(other => {
        if (other !== control) other.checked = false;
      });
    }));
  });
}

function createNewCVSStore(query = "") {
  return {
    channel: "",
    store_name: query.trim(),
    aliases: [],
    city: "",
    district: "",
    is_new_cvs: true
  };
}

function gtForm(store, saved = {}) {
  return `<div class="form-section"><h3>基本資料</h3><div class="form-grid">${fieldHTML("visit_date", "巡店日期", saved.visit_date || localDateISO(), "date")}${fieldHTML("store_name", "店家名稱", saved.store_name || store.store_name)}${selectHTML("cooperation", "配合度", ["", "高", "中", "低", "待觀察"], saved.cooperation || "")}${selectHTML("line_oa", "LINE OA", [{ value: "", label: "—" }, { value: "true", label: "有" }, { value: "false", label: "無" }], saved.line_oa === true ? "true" : saved.line_oa === false ? "false" : "")}${fieldHTML("customer_group", "客群", saved.customer_group || "")}${fieldHTML("sales", "銷售", saved.sales || "")}</div></div>
    <div class="form-section"><h3>現場品項狀況</h3>${productStatusTable(saved.product_status || {})}</div>
    <div class="form-section"><h3>本次異動</h3><div class="form-grid">${selectHTML("optimization", "本次完成優化", [{ value: "false", label: "否" }, { value: "true", label: "是" }], saved.optimization ? "true" : "false")}${fieldHTML("new_slots", "新增格數", String(saved.new_slots ?? 0), "number")}${selectHTML("monster_box", "怪獸盒", [{ value: "false", label: "無" }, { value: "true", label: "有" }], saved.monster_box ? "true" : "false")}${selectHTML("annual_contract", "年度合約", ["", "續約", "無意願續約", "新增格數簽約", "牌面好無產值", "不建議續約"], saved.annual_contract || "")}${textareaHTML("opportunity", "機會點", saved.opportunity || "")}${textareaHTML("note", "備註", saved.note || "")}</div></div>`;
}

function cvsForm(store, saved = {}) {
  return `<div class="form-section"><h3>門市資料</h3><div class="form-grid">${fieldHTML("visit_date", "巡店日期", saved.visit_date || localDateISO(), "date")}${fieldHTML("store_name", "門市名稱", saved.store_name || store.store_name)}${selectHTML("store_type", "門市類別", ["", "711", "FM", "HL", "OK"], saved.store_type || store.channel || "")}${fieldHTML("city", "縣市", saved.city || store.city || "")}${fieldHTML("district", "行政區", saved.district || store.district || "")}${selectHTML("cooperation", "配合度", ["", "高", "中", "低", "待觀察"], saved.cooperation || "")}${selectHTML("line_oa", "LINE OA", [{ value: "", label: "—" }, { value: "true", label: "有" }, { value: "false", label: "無" }], saved.line_oa === true ? "true" : saved.line_oa === false ? "false" : "")}${selectHTML("small_rack", "小煙架", [{ value: "", label: "—" }, { value: "true", label: "有" }, { value: "false", label: "無" }], saved.small_rack === true ? "true" : saved.small_rack === false ? "false" : "")}${fieldHTML("customer_group", "客群", saved.customer_group || "")}${fieldHTML("sales", "銷售資料", saved.sales || "")}${fieldHTML("sales_grade", "銷售等級", saved.sales_grade || "")}${fieldHTML("activity", "活動", saved.activity || "")}${textareaHTML("note", "備註", saved.note || "")}</div></div>`;
}

function openUpdate(store, sessionItem = null) {
  currentStore = store;
  const channel = store.channel === "GT" ? "GT" : "CVS";
  $("#updateChannel").value = channel;
  $("#editingSessionId").value = sessionItem?.id || "";
  $("#updateStoreTitle").textContent = store.is_new_cvs ? "新增 CVS 店家｜巡店更新" : `${store.store_name}｜巡店更新`;
  $("#updateFields").innerHTML = channel === "GT" ? gtForm(store, sessionItem?.update || {}) : cvsForm(store, sessionItem?.update || {});
  if (channel === "GT") bindProductStatusControls();
  showView("updateView", sessionItem ? "修改巡店" : (store.is_new_cvs ? "新增 CVS 店家" : "巡店更新"));
}

function boolOrUndefined(value) {
  return value === "" ? undefined : value === "true";
}

function collectGT() {
  const productStatus = {};
  $$(".product-row[data-product]").forEach(row => {
    const checked = row.querySelector("input:checked");
    if (checked) productStatus[row.dataset.product] = checked.value;
  });
  const display = Object.keys(productStatus).filter(product => productStatus[product] === "display");
  const distribution = Object.keys(productStatus).filter(product => productStatus[product] === "distribution");
  const outOfStock = Object.keys(productStatus).filter(product => productStatus[product] === "out_of_stock");
  return {
    visit_date: $("#visit_date").value,
    store_name: $("#store_name").value.trim(),
    tracking_mode: "full_sync",
    display,
    distribution,
    out_of_stock: outOfStock,
    product_status: productStatus,
    cooperation: $("#cooperation").value,
    line_oa: boolOrUndefined($("#line_oa").value),
    customer_group: $("#customer_group").value.trim(),
    sales: $("#sales").value.trim(),
    opportunity: $("#opportunity").value.trim(),
    optimization: $("#optimization").value === "true",
    new_slots: Math.max(0, Number.parseInt($("#new_slots").value || "0", 10)),
    monster_box: $("#monster_box").value === "true",
    annual_contract: $("#annual_contract").value,
    note: $("#note").value.trim()
  };
}

function collectCVS() {
  return {
    visit_date: $("#visit_date").value,
    store_name: $("#store_name").value.trim(),
    store_type: $("#store_type").value,
    city: $("#city").value.trim(),
    district: $("#district").value.trim(),
    customer_group: $("#customer_group").value.trim(),
    small_rack: boolOrUndefined($("#small_rack").value),
    sales: $("#sales").value.trim(),
    sales_grade: $("#sales_grade").value.trim(),
    line_oa: boolOrUndefined($("#line_oa").value),
    cooperation: $("#cooperation").value,
    activity: $("#activity").value.trim(),
    note: $("#note").value.trim()
  };
}

/* ---------- Session persistence: Local Storage + IndexedDB backup ---------- */

function parseSession(raw) {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function getSession() {
  const primary = parseSession(localStorage.getItem(SESSION_KEY));
  if (primary.length) return primary;

  const secondary = parseSession(localStorage.getItem(SESSION_BACKUP_KEY));
  if (secondary.length) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(secondary)); } catch {}
    return secondary;
  }

  return [];
}

function openSessionDB() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return resolve(null);

    const request = indexedDB.open(SESSION_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_DB_STORE)) {
        db.createObjectStore(SESSION_DB_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveSessionToIndexedDB(session) {
  try {
    const db = await openSessionDB();
    if (!db) return;

    await new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_DB_STORE, "readwrite");
      tx.objectStore(SESSION_DB_STORE).put({
        session,
        saved_at: new Date().toISOString()
      }, SESSION_DB_RECORD);

      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

    db.close();
  } catch (error) {
    console.warn("[SVMS] IndexedDB backup failed:", error);
  }
}

async function loadSessionFromIndexedDB() {
  try {
    const db = await openSessionDB();
    if (!db) return [];

    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_DB_STORE, "readonly");
      const req = tx.objectStore(SESSION_DB_STORE).get(SESSION_DB_RECORD);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    db.close();
    return Array.isArray(record?.session) ? record.session : [];
  } catch (error) {
    console.warn("[SVMS] IndexedDB restore failed:", error);
    return [];
  }
}


async function clearSessionEverywhere() {
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_BACKUP_KEY);
  } catch (error) {
    console.warn("[SVMS] Local Storage clear failed:", error);
  }

  try {
    const db = await openSessionDB();
    if (db) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(SESSION_DB_STORE, "readwrite");
        tx.objectStore(SESSION_DB_STORE).delete(SESSION_DB_RECORD);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    }
  } catch (error) {
    console.warn("[SVMS] IndexedDB clear failed:", error);
  }

  updateSessionCounts();
}

function saveSession(session) {
  const normalized = Array.isArray(session) ? session : [];
  const payload = JSON.stringify(normalized);

  try {
    localStorage.setItem(SESSION_KEY, payload);
    localStorage.setItem(SESSION_BACKUP_KEY, payload);

    const verify = parseSession(localStorage.getItem(SESSION_KEY));
    if (verify.length !== normalized.length) {
      throw new Error("Local Storage verification failed");
    }
  } catch (error) {
    console.error("[SVMS] Local Storage save failed:", error);
    alert("今日巡店資料無法安全儲存，請先不要關閉頁面。");
  }

  void saveSessionToIndexedDB(normalized);
  updateSessionCounts();
}

async function recoverSessionIfNeeded() {
  const existing = getSession();
  if (existing.length) {
    void saveSessionToIndexedDB(existing);
    return existing;
  }

  const recovered = await loadSessionFromIndexedDB();
  if (!recovered.length) return [];

  try {
    const payload = JSON.stringify(recovered);
    localStorage.setItem(SESSION_KEY, payload);
    localStorage.setItem(SESSION_BACKUP_KEY, payload);
  } catch {}

  console.info(`[SVMS] Recovered ${recovered.length} visit(s) from IndexedDB backup.`);
  return recovered;
}

function updateSessionCounts() {
  const count = getSession().length;
  $("#homeSessionCount").textContent = count;
  $("#sessionCount").textContent = count;
}

function cleanForExport(update) {
  const copy = { ...update };
  delete copy.product_status;
  return Object.fromEntries(Object.entries(copy).filter(([key, value]) => {
    if (value === undefined || value === "") return false;
    if (["display", "distribution", "out_of_stock"].includes(key)) return true;
    if (["optimization", "monster_box", "new_slots"].includes(key)) return true;
    return true;
  }));
}

function renderSession() {
  const session = getSession();
  updateSessionCounts();
  $("#sessionEmpty").hidden = session.length > 0;
  $("#completeSessionButton").disabled = session.length === 0;
  $("#sessionList").innerHTML = session.map(item => `<article class="session-item"><div><h3>${escapeHtml(item.store_name)}</h3><p>${escapeHtml(item.channel)}｜加入時間 ${escapeHtml(formatTime(item.added_at))}</p></div><div class="session-actions"><button type="button" data-edit="${item.id}">修改</button><button type="button" data-delete="${item.id}">刪除</button></div></article>`).join("");

  $$('[data-edit]').forEach(button => button.addEventListener("click", () => {
    const item = getSession().find(entry => entry.id === button.dataset.edit);
    if (!item) return;

    let store = database.stores.find(entry => entry.store_name === item.store_name && (entry.channel === item.original_channel || (item.channel === "CVS" && entry.channel !== "GT")));

    if (!store && item.channel === "CVS") {
      store = {
        channel: item.update.store_type || "",
        store_name: item.update.store_name,
        city: item.update.city || "",
        district: item.update.district || "",
        is_new_cvs: true
      };
    }

    if (store) openUpdate(store, item);
  }));

  $$('[data-delete]').forEach(button => button.addEventListener("click", () => {
    const next = getSession().filter(entry => entry.id !== button.dataset.delete);
    saveSession(next);
    renderSession();
  }));
}

function buildPendingPayload(session) {
  const dates = session.map(item => item.update.visit_date).filter(Boolean).sort();
  const date = dates[0] || localDateISO();
  return {
    schema_version: "3.0",
    batch_id: `${date.replaceAll("-", "")}_mobile`,
    GT: session.filter(item => item.channel === "GT").map(item => cleanForExport(item.update)),
    CVS: session.filter(item => item.channel === "CVS").map(item => cleanForExport(item.update))
  };
}

function downloadJSON(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function initialize() {
  await recoverSessionIfNeeded();

  try {
    const [storeResponse, productResponse] = await Promise.all([
      fetch("data/stores_index.json", { cache: "no-store" }),
      fetch("data/product_catalog.json", { cache: "no-store" })
    ]);

    if (!storeResponse.ok) throw new Error(`stores_index.json HTTP ${storeResponse.status}`);
    if (!productResponse.ok) throw new Error(`product_catalog.json HTTP ${productResponse.status}`);

    database = await storeResponse.json();
    productCatalog = await productResponse.json();

    const generated = database.generated_at ? database.generated_at.replace("T", " ") : "—";
    $("#syncStatus").textContent = `正式索引：${database.store_count || database.stores.length} 家｜更新 ${generated}`;
  } catch (error) {
    $("#syncStatus").textContent = "資料載入失敗";
    alert(error.message);
  }

  updateSessionCounts();
}

$$(".home-action").forEach(button => button.addEventListener("click", () => {
  const titles = { searchView: "查詢店家", sessionView: "今日巡店", settingsView: "設定" };
  showView(button.dataset.view, titles[button.dataset.view]);
}));

$("#backButton").addEventListener("click", () => showView("homeView", "首頁"));
$("#searchButton").addEventListener("click", () => renderMatches(searchStores($("#storeQuery").value.trim())));
$("#storeQuery").addEventListener("keydown", event => {
  if (event.key === "Enter") renderMatches(searchStores(event.target.value.trim()));
});

$("#storeQuery").addEventListener("input", event => {
  const query = event.target.value.trim();
  const matches = query ? searchStores(query, 6) : [];

  $("#suggestions").hidden = !matches.length;
  $("#suggestions").innerHTML = matches.map((store, index) => `<button class="suggestion" data-index="${index}" type="button"><span>${escapeHtml(store.channel === "GT" ? gtDisplayName(store) : store.store_name)}</span><small>${escapeHtml(text(store.channel))}</small></button>`).join("");

  $$(".suggestion").forEach(button => button.addEventListener("click", () => {
    const store = matches[Number(button.dataset.index)];
    $("#storeQuery").value = store.store_name;
    renderStore(store);
  }));
});

$("#cancelUpdateButton").addEventListener("click", () => showView("searchView", "查詢店家"));

$("#visitUpdateForm").addEventListener("submit", event => {
  event.preventDefault();

  const channel = $("#updateChannel").value;
  const update = channel === "GT" ? collectGT() : collectCVS();

  if (!update.visit_date || !update.store_name) {
    return alert("巡店日期與店家名稱不可空白。");
  }

  if (channel === "CVS" && !update.store_type) {
    return alert("新增 CVS 店家時，請選擇門市類別（711／FM／HL／OK）。");
  }

  const session = getSession();
  const editingId = $("#editingSessionId").value;

  const item = {
    id: editingId || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random()}`),
    store_name: update.store_name,
    channel,
    original_channel: currentStore.channel,
    added_at: editingId
      ? (session.find(entry => entry.id === editingId)?.added_at || new Date().toISOString())
      : new Date().toISOString(),
    update
  };

  const next = editingId
    ? session.map(entry => entry.id === editingId ? item : entry)
    : [...session, item];

  saveSession(next);

  alert(editingId ? "今日巡店資料已修改。" : "已加入今日巡店。");
  showView("sessionView", "今日巡店");
});

$("#completeSessionButton").addEventListener("click", async () => {
  const session = getSession();
  if (!session.length) return;

  const confirmed = confirm(
    `確定完成今日巡店？\n\n將產生 pending_updates.json，並清空今日巡店 ${session.length} 間資料。`
  );
  if (!confirmed) return;

  downloadJSON(buildPendingPayload(session), "pending_updates.json");

  await clearSessionEverywhere();

  renderSession();
  alert("pending_updates.json 已產生，今日巡店已清空。");
});

document.addEventListener("click", event => {
  if (!event.target.closest(".search-panel")) $("#suggestions").hidden = true;
});

initialize();
