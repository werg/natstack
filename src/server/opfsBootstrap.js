/**
 * OPFS Bootstrap — Populates Origin Private File System from context template.
 *
 * This script runs in the browser (injected into panel HTML or the /__init__ page).
 * It reads configuration from `globalThis.__opfsBootstrapConfig`, which the server
 * injects as a preceding <script> block.
 *
 * Config shape:
 *   { contextId, specHash, gitBaseUrl, gitToken, isInitPage }
 *
 * Flow:
 * 1. Check IndexedDB for ".template-initialized" marker
 * 2. If not initialized, fetch template spec from /api/context/template
 * 3. For each entry, fetch repo file listing from git server
 * 4. Clone files to OPFS in parallel (up to 6 concurrent fetches)
 * 5. Write initialization marker to IndexedDB
 * 6. Signal completion to extension (if running as init page)
 */
(function() {
  "use strict";

  var CONFIG = globalThis.__opfsBootstrapConfig;
  if (!CONFIG || !CONFIG.specHash) {
    // No template — nothing to bootstrap. Handle init page signaling.
    if (CONFIG && CONFIG.isInitPage) {
      var msg = document.getElementById("message");
      var spinner = document.getElementById("spinner");
      if (msg) { msg.textContent = "No template — context ready."; msg.className = "done"; }
      if (spinner) spinner.style.display = "none";
      try {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: "contextInitComplete", contextId: CONFIG.contextId, status: "skipped" });
        }
      } catch(e) { /* extension not available */ }
    }
    return;
  }

  var CONTEXT_ID = CONFIG.contextId;
  var SPEC_HASH = CONFIG.specHash;
  var GIT_BASE = CONFIG.gitBaseUrl;
  var GIT_TOKEN = CONFIG.gitToken;
  var IS_INIT_PAGE = CONFIG.isInitPage;
  var DB_NAME = "__natstack_context";
  var STORE_NAME = "markers";
  var MARKER_KEY = "template-initialized";
  var FETCH_CONCURRENCY = 6;

  function updateStatus(msg, isDone, isError) {
    if (!IS_INIT_PAGE) return;
    var el = document.getElementById("message");
    var spinner = document.getElementById("spinner");
    if (el) { el.textContent = msg; if (isDone) el.className = "done"; if (isError) el.className = "error"; }
    if (spinner && (isDone || isError)) spinner.style.display = "none";
  }

  function signalComplete(status, error) {
    if (!IS_INIT_PAGE) return;
    // Signal to extension via runtime message
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: "contextInitComplete", contextId: CONTEXT_ID, status: status, error: error || null });
      }
    } catch(e) { /* extension not available */ }
    // Also post to opener (for iframe-based pre-warming)
    try {
      if (window.opener) window.opener.postMessage({ type: "contextInitComplete", contextId: CONTEXT_ID, status: status }, "*");
    } catch(e) {}
  }

  // Open or create IndexedDB for marker storage
  function openDB() {
    return new Promise(function(resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function(e) { e.target.result.createObjectStore(STORE_NAME); };
      req.onsuccess = function(e) { resolve(e.target.result); };
      req.onerror = function(e) { reject(e.target.error); };
    });
  }

  // Check if context is already initialized
  function checkMarker(db) {
    return new Promise(function(resolve) {
      var tx = db.transaction(STORE_NAME, "readonly");
      var store = tx.objectStore(STORE_NAME);
      var req = store.get(MARKER_KEY);
      req.onsuccess = function() { resolve(req.result || null); };
      req.onerror = function() { resolve(null); };
    });
  }

  // Write initialization marker
  function writeMarker(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(STORE_NAME, "readwrite");
      var store = tx.objectStore(STORE_NAME);
      store.put({ specHash: SPEC_HASH, initializedAt: Date.now() }, MARKER_KEY);
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function(e) { reject(e.target.error); };
    });
  }

  // Create a directory in OPFS (recursive)
  async function ensureDir(root, pathParts) {
    var current = root;
    for (var i = 0; i < pathParts.length; i++) {
      current = await current.getDirectoryHandle(pathParts[i], { create: true });
    }
    return current;
  }

  // Write a file to OPFS
  async function writeFile(root, filePath, content) {
    var parts = filePath.split("/").filter(Boolean);
    var fileName = parts.pop();
    var dir = await ensureDir(root, parts);
    var fileHandle = await dir.getFileHandle(fileName, { create: true });
    var writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  // Fetch a file from the git server
  async function fetchGitFile(repo, commit, filePath) {
    var url = GIT_BASE + "/" + repo + "/raw/" + commit + "/" + encodeURIComponent(filePath);
    var resp = await fetch(url, { headers: { "Authorization": "Bearer " + GIT_TOKEN } });
    if (!resp.ok) throw new Error("Git fetch failed: " + resp.status + " " + url);
    return resp;
  }

  // Fetch directory listing from git server
  async function fetchGitTree(repo, commit, dirPath) {
    var url = GIT_BASE + "/" + repo + "/tree/" + commit;
    if (dirPath) url += "/" + encodeURIComponent(dirPath);
    var resp = await fetch(url, { headers: { "Authorization": "Bearer " + GIT_TOKEN } });
    if (!resp.ok) return [];
    return resp.json();
  }

  /**
   * Run async functions in parallel with a concurrency limit.
   * JS is single-threaded so idx++ is safe across await boundaries.
   */
  async function parallelForEach(items, fn, concurrency) {
    var idx = 0;
    async function worker() {
      while (idx < items.length) {
        var i = idx++;
        await fn(items[i], i);
      }
    }
    var workers = [];
    for (var w = 0; w < Math.min(concurrency, items.length); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);
  }

  // Recursively clone a repo subtree into OPFS (parallel file fetches)
  async function cloneToOpfs(root, targetPath, repo, commit) {
    var targetParts = targetPath.split("/").filter(Boolean);
    var targetDir = await ensureDir(root, targetParts);

    var entries = await fetchGitTree(repo, commit, "");
    if (!Array.isArray(entries)) return;

    var blobs = entries.filter(function(e) { return e.type === "blob"; });

    await parallelForEach(blobs, async function(entry, i) {
      updateStatus("Cloning: " + repo + " (" + (i + 1) + "/" + blobs.length + ")...");
      var resp = await fetchGitFile(repo, commit, entry.path);
      var blob = await resp.blob();
      await writeFile(targetDir, entry.path, blob);
    }, FETCH_CONCURRENCY);
  }

  // Main bootstrap logic
  async function bootstrap() {
    try {
      var db = await openDB();
      var marker = await checkMarker(db);

      // Already initialized with matching spec hash — skip
      if (marker && marker.specHash === SPEC_HASH) {
        updateStatus("Context already initialized.", true);
        signalComplete("already-initialized");
        globalThis.__natstackContextReady = true;
        return;
      }

      updateStatus("Fetching template spec...");

      // Fetch template spec from server
      var specResp = await fetch("/api/context/template", { credentials: "include" });
      var spec = await specResp.json();

      if (!spec.hasTemplate || !spec.structure) {
        updateStatus("No template structure — context ready.", true);
        signalComplete("no-template");
        globalThis.__natstackContextReady = true;
        return;
      }

      // Get OPFS root
      var opfsRoot = await navigator.storage.getDirectory();

      // Clone each entry in the template structure
      var paths = Object.keys(spec.structure);
      for (var i = 0; i < paths.length; i++) {
        var targetPath = paths[i];
        var entry = spec.structure[targetPath];
        updateStatus("Cloning " + (i + 1) + "/" + paths.length + ": " + entry.repo + "...");
        await cloneToOpfs(opfsRoot, targetPath, entry.repo, entry.commit);
      }

      // Write marker
      await writeMarker(db);

      updateStatus("Context initialized (" + paths.length + " repos cloned).", true);
      signalComplete("initialized");
      globalThis.__natstackContextReady = true;

    } catch (err) {
      console.error("[NatStack OPFS Bootstrap] Error:", err);
      updateStatus("Bootstrap error: " + err.message, false, true);
      signalComplete("error", err.message);
      // Don't block panel load on bootstrap failure
      globalThis.__natstackContextReady = true;
    }
  }

  // Fire and forget — don't block panel rendering
  globalThis.__natstackContextBootstrap = bootstrap();
})();
