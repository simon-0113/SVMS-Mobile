"use strict";

let database = null;
let productCatalog = null;
let currentStore = null;

const SESSION_KEY = "svms_mobile_today_session_v2";
const SESSION_BACKUP_KEY = "svms_mobile_today_session_v2_backup";
const SESSION_DB_NAME = "svms_mobile_session_backup";
const SESSION_DB_STORE = "session";
const SESSION_DB_RECORD = "today_session";

const SVMS_USER_NAME_KEY = "svms_mobile_user_name_v1";
const SVMS_UPLOAD_ENDPOINT = "https://svms-team-upload.t0926400467.workers.dev/";

const PHOTO_DB_STORE = "photos";
const PHOTO_MAX_EDGE = 1600;
const PHOTO_JPEG_QUALITY = 0.76;

let currentPhotoDraft = [];
let currentPhotoOriginalIds = new Set();
let currentPhotoPreviewUrls = [];

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const text = (value, fallback = "—") => value === null || value === undefined || value === "" ? fallback : String(value);
const escapeHtml = value => text(value, "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function getSvmsUserName() {
  return (localStorage.getItem(SVMS_USER_NAME_KEY) || "").trim();
}

function saveSvmsUserName(name) {
  localStorage.setItem(SVMS_USER_NAME_KEY, String(name || "").trim());
}

function safeFilePart(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 40);
}

function localTimestampForFile() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function uploadTeamPending(payload) {
  const userName = getSvmsUserName();

  if (!userName) {
    alert("請先到「設定」輸入個人名稱並儲存。");
    showView("settingsView", "使用者設定");
    return false;
  }

  if (!SVMS_UPLOAD_ENDPOINT || SVMS_UPLOAD_ENDPOINT.includes("PASTE_YOUR_WORKER_URL")) {
    alert("尚未設定 Dropbox 上傳服務網址。");
    return false;
  }

  const fileName = `${safeFilePart(userName)}_${localTimestampForFile()}.json`;
  const uploadPayload = {
    ...payload,
    user_name: userName,
    batch_id: `${localDateISO().replaceAll("-", "")}_${safeFilePart(userName)}_mobile`,
    uploaded_at: new Date().toISOString()
  };

  try {
    const response = await fetch(SVMS_UPLOAD_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_name: fileName,
        payload: uploadPayload
      })
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.ok) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }

    return {
      ok: true,
      file_name: result.file_name || fileName,
      path: result.path || ""
    };
  } catch (error) {
    console.error("[SVMS] Dropbox upload failed:", error);
    alert(`上傳失敗：${error.message}\n今日巡店資料仍保留，可稍後重試或使用下載更新檔。`);
    return false;
  }
}


