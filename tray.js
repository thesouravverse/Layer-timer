// Shared "Tray" — an IndexedDB holding area so images move between the
// Layer Timer, One→Many and Bg Remover pages without manual download/upload.
// Each page may define:
//   window.TRAY_IMPORT   = (blob, name) => { ... }   // what "Use here" does
//   window.TRAY_USE_LABEL = "Add as layer"           // label for that button
(function () {
  "use strict";
  const DB_NAME = "ImageFlowTray", STORE = "items", VERSION = 1;

  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(STORE))
          db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function withStore(mode, fn) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, mode);
      const rq = fn(tx.objectStore(STORE));
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }

  const Tray = {
    add(blob, name) { return withStore("readwrite", s => s.add({ name: name || `image-${Date.now()}.png`, blob, ts: Date.now() })).then(id => { updateCount(); return id; }); },
    all() { return withStore("readonly", s => s.getAll()); },
    get(id) { return withStore("readonly", s => s.get(id)); },
    remove(id) { return withStore("readwrite", s => s.delete(id)).then(r => { updateCount(); return r; }); },
    clear() { return withStore("readwrite", s => s.clear()).then(r => { updateCount(); return r; }); },
    count() { return withStore("readonly", s => s.count()); },
    async addCanvas(canvas, name) {
      const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
      return Tray.add(blob, name);
    },
    async update(id, blob, name) {
      const db = await openDB();
      return new Promise((res, rej) => {
        const st = db.transaction(STORE, "readwrite").objectStore(STORE);
        const g = st.get(id);
        g.onsuccess = () => {
          const rec = g.result || { id, ts: Date.now() };
          rec.blob = blob; rec.ts = Date.now();
          if (name) rec.name = name;
          const p = st.put(rec);
          p.onsuccess = () => res(id);
          p.onerror = () => rej(p.error);
        };
        g.onerror = () => rej(g.error);
      });
    },
    async duplicate(id) {
      const it = await Tray.get(id);
      if (!it) return null;
      const copy = it.blob.slice(0, it.blob.size, it.blob.type || "image/png");
      return Tray.add(copy, dupName(it.name));
    },
  };
  window.Tray = Tray;
  function dupName(n) { const m = String(n || "image.png").match(/^(.*?)(\.[^.]+)?$/); return (m[1] || "image") + " copy" + (m[2] || ".png"); }

  // ---------------- UI ----------------
  const css = `
  .tray-panel{position:fixed;top:0;right:0;height:100%;width:340px;max-width:90vw;background:#171a21;border-left:1px solid #2a3040;
    transform:translateX(100%);transition:transform .25s ease;z-index:9999;display:flex;flex-direction:column;box-shadow:-8px 0 30px rgba(0,0,0,.45);
    font-family:system-ui,"Segoe UI",Roboto,sans-serif}
  .tray-panel.open{transform:translateX(0)}
  .tray-head{padding:12px;border-bottom:1px solid #2a3040;display:flex;align-items:center;gap:8px;color:#e6e9ef}
  .tray-head b{font-size:14px}.tray-head .sp{flex:1}
  .tray-x{background:transparent;border:0;color:#8b93a7;font-size:18px;cursor:pointer}
  .tray-actions{display:flex;gap:8px;padding:10px 12px;border-bottom:1px solid #2a3040}
  .tray-actions button{flex:1;background:#1f2430;border:1px solid #2a3040;color:#e6e9ef;border-radius:8px;padding:7px;cursor:pointer;font-size:12px;font-weight:600}
  .tray-actions button:hover{border-color:#5b8cff}
  .tray-list{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:10px}
  .tray-empty{color:#8b93a7;text-align:center;padding:30px 16px;font-size:13px;line-height:1.6}
  .tray-item{background:#1f2430;border:1px solid #2a3040;border-radius:10px;overflow:hidden}
  .tray-item .pv{height:110px;display:flex;align-items:center;justify-content:center;padding:6px;
    background:linear-gradient(45deg,#20242e 25%,transparent 25%,transparent 75%,#20242e 75%),linear-gradient(45deg,#20242e 25%,#171a21 25%,#171a21 75%,#20242e 75%);
    background-size:14px 14px;background-position:0 0,7px 7px}
  .tray-item .pv img{max-width:100%;max-height:100%}
  .tray-item .nm{font-size:11px;color:#8b93a7;padding:5px 8px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tray-item .row{display:flex;gap:4px;padding:6px}
  .tray-item .row button{flex:1;border:1px solid #2a3040;background:#0f1115;color:#e6e9ef;border-radius:6px;padding:6px;font-size:11px;font-weight:600;cursor:pointer}
  .tray-item .row button:hover{border-color:#5b8cff}
  .tray-item .row button.use{flex:2;background:#5b8cff;border-color:#5b8cff;color:#fff}
  .tray-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9998;display:none}
  .tray-backdrop.open{display:block}
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  let panel, listEl, backdrop, countEl, lightbox;
  const selected = new Set();
  let draggingId = null;

  const overrideCss = `
  .tray-panel{width:360px}
  .tray-actions{padding:10px 12px 6px}
  .tray-sel{display:flex;align-items:center;gap:8px;padding:0 12px 10px;border-bottom:1px solid #2a3040;color:#8b93a7;font-size:12px}
  .tray-sel label{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
  .tray-sel .sp{flex:1}
  .tray-sel button{background:#1f2430;border:1px solid #2a3040;color:#e6e9ef;border-radius:7px;padding:6px 10px;cursor:pointer;font-size:14px}
  .tray-sel button:hover{border-color:#5b8cff}
  .tray-hint{padding:6px 12px;color:#8b93a7;font-size:11px}
  .tray-item{cursor:grab}
  .tray-item.sel{border-color:#5b8cff;box-shadow:0 0 0 1px #5b8cff inset}
  .tray-item:active{cursor:grabbing}
  .tray-item .pvwrap{position:relative}
  .tray-item .pv{min-height:150px}
  .tray-item .pv img{max-height:240px;object-fit:contain}
  .tray-item .cb{position:absolute;top:6px;left:6px;width:18px;height:18px;cursor:pointer;z-index:2}
  .tray-item .zoom{position:absolute;top:6px;right:6px;background:rgba(15,17,21,.75);border:1px solid #2a3040;color:#e6e9ef;border-radius:6px;font-size:12px;padding:2px 7px;cursor:pointer;z-index:2}
  .tray-item .row{flex-wrap:wrap}
  .tray-item .row button{min-width:52px}
  .tray-item .row button.use{flex-basis:100%;background:#5b8cff;border-color:#5b8cff;color:#fff}
  .tray-light{position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:10000;display:none;align-items:center;justify-content:center;padding:24px;
    background-image:linear-gradient(45deg,#1a1d24 25%,transparent 25%,transparent 75%,#1a1d24 75%),linear-gradient(45deg,#1a1d24 25%,#0b0d11 25%,#0b0d11 75%,#1a1d24 75%);background-size:24px 24px;background-position:0 0,12px 12px}
  .tray-light.open{display:flex}
  .tray-light img{max-width:96%;max-height:96%;object-fit:contain}
  `;

  function buildUI() {
    const st2 = document.createElement("style"); st2.textContent = overrideCss; document.head.appendChild(st2);

    backdrop = document.createElement("div");
    backdrop.className = "tray-backdrop";
    backdrop.addEventListener("click", close);
    document.body.appendChild(backdrop);

    panel = document.createElement("div");
    panel.className = "tray-panel";
    panel.innerHTML = `
      <div class="tray-head"><b>🗂 Tray</b><span class="sp"></span><button class="tray-x" title="Close">✕</button></div>
      <div class="tray-actions">
        <button data-a="refresh">Refresh</button>
        <button data-a="clear">Clear all</button>
      </div>
      <div class="tray-sel">
        <label><input type="checkbox" data-a="selall" /> Select</label>
        <span class="sp"></span>
        <button data-a="dl" title="Download selected">⤓</button>
        <button data-a="dup" title="Duplicate selected">⧉</button>
        <button data-a="del" title="Delete selected">🗑</button>
      </div>
      <div class="tray-hint">Tip: drag any item onto the page to use it here.</div>
      <div class="tray-list"></div>`;
    document.body.appendChild(panel);
    listEl = panel.querySelector(".tray-list");

    lightbox = document.createElement("div");
    lightbox.className = "tray-light";
    lightbox.innerHTML = `<img alt="" />`;
    lightbox.addEventListener("click", () => lightbox.classList.remove("open"));
    document.body.appendChild(lightbox);

    panel.querySelector(".tray-x").addEventListener("click", close);
    panel.querySelector('[data-a="refresh"]').addEventListener("click", refresh);
    panel.querySelector('[data-a="clear"]').addEventListener("click", async () => { if (confirm("Clear the whole tray?")) { selected.clear(); await Tray.clear(); refresh(); } });
    panel.querySelector('[data-a="selall"]').addEventListener("change", async e => {
      const items = await Tray.all();
      if (e.target.checked) items.forEach(it => selected.add(it.id)); else selected.clear();
      refresh();
    });
    panel.querySelector('[data-a="dl"]').addEventListener("click", downloadSelected);
    panel.querySelector('[data-a="dup"]').addEventListener("click", duplicateSelected);
    panel.querySelector('[data-a="del"]').addEventListener("click", deleteSelected);

    // page-wide drag & drop import
    document.addEventListener("dragover", e => {
      if (draggingId == null) return;
      if (e.target.closest && e.target.closest(".tray-panel")) return;
      e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    document.addEventListener("drop", async e => {
      if (draggingId == null) return;
      if (e.target.closest && e.target.closest(".tray-panel")) { draggingId = null; return; }
      e.preventDefault();
      const id = draggingId; draggingId = null;
      const it = await Tray.get(id);
      if (it && typeof window.TRAY_IMPORT === "function") { window.TRAY_IMPORT(it.blob, it.name, it.id); close(); }
    });
  }

  function open() { panel.classList.add("open"); backdrop.classList.add("open"); refresh(); }
  function close() { panel.classList.remove("open"); backdrop.classList.remove("open"); }

  async function refresh() {
    const items = (await Tray.all()).sort((a, b) => b.ts - a.ts);
    const present = new Set(items.map(i => i.id));
    [...selected].forEach(id => { if (!present.has(id)) selected.delete(id); });
    if (countEl) countEl.textContent = items.length;
    const selAll = panel.querySelector('[data-a="selall"]');
    if (selAll) selAll.checked = items.length > 0 && selected.size === items.length;
    listEl.innerHTML = "";
    if (!items.length) {
      listEl.innerHTML = `<div class="tray-empty">Tray is empty.<br>Send images here from any page,<br>then use them on another page.</div>`;
      return;
    }
    const canUse = typeof window.TRAY_IMPORT === "function";
    items.forEach(it => {
      const url = URL.createObjectURL(it.blob);
      const div = document.createElement("div");
      div.className = "tray-item" + (selected.has(it.id) ? " sel" : "");
      div.draggable = true;
      div.innerHTML = `
        <div class="pvwrap">
          <input type="checkbox" class="cb" ${selected.has(it.id) ? "checked" : ""} />
          <button class="zoom" title="Enlarge">⤢</button>
          <div class="pv"><img src="${url}" /></div>
        </div>
        <div class="nm">${escapeHtml(it.name)}</div>
        <div class="row">
          ${canUse ? `<button class="use">${escapeHtml(window.TRAY_USE_LABEL || "Use here")}</button>` : ""}
          <button class="dl">⤓ Save</button>
          <button class="dup">⧉ Copy</button>
          <button class="rm">✕</button>
        </div>`;
      div.addEventListener("dragstart", e => { draggingId = it.id; if (e.dataTransfer) { e.dataTransfer.effectAllowed = "copy"; e.dataTransfer.setData("text/plain", it.name); } });
      div.addEventListener("dragend", () => { draggingId = null; });
      div.querySelector(".cb").addEventListener("change", e => {
        if (e.target.checked) selected.add(it.id); else selected.delete(it.id);
        div.classList.toggle("sel", e.target.checked);
        if (selAll) selAll.checked = selected.size === items.length;
      });
      div.querySelector(".zoom").addEventListener("click", () => { lightbox.querySelector("img").src = url; lightbox.classList.add("open"); });
      div.querySelector(".dl").addEventListener("click", () => downloadItem(it, url));
      div.querySelector(".dup").addEventListener("click", async () => { await Tray.duplicate(it.id); refresh(); });
      div.querySelector(".rm").addEventListener("click", async () => { selected.delete(it.id); await Tray.remove(it.id); refresh(); });
      const useBtn = div.querySelector(".use");
      if (useBtn) useBtn.addEventListener("click", () => window.TRAY_IMPORT(it.blob, it.name, it.id));
      listEl.appendChild(div);
    });
  }

  function downloadItem(it, url) { const a = document.createElement("a"); a.href = url || URL.createObjectURL(it.blob); a.download = it.name; a.click(); }
  async function selectedItems() { const items = await Tray.all(); return items.filter(i => selected.has(i.id)); }
  async function downloadSelected() {
    const items = await selectedItems();
    if (!items.length) { alert("Tick some items first (the checkbox on each)."); return; }
    for (const it of items) { downloadItem(it); await new Promise(r => setTimeout(r, 250)); }
  }
  async function duplicateSelected() {
    const items = await selectedItems();
    if (!items.length) { alert("Tick some items first (the checkbox on each)."); return; }
    for (const it of items) await Tray.duplicate(it.id);
    refresh();
  }
  async function deleteSelected() {
    const items = await selectedItems();
    if (!items.length) { alert("Tick some items first (the checkbox on each)."); return; }
    if (!confirm(`Delete ${items.length} selected item(s)?`)) return;
    for (const it of items) await Tray.remove(it.id);
    selected.clear(); refresh();
  }

  async function updateCount() { try { if (countEl) countEl.textContent = await Tray.count(); } catch (e) {} }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  window.TrayUI = { open, close, refresh };

  document.addEventListener("DOMContentLoaded", () => {
    buildUI();
    const btn = document.getElementById("trayBtn");
    countEl = document.getElementById("trayCount");
    if (btn) btn.addEventListener("click", open);
    updateCount();
  });
})();
