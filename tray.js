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
    remove(id) { return withStore("readwrite", s => s.delete(id)).then(r => { updateCount(); return r; }); },
    clear() { return withStore("readwrite", s => s.clear()).then(r => { updateCount(); return r; }); },
    count() { return withStore("readonly", s => s.count()); },
    async addCanvas(canvas, name) {
      const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
      return Tray.add(blob, name);
    },
  };
  window.Tray = Tray;

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

  let panel, listEl, backdrop, countEl;

  function buildUI() {
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
      <div class="tray-list"></div>`;
    document.body.appendChild(panel);
    listEl = panel.querySelector(".tray-list");
    panel.querySelector(".tray-x").addEventListener("click", close);
    panel.querySelector('[data-a="refresh"]').addEventListener("click", refresh);
    panel.querySelector('[data-a="clear"]').addEventListener("click", async () => {
      if (confirm("Clear the whole tray?")) { await Tray.clear(); refresh(); }
    });
  }

  function open() { panel.classList.add("open"); backdrop.classList.add("open"); refresh(); }
  function close() { panel.classList.remove("open"); backdrop.classList.remove("open"); }

  async function refresh() {
    const items = (await Tray.all()).sort((a, b) => b.ts - a.ts);
    if (countEl) countEl.textContent = items.length;
    listEl.innerHTML = "";
    if (!items.length) {
      listEl.innerHTML = `<div class="tray-empty">Tray is empty.<br>Send images here from any page,<br>then use them on another page.</div>`;
      return;
    }
    items.forEach(it => {
      const url = URL.createObjectURL(it.blob);
      const div = document.createElement("div");
      div.className = "tray-item";
      const canUse = typeof window.TRAY_IMPORT === "function";
      div.innerHTML = `
        <div class="pv"><img src="${url}"></div>
        <div class="nm">${escapeHtml(it.name)}</div>
        <div class="row">
          ${canUse ? `<button class="use">${escapeHtml(window.TRAY_USE_LABEL || "Use here")}</button>` : ""}
          <button class="dl" title="Download">⤓</button>
          <button class="rm" title="Remove">✕</button>
        </div>`;
      div.querySelector(".dl").addEventListener("click", () => {
        const a = document.createElement("a"); a.href = url; a.download = it.name; a.click();
      });
      div.querySelector(".rm").addEventListener("click", async () => { await Tray.remove(it.id); refresh(); });
      const useBtn = div.querySelector(".use");
      if (useBtn) useBtn.addEventListener("click", () => window.TRAY_IMPORT(it.blob, it.name));
      listEl.appendChild(div);
    });
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