function photoId() {
  return crypto.randomUUID ? crypto.randomUUID() : `photo_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function photoSectionHTML() {
  return `
    <div class="form-section">
      <h3>現場照片</h3>
      <div style="padding:12px;border:1px solid #e2e6ec;border-radius:12px;background:#fafbfc;">
        <input id="visitPhotoInput" type="file" accept="image/*" multiple hidden>
        <button id="visitPhotoButton" type="button" class="update-launch">📷 拍照 / 選擇照片</button>
        <p class="form-help" style="margin-top:8px;">照片會先在手機端自動壓縮並保存於今日巡店；完成今日巡店時才統一上傳 Dropbox。</p>
        <div id="visitPhotoStatus" class="form-help">尚未加入照片。</div>
        <div id="visitPhotoPreview" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:10px;"></div>
      </div>
    </div>`;
}

function revokePhotoPreviewUrls() {
  currentPhotoPreviewUrls.forEach(url => {
    try { URL.revokeObjectURL(url); } catch {}
  });
  currentPhotoPreviewUrls = [];
}

async function getPhotoRecord(id) {
  try {
    const db = await openSessionDB();
    if (!db) return null;
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTO_DB_STORE, "readonly");
      const req = tx.objectStore(PHOTO_DB_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return record;
  } catch (error) {
    console.warn("[SVMS] Photo read failed:", error);
    return null;
  }
}

async function putPhotoRecord(record) {
  const db = await openSessionDB();
  if (!db) throw new Error("此瀏覽器不支援照片暫存。");
  await new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_DB_STORE, "readwrite");
    tx.objectStore(PHOTO_DB_STORE).put(record, record.id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

async function deletePhotoRecord(id) {
  try {
    const db = await openSessionDB();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTO_DB_STORE, "readwrite");
      tx.objectStore(PHOTO_DB_STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  } catch (error) {
    console.warn("[SVMS] Photo delete failed:", error);
  }
}

function imageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("無法讀取此照片格式"));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("照片壓縮失敗")), type, quality);
  });
}

async function compressPhoto(file) {
  let source;
  let width;
  let height;

  try {
    if ("createImageBitmap" in window) {
      source = await createImageBitmap(file);
      width = source.width;
      height = source.height;
    } else {
      source = await imageFromBlob(file);
      width = source.naturalWidth || source.width;
      height = source.naturalHeight || source.height;
    }
  } catch {
    if (file.size <= 5 * 1024 * 1024 && file.type.startsWith("image/")) {
      return new Blob([await file.arrayBuffer()], { type: file.type || "image/jpeg" });
    }
    throw new Error(`無法處理照片：${file.name || "未命名照片"}`);
  }

  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.drawImage(source, 0, 0, targetWidth, targetHeight);
  if (typeof source.close === "function") source.close();

  let blob = await canvasToBlob(canvas, "image/jpeg", PHOTO_JPEG_QUALITY);
  if (blob.size > 1200 * 1024) {
    blob = await canvasToBlob(canvas, "image/jpeg", 0.64);
  }
  return blob;
}

async function renderPhotoDraft() {
  const host = $("#visitPhotoPreview");
  const status = $("#visitPhotoStatus");
  if (!host || !status) return;

  revokePhotoPreviewUrls();
  host.innerHTML = "";
  status.textContent = currentPhotoDraft.length
    ? `已加入 ${currentPhotoDraft.length} 張照片。`
    : "尚未加入照片。";

  for (const meta of currentPhotoDraft) {
    const record = await getPhotoRecord(meta.id);
    if (!record?.blob) continue;

    const url = URL.createObjectURL(record.blob);
    currentPhotoPreviewUrls.push(url);

    const card = document.createElement("div");
    card.style.cssText = "position:relative;border:1px solid #e2e6ec;border-radius:10px;overflow:hidden;background:#fff;";
    card.innerHTML = `
      <img src="${url}" alt="巡店照片" style="width:100%;height:150px;object-fit:cover;display:block;">
      <div style="padding:8px;">
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:5px;">照片備註</label>
        <input type="text" data-photo-note="${escapeHtml(meta.id)}" maxlength="50"
          placeholder="選填，例如：更換煙架後陳列"
          value="${escapeHtml(meta.note || "")}"
          style="width:100%;box-sizing:border-box;margin-bottom:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
          <small>${Math.max(1, Math.round((record.blob.size || 0) / 1024))} KB</small>
          <button type="button" data-remove-photo="${escapeHtml(meta.id)}">刪除</button>
        </div>
      </div>`;
    host.appendChild(card);
  }

  $$("[data-photo-note]").forEach(input => {
    input.addEventListener("input", () => {
      const meta = currentPhotoDraft.find(item => item.id === input.dataset.photoNote);
      if (meta) meta.note = input.value.slice(0, 50);
    });
  });

  $$("[data-remove-photo]").forEach(button => {
    button.addEventListener("click", async () => {
      const id = button.dataset.removePhoto;
      currentPhotoDraft = currentPhotoDraft.filter(item => item.id !== id);
      await renderPhotoDraft();
    });
  });
}

async function addSelectedPhotos(fileList) {
  const files = [...(fileList || [])].filter(file => file?.type?.startsWith("image/"));
  if (!files.length) return;

  const button = $("#visitPhotoButton");
  const originalText = button?.textContent || "📷 拍照 / 選擇照片";
  if (button) {
    button.disabled = true;
    button.textContent = "照片處理中...";
  }

  try {
    for (const file of files) {
      const blob = await compressPhoto(file);
      const id = photoId();
      const capturedAt = new Date().toISOString();
      const meta = {
        id,
        captured_at: capturedAt,
        size: blob.size,
        type: "image/jpeg",
        note: ""
      };
      await putPhotoRecord({
        ...meta,
        blob,
        original_name: file.name || ""
      });
      currentPhotoDraft.push(meta);
    }
    await renderPhotoDraft();
  } catch (error) {
    console.error("[SVMS] Photo processing failed:", error);
    alert(`照片處理失敗：${error.message}`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
    const input = $("#visitPhotoInput");
    if (input) input.value = "";
  }
}

function bindPhotoControls() {
  const button = $("#visitPhotoButton");
  const input = $("#visitPhotoInput");
  if (!button || !input) return;

  button.addEventListener("click", () => input.click());
  input.addEventListener("change", () => void addSelectedPhotos(input.files));
}

async function preparePhotoDraft(sessionItem = null) {
  revokePhotoPreviewUrls();
  currentPhotoDraft = Array.isArray(sessionItem?.photos)
    ? sessionItem.photos.map(item => ({ ...item }))
    : [];
  currentPhotoOriginalIds = new Set(currentPhotoDraft.map(item => item.id));
  bindPhotoControls();
  await renderPhotoDraft();
}

async function cleanupUncommittedPhotoDraft() {
  const newIds = currentPhotoDraft
    .map(item => item.id)
    .filter(id => !currentPhotoOriginalIds.has(id));
  await Promise.all(newIds.map(deletePhotoRecord));
  currentPhotoDraft = [];
  currentPhotoOriginalIds = new Set();
  revokePhotoPreviewUrls();
}

async function uploadVisitPhoto(userName, sessionItem, photoMeta) {
  const record = await getPhotoRecord(photoMeta.id);
  if (!record?.blob) throw new Error(`${sessionItem.store_name} 有照片暫存遺失`);

  const formData = new FormData();
  formData.append("user_name", userName);
  formData.append("store_name", sessionItem.update?.store_name || sessionItem.store_name || "");
  formData.append("visit_date", sessionItem.update?.visit_date || localDateISO());
  formData.append("captured_at", photoMeta.captured_at || new Date().toISOString());
  formData.append("photo_note", photoMeta.note || "");
  formData.append("photo", record.blob, `${photoMeta.id}.jpg`);

  const response = await fetch(SVMS_UPLOAD_ENDPOINT, {
    method: "POST",
    body: formData
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.error || `照片 HTTP ${response.status}`);
  }
  return result;
}

function allSessionPhotos(session) {
  return session.flatMap(item =>
    (Array.isArray(item.photos) ? item.photos : []).map(photo => ({
      item,
      photo
    }))
  );
}

async function uploadAllSessionPhotos(session, userName, onProgress = null) {
  const entries = allSessionPhotos(session);
  let done = 0;
  for (const entry of entries) {
    await uploadVisitPhoto(userName, entry.item, entry.photo);
    done += 1;
    if (onProgress) onProgress(done, entries.length);
  }
  return entries.length;
}

async function deleteAllSessionPhotoRecords(session) {
  const ids = allSessionPhotos(session).map(entry => entry.photo.id);
  await Promise.all(ids.map(deletePhotoRecord));
}

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u16(value) {
  return new Uint8Array([value & 255, (value >>> 8) & 255]);
}

function u32(value) {
  return new Uint8Array([
    value & 255,
    (value >>> 8) & 255,
    (value >>> 16) & 255,
    (value >>> 24) & 255
  ]);
}

function concatBytes(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function dosDateTime(dateValue = new Date()) {
  const d = new Date(dateValue);
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31);
  const date = (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

function makeStoreZip(files) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const crc = crc32(data);
    const dt = dosDateTime(file.date || new Date());

    const local = concatBytes([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dt.time), u16(dt.date),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0),
      nameBytes, data
    ]);
    locals.push(local);

    const central = concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(dt.time), u16(dt.date),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0),
      u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes
    ]);
    centrals.push(central);
    offset += local.length;
  }

  const centralBytes = concatBytes(centrals);
  const end = concatBytes([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralBytes.length), u32(offset), u16(0)
  ]);
  return new Blob([...locals, centralBytes, end], { type: "application/zip" });
}

function photoBackupFileName(item, photo, index) {
  const date = safeFilePart(item.update?.visit_date || localDateISO()).replaceAll("_", "-");
  const store = safeFilePart(item.update?.store_name || item.store_name || "store");
  const captured = new Date(photo.captured_at || Date.now());
  const p = n => String(n).padStart(2, "0");
  const stamp = Number.isNaN(captured.getTime())
    ? String(index + 1).padStart(3, "0")
    : `${p(captured.getHours())}${p(captured.getMinutes())}${p(captured.getSeconds())}`;
  const note = safeFilePart(photo.note || "").replace(/^_+|_+$/g, "");
  return `${date}__${store}__${stamp}${note ? `_${note}` : ""}.jpg`;
}

async function downloadSessionBackupZip(session, userName) {
  const payload = {
    ...buildPendingPayload(session),
    user_name: userName,
    batch_id: `${localDateISO().replaceAll("-", "")}_${safeFilePart(userName)}_mobile`,
    uploaded_at: new Date().toISOString()
  };

  const encoder = new TextEncoder();
  const files = [{
    name: "pending_updates.json",
    data: encoder.encode(JSON.stringify(payload, null, 2))
  }];

  let photoIndex = 0;
  for (const item of session) {
    for (const photo of (item.photos || [])) {
      const record = await getPhotoRecord(photo.id);
      if (!record?.blob) continue;
      files.push({
        name: `photos/${photoBackupFileName(item, photo, photoIndex)}`,
        data: new Uint8Array(await record.blob.arrayBuffer()),
        date: photo.captured_at || new Date()
      });
      photoIndex += 1;
    }
  }

  const zip = makeStoreZip(files);
  const url = URL.createObjectURL(zip);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFilePart(userName)}_${localDateISO().replaceAll("-", "")}_今日巡店.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

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

  if (id === "settingsView") {
    const host = $("#settingsView");
    if (host) {
      const currentName = getSvmsUserName();
      host.innerHTML = `
        <div class="card">
          <h2>使用者設定</h2>
          <div class="form-field full">
            <label for="svmsUserName">個人名稱</label>
            <input id="svmsUserName" type="text" maxlength="40" placeholder="例如：Eric" value="${escapeHtml(currentName)}">
          </div>
          <button id="saveSvmsUserNameButton" class="update-launch" type="button">儲存</button>
          <p class="form-help">只需設定一次，之後上傳巡店更新會自動帶入此名稱。</p>
        </div>`;

      $("#saveSvmsUserNameButton").addEventListener("click", () => {
        const name = $("#svmsUserName").value.trim();
        if (!name) return alert("請輸入個人名稱。");
        saveSvmsUserName(name);
        alert(`已儲存使用者名稱：${name}`);
      });
    }
  }

  if (id === "searchView") {
    setTimeout(() => {
      const storeQuery = $("#storeQuery");
      if (storeQuery) storeQuery.focus();
    }, 50);
  }
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
  return history.slice(0, 5).map(item => `<div class="history-item"><div class="history-date">${escapeHtml(text(item["巡店日期"]))}</div><div class="history-detail">${[["配合度", item["配合度"]], ["銷售", item["銷售"]], ["備註", item["備註"]]].filter(([, v]) => v).map(([k, v]) => `${escapeHtml(k)}：${escapeHtml(v)}`).join("<br>") || "—"}</div></div>`).join("");
}


function gtDisplayName(store) {
  const distributor = text(store?.distributor, "").trim();
  return distributor ? `${store.store_name}（${distributor}）` : store.store_name;
}

function renderGT(store) {
  return `<article class="card"><div class="card-head"><h2>${escapeHtml(gtDisplayName(store))}</h2><div class="meta">GT｜${escapeHtml(text(store.city))} ${escapeHtml(text(store.district))}</div></div>
    <section class="section"><h3>GT查核資料</h3><div class="info-grid">${info("經銷商", store.distributor)}${info("經銷商業務", store.distributor_salesperson)}${info("地址", store.address, true)}${info("合作等級", store.audit_cooperation)}${info("簽約型態", store.contract_type)}${info("簽約格數", store.contract_slots)}${info("陳列獎金", store.display_bonus)}<div class="info full"><span class="label">查核陳列</span>${pills(store.audit_display)}</div><div class="info full"><span class="label">查核分布</span>${pills(store.audit_distribution)}</div></div></section>
    <section class="section"><h3>GT巡店資料</h3><div class="info-grid">${info("最近巡店日期", store.visit_date)}${info("配合度", store.visit_cooperation)}${info("客群", store.visit_customer_group)}${info("銷售", store.visit_sales)}${info("備註", store.visit_note, true)}</div></section>
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

function productStatusTable(saved = {}, savedOsdOriginal = {}) {
  const groups = productCatalog?.groups || [];
  const standalone = productCatalog?.standalone || [];
  const rows = products => products.map(product => {
    const status = saved[product] || "";
    const osdOriginal = savedOsdOriginal[product] || "";
    const originVisible = status === "out_of_stock";
    return `<div class="product-row" data-product="${escapeHtml(product)}"><div class="product-name">${escapeHtml(product)}</div>${["display", "distribution", "out_of_stock"].map(value => `<label class="status-cell"><input type="checkbox" name="product_${escapeHtml(product)}" value="${value}" ${status === value ? "checked" : ""}><span>${value === "display" ? "陳列" : value === "distribution" ? "分布" : "缺貨"}</span></label>`).join("")}<div class="osd-origin" ${originVisible ? "" : "hidden"} style="grid-column:1/-1;margin:6px 0 10px;padding:8px 10px;border:1px solid #e2e6ec;border-radius:10px;background:#fafbfc;"><span style="margin-right:12px;font-weight:600;">缺貨原屬：</span><label style="margin-right:14px;"><input type="radio" name="osd_origin_${escapeHtml(product)}" value="display" ${osdOriginal === "display" ? "checked" : ""}> 原屬陳列</label><label><input type="radio" name="osd_origin_${escapeHtml(product)}" value="distribution" ${osdOriginal === "distribution" ? "checked" : ""}> 原屬分布</label></div></div>`;
  }).join("");
  return `
    <p class="product-status-help">每個品項只能選擇一種狀態；選擇「缺貨」時，必須再指定原屬陳列或原屬分布。</p>
    <div class="product-status">
      <div class="product-row product-header"><div>品項</div><div>陳列</div><div>分布</div><div>缺貨</div></div>
      ${groups.map(group => `<div class="series-title">${escapeHtml(group.series)}</div>${rows(group.products)}`).join("")}
      ${standalone.length ? `<div class="series-title">其他</div>${rows(standalone)}` : ""}
    </div>
    <div class="product-status-summary" id="productStatusSummary">
      <span class="summary-title">已選品項統計</span>
      <span class="summary-separator">|</span>
      <span class="summary-item summary-display">陳列：<strong id="displayCount">0</strong></span>
      <span class="summary-separator">|</span>
      <span class="summary-item summary-distribution">分布：<strong id="distributionCount">0</strong></span>
      <span class="summary-separator">|</span>
      <span class="summary-item summary-out">缺貨：<strong id="outOfStockCount">0</strong></span>
    </div>`;
}

function updateProductStatusSummary() {
  let displayCount = 0;
  let distributionCount = 0;
  let outOfStockCount = 0;

  $$(".product-row[data-product]").forEach(row => {
    const checked = row.querySelector('.status-cell input[type="checkbox"]:checked');
    if (!checked) return;
    if (checked.value === "display") displayCount += 1;
    if (checked.value === "distribution") distributionCount += 1;
    if (checked.value === "out_of_stock") outOfStockCount += 1;
  });

  const displayHost = $("#displayCount");
  const distributionHost = $("#distributionCount");
  const outHost = $("#outOfStockCount");

  if (displayHost) displayHost.textContent = displayCount;
  if (distributionHost) distributionHost.textContent = distributionCount;
  if (outHost) outHost.textContent = outOfStockCount;
}

function bindProductStatusControls() {
  $$(".product-row[data-product]").forEach(row => {
    const controls = [...row.querySelectorAll('.status-cell input[type="checkbox"]')];
    const originBox = row.querySelector(".osd-origin");
    const originRadios = [...row.querySelectorAll('.osd-origin input[type="radio"]')];
    const syncOrigin = () => {
      const osd = controls.find(control => control.value === "out_of_stock");
      const show = !!osd?.checked;
      if (originBox) originBox.hidden = !show;
      if (!show) originRadios.forEach(radio => { radio.checked = false; });
    };
    controls.forEach(control => control.addEventListener("change", () => {
      if (control.checked) controls.forEach(other => { if (other !== control) other.checked = false; });
      syncOrigin();
      updateProductStatusSummary();
    }));
    syncOrigin();
  });

  updateProductStatusSummary();
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
    <div class="form-section"><h3>現場品項狀況</h3>${productStatusTable(saved.product_status || {}, saved.osd_original_type || {})}</div>
    <div class="form-section"><h3>本次異動</h3><div class="form-grid">${selectHTML("optimization", "本次完成優化", [{ value: "false", label: "否" }, { value: "true", label: "是" }], saved.optimization ? "true" : "false")}${fieldHTML("new_slots", "新增格數", String(saved.new_slots ?? 0), "number")}${selectHTML("monster_box", "怪獸盒", [{ value: "false", label: "無" }, { value: "true", label: "有" }], saved.monster_box ? "true" : "false")}${selectHTML("annual_contract", "年度合約", ["", "續約", "無意願續約", "新增格數簽約", "牌面好無產值", "不建議續約"], saved.annual_contract || "")}${textareaHTML("optimization_content", "優化調整內容", saved.optimization_content || "")}${textareaHTML("note", "備註", saved.note || "")}</div></div>${photoSectionHTML()}`;
}

function cvsForm(store, saved = {}) {
  return `<div class="form-section"><h3>門市資料</h3><div class="form-grid">${fieldHTML("visit_date", "巡店日期", saved.visit_date || localDateISO(), "date")}${fieldHTML("store_name", "門市名稱", saved.store_name || store.store_name)}${selectHTML("store_type", "門市類別", ["", "711", "FM", "HL", "OK"], saved.store_type || store.channel || "")}${fieldHTML("city", "縣市", saved.city || store.city || "")}${fieldHTML("district", "行政區", saved.district || store.district || "")}${selectHTML("cooperation", "配合度", ["", "高", "中", "低", "待觀察"], saved.cooperation || "")}${selectHTML("line_oa", "LINE OA", [{ value: "", label: "—" }, { value: "true", label: "有" }, { value: "false", label: "無" }], saved.line_oa === true ? "true" : saved.line_oa === false ? "false" : "")}${selectHTML("small_rack", "小煙架", [{ value: "", label: "—" }, { value: "true", label: "有" }, { value: "false", label: "無" }], saved.small_rack === true ? "true" : saved.small_rack === false ? "false" : "")}${fieldHTML("customer_group", "客群", saved.customer_group || "")}${fieldHTML("sales", "銷售資料", saved.sales || "")}${fieldHTML("sales_grade", "銷售等級", saved.sales_grade || "")}${fieldHTML("activity", "活動", saved.activity || "")}${textareaHTML("note", "備註", saved.note || "")}</div></div>${photoSectionHTML()}`;
}

async function openUpdate(store, sessionItem = null) {
  await cleanupUncommittedPhotoDraft();
  currentStore = store;
  const channel = store.channel === "GT" ? "GT" : "CVS";
  $("#updateChannel").value = channel;
  $("#editingSessionId").value = sessionItem?.id || "";
  $("#updateStoreTitle").textContent = store.is_new_cvs ? "新增 CVS 店家｜巡店更新" : `${store.store_name}｜巡店更新`;
  $("#updateFields").innerHTML = channel === "GT" ? gtForm(store, sessionItem?.update || {}) : cvsForm(store, sessionItem?.update || {});
  if (channel === "GT") bindProductStatusControls();
  showView("updateView", sessionItem ? "修改巡店" : (store.is_new_cvs ? "新增 CVS 店家" : "巡店更新"));
  await preparePhotoDraft(sessionItem);
}

function boolOrUndefined(value) {
  return value === "" ? undefined : value === "true";
}

function collectGT() {
  const productStatus = {};
  const osdOriginalType = {};
  const missingOsdOrigin = [];
  $$(".product-row[data-product]").forEach(row => {
    const checked = row.querySelector('.status-cell input[type="checkbox"]:checked');
    if (checked) {
      productStatus[row.dataset.product] = checked.value;
      if (checked.value === "out_of_stock") {
        const origin = row.querySelector('.osd-origin input[type="radio"]:checked');
        if (origin) osdOriginalType[row.dataset.product] = origin.value;
        else missingOsdOrigin.push(row.dataset.product);
      }
    }
  });
  if (missingOsdOrigin.length) {
    alert(`以下缺貨品項尚未指定「原屬陳列／原屬分布」：\n${missingOsdOrigin.join("、")}`);
    throw new Error("OSD_ORIGINAL_TYPE_REQUIRED");
  }
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
    osd_original_type: osdOriginalType,
    product_status: productStatus,
    cooperation: $("#cooperation").value,
    line_oa: boolOrUndefined($("#line_oa").value),
    customer_group: $("#customer_group").value.trim(),
    sales: $("#sales").value.trim(),
    optimization_content: $("#optimization_content").value.trim(),
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

    const request = indexedDB.open(SESSION_DB_NAME, 2);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_DB_STORE)) {
        db.createObjectStore(SESSION_DB_STORE);
      }
      if (!db.objectStoreNames.contains(PHOTO_DB_STORE)) {
        db.createObjectStore(PHOTO_DB_STORE);
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

  const completeButton = $("#completeSessionButton");
  completeButton.disabled = session.length === 0;
  completeButton.textContent = "完成巡店・上傳到 Dropbox";

  let downloadButton = $("#downloadPendingBackupButton");
  if (!downloadButton) {
    downloadButton = document.createElement("button");
    downloadButton.id = "downloadPendingBackupButton";
    downloadButton.type = "button";
    downloadButton.className = completeButton.className;
    downloadButton.textContent = "下載更新檔案";
    completeButton.insertAdjacentElement("afterend", downloadButton);

    downloadButton.addEventListener("click", () => {
      const currentSession = getSession();
      if (!currentSession.length) return;

      const userName = getSvmsUserName();
      if (!userName) {
        alert("請先到「設定」輸入個人名稱並儲存。");
        showView("settingsView", "使用者設定");
        return;
      }

      const confirmed = confirm(
        `確定下載本次巡店更新檔？\n\n使用者：${userName}\n巡店：${currentSession.length} 間\n\n備註：若無法正常上傳 Dropbox，請將下載的更新檔案交給系統管理者處理。\n\n下載後不會清空今日巡店資料。`
      );
      if (!confirmed) return;

      downloadSessionBackupZip(currentSession, userName)
        .then(() => {
          alert("備援 ZIP 已下載。\n內含 pending_updates.json 與巡店照片。\n請將 ZIP 交給系統管理者處理。\n今日巡店資料仍保留。");
        })
        .catch(error => {
          console.error("[SVMS] Backup ZIP failed:", error);
          alert(`備援檔下載失敗：${error.message}`);
        });
    });
  }

  downloadButton.disabled = session.length === 0;
  downloadButton.textContent = "下載更新檔案";

  $("#sessionList").innerHTML = session.map(item => `<article class="session-item"><div><h3>${escapeHtml(item.store_name)}</h3><p>${escapeHtml(item.channel)}｜加入時間 ${escapeHtml(formatTime(item.added_at))}${item.photos?.length ? `｜照片 ${item.photos.length} 張` : ""}</p></div><div class="session-actions"><button type="button" data-edit="${item.id}">修改</button><button type="button" data-delete="${item.id}">刪除</button></div></article>`).join("");

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
    const item = getSession().find(entry => entry.id === button.dataset.delete);
    if (!item) return;

    const confirmed = confirm(
      `確定要刪除這筆今日巡店資料？\n\n店家：${item.store_name}\n\n刪除後將無法從今日巡店中復原。`
    );
    if (!confirmed) return;

    const next = getSession().filter(entry => entry.id !== button.dataset.delete);
    saveSession(next);
    void deleteAllSessionPhotoRecords([item]);
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
  const titles = { searchView: "查詢店家", sessionView: "今日巡店", settingsView: "使用者設定" };
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

$("#cancelUpdateButton").addEventListener("click", async () => {
  await cleanupUncommittedPhotoDraft();
  showView("searchView", "查詢店家");
});

function sameSessionStore(entry, update, channel) {
  if (!entry || !update) return false;
  if (entry.channel !== channel) return false;
  if ((entry.update?.visit_date || "") !== (update.visit_date || "")) return false;

  const entryName = entry.update?.store_name || entry.store_name || "";
  const updateName = update.store_name || "";

  if (channel === "GT") {
    return normalize(entryName) === normalize(updateName);
  }

  const entryType = (entry.update?.store_type || entry.original_channel || "").toUpperCase();
  const updateType = (update.store_type || "").toUpperCase();

  return normalize(entryName) === normalize(updateName)
    && (!entryType || !updateType || entryType === updateType);
}

$("#visitUpdateForm").addEventListener("submit", async event => {
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
    photos: currentPhotoDraft.map(photo => ({ ...photo })),
    update
  };

  let next;
  let duplicateReplaced = false;

  if (editingId) {
    next = session.map(entry => entry.id === editingId ? item : entry);
  } else {
    const duplicateIndex = session.findIndex(entry => sameSessionStore(entry, update, channel));

    if (duplicateIndex >= 0) {
      const existing = session[duplicateIndex];
      const confirmed = confirm(
        `今日巡店已有此店家資料。\n\n店家：${update.store_name}\n日期：${update.visit_date}\n\n是否以本次內容更新原資料？`
      );
      if (!confirmed) return;

      const mergedPhotos = [
        ...(Array.isArray(existing.photos) ? existing.photos : []),
        ...item.photos
      ].filter((photo, index, all) => all.findIndex(other => other.id === photo.id) === index);

      const replacement = {
        ...item,
        id: existing.id,
        added_at: existing.added_at || item.added_at,
        photos: mergedPhotos,
        updated_at: new Date().toISOString()
      };

      next = session.map((entry, index) => index === duplicateIndex ? replacement : entry);
      duplicateReplaced = true;
    } else {
      next = [...session, item];
    }
  }

  saveSession(next);

  if (editingId) {
    const keptIds = new Set(item.photos.map(photo => photo.id));
    const removedIds = [...currentPhotoOriginalIds].filter(id => !keptIds.has(id));
    void Promise.all(removedIds.map(deletePhotoRecord));
  }

  currentPhotoDraft = [];
  currentPhotoOriginalIds = new Set();
  revokePhotoPreviewUrls();

  // SVMS_CLEAR_SEARCH_AFTER_VISIT_V1
  // 完成巡店後清空上一間店，回到查詢頁時可直接輸入下一間。
  const storeQuery = $("#storeQuery");
  if (storeQuery) storeQuery.value = "";

  const results = $("#results");
  if (results) {
    results.innerHTML = "";
    results.hidden = true;
  }

  const suggestions = $("#suggestions");
  if (suggestions) {
    suggestions.innerHTML = "";
    suggestions.hidden = true;
  }

  const emptyState = $("#emptyState");
  if (emptyState) emptyState.hidden = false;

  currentStore = null;

  alert(
    editingId
      ? "今日巡店資料已修改。"
      : duplicateReplaced
        ? "已更新今日巡店原有店家資料。"
        : "已加入今日巡店。"
  );
  showView("homeView", "首頁");
});

$("#completeSessionButton").addEventListener("click", async () => {
  const session = getSession();
  if (!session.length) return;

  const userName = getSvmsUserName();
  if (!userName) {
    alert("請先到「設定」輸入個人名稱並儲存。");
    showView("settingsView", "使用者設定");
    return;
  }

  const totalPhotos = allSessionPhotos(session).length;
  const confirmed = confirm(
    `確定完成巡店並上傳到 Dropbox？\n\n使用者：${userName}\n巡店：${session.length} 間\n照片：${totalPhotos} 張\n\n巡店資料與照片全部確認上傳成功後，才會清空今日巡店資料。`
  );
  if (!confirmed) return;

  const button = $("#completeSessionButton");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "準備上傳...";

  try {
    const photoEntries = allSessionPhotos(session);

    if (photoEntries.length) {
      await uploadAllSessionPhotos(session, userName, (done, total) => {
        button.textContent = `照片上傳 ${done}/${total}...`;
      });
    }

    button.textContent = "巡店資料上傳中...";
    const jsonResult = await uploadTeamPending(buildPendingPayload(session));

    if (!jsonResult) {
      button.disabled = false;
      button.textContent = originalText || "完成巡店・上傳到 Dropbox";
      return;
    }

    await deleteAllSessionPhotoRecords(session);
    await clearSessionEverywhere();
    renderSession();

    alert(
      `Dropbox 上傳成功。\n巡店資料：1 份\n照片：${photoEntries.length} 張\n\n今日巡店資料已清空。`
    );
  } catch (error) {
    console.error("[SVMS] Combined upload failed:", error);
    alert(
      `上傳未完成：${error.message}\n\n今日巡店資料與照片仍保留。\n可重新上傳，或使用「下載更新檔案」取得備援 ZIP 交給系統管理者。`
    );
    button.disabled = false;
    button.textContent = originalText || "完成巡店・上傳到 Dropbox";
  }
});

document.addEventListener("click", event => {
  if (!event.target.closest(".search-panel")) $("#suggestions").hidden = true;
});

initialize();
