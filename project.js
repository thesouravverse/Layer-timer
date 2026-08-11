// Shared project persistence for Layer Timer Studio.
// - Autosaves each page's editable state in IndexedDB.
// - Keeps state intact while navigating between the three pages.
// - Exports/imports a portable, human-readable .json file including all image Blobs and Tray items.
(function () {
  "use strict";

  const DB_NAME = "LayerTimerStudioProject";
  const STORE = "pages";
  const VERSION = 1;
  const FORMAT = "LayerTimerStudioProject";
  const FORMAT_VERSION = 1;
  const NAME_KEY = "layerTimerStudio.projectName";

  let registration = null;
  let ready = false;
  let restoring = false;
  let dirty = false;
  let saveTimer = null;
  let saving = null;
  let saveAgain = false;
  let ui = {};

  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function transaction(mode, work) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      try { result = work(store, tx); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Project database transaction aborted"));
    });
  }

  async function getPage(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function getAllPages() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  function putPage(id, state) {
    return transaction("readwrite", store => store.put({ id, state, updatedAt: Date.now() }));
  }

  function replacePages(records) {
    return transaction("readwrite", store => {
      store.clear();
      records.forEach(record => store.put(record));
    });
  }

  function clearPages() {
    return transaction("readwrite", store => store.clear());
  }

  function setStatus(message, kind) {
    if (ui.status) {
      ui.status.textContent = message;
      ui.status.dataset.kind = kind || "";
    }
    if (ui.button) {
      ui.button.title = message;
      ui.button.classList.toggle("project-saving", kind === "working");
      ui.button.classList.toggle("project-error", kind === "error");
    }
  }

  async function register(id, hooks) {
    registration = { id, serialize: hooks.serialize, restore: hooks.restore };
    ready = false;
    restoring = true;
    setStatus("Restoring autosaved work…", "working");
    try {
      const record = await getPage(id);
      if (record && record.state && typeof hooks.restore === "function") await hooks.restore(record.state);
      ready = true;
      dirty = false;
      setStatus(record ? "Autosaved work restored" : "Autosave ready", "ok");
    } catch (error) {
      console.error("Project restore failed", error);
      ready = true;
      setStatus("Could not restore this page: " + error.message, "error");
    } finally {
      restoring = false;
    }
  }

  function markDirty() {
    if (!ready || restoring || !registration) return;
    dirty = true;
    setStatus("Unsaved changes…", "working");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow(), 450);
  }

  async function saveNow(force) {
    if (!registration || !ready || restoring) return;
    if (!dirty && !force) return;
    if (saving) {
      saveAgain = true;
      return saving;
    }
    clearTimeout(saveTimer);
    saving = (async () => {
      try {
        setStatus("Autosaving…", "working");
        const state = await registration.serialize();
        await putPage(registration.id, state);
        dirty = false;
        setStatus("All work autosaved", "ok");
      } catch (error) {
        console.error("Project autosave failed", error);
        setStatus(error && error.name === "QuotaExceededError"
          ? "Storage full — save a project file, then remove unused images"
          : "Autosave failed: " + (error.message || error), "error");
      } finally {
        saving = null;
        if (saveAgain) {
          saveAgain = false;
          dirty = true;
          saveNow();
        }
      }
    })();
    return saving;
  }

  async function encodeValue(value) {
    if (value instanceof Blob) {
      return { __layerProjectType: "Blob", type: value.type || "application/octet-stream", data: arrayBufferToBase64(await value.arrayBuffer()) };
    }
    if (value instanceof Set) return { __layerProjectType: "Set", values: await Promise.all([...value].map(encodeValue)) };
    if (Array.isArray(value)) return Promise.all(value.map(encodeValue));
    if (value && typeof value === "object") {
      const output = {};
      for (const [key, item] of Object.entries(value)) output[key] = await encodeValue(item);
      return output;
    }
    return value;
  }

  async function decodeValue(value) {
    if (Array.isArray(value)) return Promise.all(value.map(decodeValue));
    if (value && typeof value === "object") {
      if (value.__layerProjectType === "Blob") return new Blob([base64ToArrayBuffer(value.data)], { type: value.type });
      if (value.__layerProjectType === "Set") return new Set(await Promise.all((value.values || []).map(decodeValue)));
      const output = {};
      for (const [key, item] of Object.entries(value)) output[key] = await decodeValue(item);
      return output;
    }
    return value;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  async function exportProject() {
    await saveNow(true);
    setStatus("Packing project file…", "working");
    try {
      const name = projectName();
      const payload = {
        format: FORMAT,
        version: FORMAT_VERSION,
        name,
        description: "Layer Timer Studio project. Page settings are readable JSON; embedded images use Base64 so this single file remains portable.",
        imageEncoding: "Base64",
        exportedAt: new Date().toISOString(),
        pages: await getAllPages(),
        tray: window.Tray ? await window.Tray.all() : [],
      };
      const encoded = await encodeValue(payload);
      const blob = new Blob([JSON.stringify(encoded, null, 2) + "\n"], { type: "application/json" });
      const anchor = document.createElement("a");
      anchor.href = URL.createObjectURL(blob);
      anchor.download = sanitizeFilename(name) + ".json";
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      setTimeout(() => { URL.revokeObjectURL(anchor.href); anchor.remove(); }, 5000);
      setStatus("Project JSON saved", "ok");
    } catch (error) {
      console.error("Project export failed", error);
      setStatus("Project export failed: " + (error.message || error), "error");
      alert("Could not save project file: " + (error.message || error));
    }
  }

  async function importProject(file) {
    setStatus("Opening project file…", "working");
    try {
      const parsed = JSON.parse(await file.text());
      const payload = await decodeValue(parsed);
      if (!payload || payload.format !== FORMAT || payload.version !== FORMAT_VERSION) throw new Error("This is not a supported Layer Timer project file");
      if (!confirm("Open this project? Current autosaved work and Tray items will be replaced.")) {
        setStatus("Open cancelled", "ok");
        return;
      }
      await replacePages(payload.pages || []);
      if (window.Tray && window.Tray.replaceAll) await window.Tray.replaceAll(payload.tray || []);
      setProjectName(payload.name || file.name.replace(/\.(?:layerproject|json)$/i, ""));
      location.reload();
    } catch (error) {
      console.error("Project import failed", error);
      setStatus("Could not open project: " + (error.message || error), "error");
      alert("Could not open project: " + (error.message || error));
    }
  }

  async function newProject() {
    if (!confirm("Start a new project? This clears autosaved page work and the shared Tray.")) return;
    await clearPages();
    if (window.Tray) await window.Tray.clear();
    setProjectName("Untitled Layer Project");
    location.reload();
  }

  function projectName() {
    return (ui.name && ui.name.value.trim()) || localStorage.getItem(NAME_KEY) || "Untitled Layer Project";
  }

  function setProjectName(name) {
    const clean = String(name || "Untitled Layer Project").trim() || "Untitled Layer Project";
    localStorage.setItem(NAME_KEY, clean);
    if (ui.name) ui.name.value = clean;
  }

  function sanitizeFilename(name) {
    return String(name || "layer-project").replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "layer-project";
  }

  function buildUI() {
    const style = document.createElement("style");
    style.textContent = `
      .project-button.project-saving::after{content:"";width:7px;height:7px;border-radius:50%;background:#f0b34a;display:inline-block}
      .project-button.project-error::after{content:"!";color:#ff5d6c;font-weight:900}
      .project-new-button{color:#ff9aa3!important}
      .project-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:11000;display:none;align-items:center;justify-content:center;padding:16px}
      .project-backdrop.open{display:flex}
      .project-dialog{width:min(440px,94vw);background:#171a21;color:#e6e9ef;border:1px solid #2a3040;border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.6);font-family:system-ui,"Segoe UI",sans-serif;overflow:hidden}
      .project-head{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid #2a3040}.project-head b{flex:1}.project-close{border:0;background:transparent;color:#8b93a7;font-size:20px;cursor:pointer}
      .project-body{padding:16px;display:grid;gap:12px}.project-body label{font-size:11px;color:#8b93a7;text-transform:uppercase;font-weight:700;letter-spacing:.5px}
      .project-name{width:100%;margin-top:5px;padding:10px 11px;background:#0f1115;color:#e6e9ef;border:1px solid #2a3040;border-radius:8px;font-size:14px}
      .project-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.project-grid button{min-height:44px;border:1px solid #2a3040;background:#1f2430;color:#e6e9ef;border-radius:9px;font-weight:700;cursor:pointer}.project-grid button:hover{border-color:#5b8cff}.project-grid .project-save{background:#5b8cff;border-color:#5b8cff;color:#fff}.project-grid .project-new{color:#ff8a94}
      .project-note{font-size:12px;line-height:1.5;color:#8b93a7}.project-status{padding:9px 11px;border-radius:8px;background:#0f1115;color:#8b93a7;font-size:12px}.project-status[data-kind="error"]{color:#ff8a94}.project-status[data-kind="ok"]{color:#2ec3a6}
      @media(max-width:600px){.project-grid{grid-template-columns:1fr}.project-dialog{max-height:90vh;overflow:auto}}
    `;
    document.head.appendChild(style);

    const button = document.createElement("button");
    button.className = "btn project-button";
    button.type = "button";
    button.textContent = "💾 Project";
    const nav = document.querySelector(".topnav") || document.querySelector("header");
    nav.appendChild(button);

    const newButton = document.createElement("button");
    newButton.className = "btn project-new-button";
    newButton.type = "button";
    newButton.textContent = "＋ New";
    newButton.title = "Start a new project";
    newButton.addEventListener("click", newProject);
    nav.appendChild(newButton);

    const backdrop = document.createElement("div");
    backdrop.className = "project-backdrop";
    backdrop.innerHTML = `
      <div class="project-dialog" role="dialog" aria-modal="true" aria-label="Project">
        <div class="project-head"><b>💾 Layer Timer Project</b><button class="project-close" type="button">×</button></div>
        <div class="project-body">
          <label>Project name<input class="project-name" type="text" maxlength="80"></label>
          <div class="project-grid">
            <button class="project-save" type="button">Save project JSON</button>
            <button class="project-open" type="button">Open project JSON</button>
            <button class="project-save-now" type="button">Autosave now</button>
            <button class="project-new" type="button">New project</button>
          </div>
          <div class="project-note">Autosave preserves each page while you switch between Layer Timer, One → Many, and Bg Remover. The readable <b>.json</b> project also includes all Tray and image data. Image bytes appear as Base64 text because JSON cannot store binary data directly.</div>
          <div class="project-status">Preparing autosave…</div>
          <input class="project-file" type="file" accept=".json,.layerproject,application/json" hidden>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    ui = {
      button,
      backdrop,
      name: backdrop.querySelector(".project-name"),
      status: backdrop.querySelector(".project-status"),
      file: backdrop.querySelector(".project-file"),
    };
    ui.name.value = localStorage.getItem(NAME_KEY) || "Untitled Layer Project";
    ui.name.addEventListener("change", () => setProjectName(ui.name.value));
    button.addEventListener("click", () => backdrop.classList.add("open"));
    backdrop.querySelector(".project-close").addEventListener("click", () => backdrop.classList.remove("open"));
    backdrop.addEventListener("click", event => { if (event.target === backdrop) backdrop.classList.remove("open"); });
    backdrop.querySelector(".project-save").addEventListener("click", exportProject);
    backdrop.querySelector(".project-open").addEventListener("click", () => ui.file.click());
    backdrop.querySelector(".project-save-now").addEventListener("click", () => saveNow(true));
    backdrop.querySelector(".project-new").addEventListener("click", newProject);
    ui.file.addEventListener("change", async () => {
      const file = ui.file.files[0];
      ui.file.value = "";
      if (file) await importProject(file);
    });
    setStatus("Autosave preparing…", "working");
  }

  function attachGlobalAutosave() {
    ["input", "change", "pointerup"].forEach(type => document.addEventListener(type, event => {
      if (event.target && event.target.closest && event.target.closest(".project-dialog")) return;
      markDirty();
    }, true));

    document.addEventListener("click", async event => {
      const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
      if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || anchor.target === "_blank") return;
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin && location.protocol !== "file:") return;
      if (!registration || !ready) return;
      event.preventDefault();
      await saveNow(true);
      location.href = anchor.href;
    }, true);

    document.addEventListener("click", event => {
      if (event.target && event.target.closest && event.target.closest(".project-dialog")) return;
      markDirty();
    }, true);

    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveNow(true); });
    window.addEventListener("pagehide", () => saveNow(true));
    setInterval(() => { if (dirty) saveNow(); }, 3000);
  }

  const API = {
    register,
    markDirty,
    saveNow,
    exportProject,
    importProject,
    newProject,
    get ready() { return ready; },
  };
  window.ProjectStore = API;

  function init() {
    buildUI();
    attachGlobalAutosave();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
