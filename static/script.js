// ══════════════════════════════════════════════════
// State
// ══════════════════════════════════════════════════
let currentData         = null;
let selectedVideoFormat = null;
let selectedAudioFormat = null;
let playlistData        = [];
let skippedIndices      = new Set();
let othersAnalyzedData  = null;
let fetchedUrl          = "";
let currentMode         = null;    // 'youtube' | 'others' | 'torrent' | 'torrent_file' | null
let dlTabMode           = "video"; // active tab inside download modal
let queuePollInterval   = null;
const selectedSessions  = new Set();
let urlCache            = {};      // { [url]: { mode, infoData?, formatsData?, othersData? } }
let cachedDownloads     = [];      // updated every 2s by queue poll
let pendingTorrentFile  = null;    // File object awaiting upload confirmation

// ══════════════════════════════════════════════════
// DOM refs — page chrome
// ══════════════════════════════════════════════════
const globalUrlInput         = document.getElementById("globalUrlInput");
const globalDownloadBtn      = document.getElementById("globalDownloadBtn");
const globalTorrentFileInput = document.getElementById("globalTorrentFileInput");
const partitionSelect        = document.getElementById("partitionSelect");
const savePartitionBtn       = document.getElementById("savePartitionBtn");
const afriwayPathPreview     = document.getElementById("afriwayPathPreview");

// DOM refs — download modal
const downloadModal      = document.getElementById("downloadModal");
const dlModalTitle       = document.getElementById("dlModalTitle");
const dlModalMeta        = document.getElementById("dlModalMeta");
const dlYoutubeContent   = document.getElementById("dlYoutubeContent");
const dlTorrentContent   = document.getElementById("dlTorrentContent");
const dlOthersContent    = document.getElementById("dlOthersContent");
const dlVideoFormatList  = document.getElementById("dlVideoFormatList");
const dlAudioFormatListV = document.getElementById("dlAudioFormatListV");
const dlAudioFormatListA = document.getElementById("dlAudioFormatListA");
const dlPlaylistSection  = document.getElementById("dlPlaylistSection");
const dlPlaylistVideos   = document.getElementById("dlPlaylistVideos");
const dlSelectedCount    = document.getElementById("dlSelectedCount");
const dlTorrentInfo      = document.getElementById("dlTorrentInfo");
const dlOthersInfo       = document.getElementById("dlOthersInfo");
const dlConfirmBtn       = document.getElementById("dlConfirmBtn");
const dlRefreshBtn       = document.getElementById("dlRefreshBtn");

// ══════════════════════════════════════════════════
// Settings Modal
// ══════════════════════════════════════════════════
function openSettings() {
  document.getElementById("settingsModal").classList.remove("hidden");
}

function closeSettings() {
  document.getElementById("settingsModal").classList.add("hidden");
}

document.getElementById("settingsBtn").addEventListener("click", openSettings);

// ══════════════════════════════════════════════════
// Download Modal
// ══════════════════════════════════════════════════
function openDownloadModal(mode) {
  dlYoutubeContent.classList.add("hidden");
  dlTorrentContent.classList.add("hidden");
  dlOthersContent.classList.add("hidden");
  if (mode === "youtube")                        dlYoutubeContent.classList.remove("hidden");
  if (mode === "torrent" || mode === "torrent_file") dlTorrentContent.classList.remove("hidden");
  if (mode === "others")                         dlOthersContent.classList.remove("hidden");
  downloadModal.classList.remove("hidden");
}

function closeDownloadModal() {
  downloadModal.classList.add("hidden");
  setLoading(globalDownloadBtn, false);
}

dlConfirmBtn.addEventListener("click", confirmDownload);

function confirmDownload() {
  if      (currentMode === "youtube")       startDownload();
  else if (currentMode === "others")        startOthersDownload();
  else if (currentMode === "torrent")       startTorrentDownloadConfirmed();
  else if (currentMode === "torrent_file")  startTorrentFileDownload();
}

// Refresh button — clear cache and re-fetch
function refreshDownloadModal() {
  const url = globalUrlInput.value.trim();
  if (!url) return;
  delete urlCache[url];
  if      (currentMode === "youtube") fetchVideoInfo();
  else if (currentMode === "others")  analyzeOthersUrl();
  else    { closeDownloadModal(); handleGlobalDownload(); }
}

if (dlRefreshBtn) dlRefreshBtn.addEventListener("click", refreshDownloadModal);

// Restore previously cached data into modal without re-fetching
function restoreFromCache(url) {
  const cached = urlCache[url];
  if (!cached) return false;

  if (cached.mode === "youtube") {
    fetchedUrl  = url;
    currentData = { ...cached.infoData, ...cached.formatsData };
    skippedIndices.clear();

    dlModalTitle.textContent = cached.infoData.title || "Video";
    dlModalMeta.innerHTML    = cached.infoData.is_playlist
      ? `<span class="badge">${cached.infoData.video_count || "?"} videos</span>`
      : `<span class="type-badge type-badge--youtube">YouTube</span>`;

    setDlTab("video");
    displayFormats(cached.formatsData);
    dlConfirmBtn.disabled = false;

    if (cached.infoData.is_playlist && cached.infoData.videos) {
      playlistData = cached.infoData.videos;
      displayPlaylistVideos(cached.infoData.videos);
      dlPlaylistSection.classList.remove("hidden");
    } else {
      dlPlaylistSection.classList.add("hidden");
    }

    openDownloadModal("youtube");
    return true;
  }

  if (cached.mode === "others") {
    othersAnalyzedData = cached.othersData;
    const data = cached.othersData;

    dlModalTitle.textContent = data.title || data.filename || "File Download";
    dlModalMeta.innerHTML    = `<span class="type-badge type-badge--${data.type || "direct"}">${data.type || "direct"}</span>`;

    let rows = "";
    if (data.filename) rows += buildInfoRow("📄 File", data.filename);
    if (data.size)     rows += buildInfoRow("📊 Size", data.size);
    rows += buildInfoRow("🏷️ Type", data.type || "direct file");
    dlOthersInfo.innerHTML = rows;

    dlConfirmBtn.disabled = false;
    openDownloadModal("others");
    return true;
  }

  return false;
}

// Tab switcher inside YouTube modal
function setDlTab(mode) {
  dlTabMode = mode;
  const isVideo = mode === "video";

  document.getElementById("tabVideoAudio").classList.toggle("dl-tab--active",  isVideo);
  document.getElementById("tabAudioOnly").classList.toggle("dl-tab--active",  !isVideo);
  document.getElementById("dlVideoPane").classList.toggle("hidden", !isVideo);
  document.getElementById("dlAudioPane").classList.toggle("hidden",  isVideo);

  if (!isVideo) {
    const selectedV = dlAudioFormatListV.querySelector(".format-item.selected");
    if (selectedV) {
      const fid = selectedV.dataset.formatId;
      dlAudioFormatListA.querySelectorAll(".format-item").forEach(el => {
        el.classList.toggle("selected", el.dataset.formatId === fid);
      });
    }
  }
}

// Escape closes whichever modal is open
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { closeSettings(); closeDownloadModal(); }
});

// ══════════════════════════════════════════════════
// Download location — partition selector
// ══════════════════════════════════════════════════
async function loadDrives() {
  try {
    const res  = await fetch("/api/drives");
    const data = await res.json();
    if (!partitionSelect) return;
    partitionSelect.innerHTML = "";
    for (const d of data.drives) {
      const opt = document.createElement("option");
      opt.value = d.partition;
      opt.textContent = d.is_system ? `${d.partition} (System)` : d.partition;
      opt.dataset.path = d.afriway_path;
      partitionSelect.appendChild(opt);
    }
    await loadPartition();
  } catch (_) {}
}

async function loadPartition() {
  try {
    const res  = await fetch("/api/get-partition");
    const data = await res.json();
    if (partitionSelect && data.partition) partitionSelect.value = data.partition;
    if (afriwayPathPreview) afriwayPathPreview.textContent = data.path || "";
  } catch (_) {}
}

function updatePathPreview() {
  const opt = partitionSelect && partitionSelect.selectedOptions[0];
  if (opt && afriwayPathPreview) afriwayPathPreview.textContent = opt.dataset.path || "";
}

if (partitionSelect) partitionSelect.addEventListener("change", updatePathPreview);

if (savePartitionBtn) {
  savePartitionBtn.addEventListener("click", async () => {
    const partition = partitionSelect && partitionSelect.value;
    if (!partition) return;
    try {
      const res  = await fetch("/api/set-partition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partition })
      });
      const data = await res.json();
      if (data.success) {
        if (afriwayPathPreview) afriwayPathPreview.textContent = data.path || "";
        showSuccess("Download location updated!");
      } else {
        showError(data.error || "Failed to set partition");
      }
    } catch (e) { showError(e.message); }
  });
}

// ══════════════════════════════════════════════════
// Queue polling
// ══════════════════════════════════════════════════
function startQueuePolling() {
  if (queuePollInterval) return;
  queuePollInterval = setInterval(refreshAllQueues, 2000);
}

async function refreshAllQueues() {
  try {
    const res = await fetch("/api/downloads");
    if (!res.ok) return;
    const downloads = await res.json();
    cachedDownloads = downloads;
    renderQueue("queue-all", downloads);
  } catch (_) {}
}

function renderQueue(queueId, downloads) {
  const container = document.getElementById(queueId);
  if (!container) return;

  const searchVal    = (document.getElementById("search-all")?.value || "").toLowerCase();
  const typeFilter   = document.getElementById("filter-type-all")?.value;
  const statusFilter = document.getElementById("filter-status-all")?.value;

  let filtered = [...downloads];
  if (typeFilter)    filtered = filtered.filter(d => d.type === typeFilter);
  if (statusFilter)  filtered = filtered.filter(d => d.status === statusFilter);
  if (searchVal)     filtered = filtered.filter(d =>
    (d.name || "").toLowerCase().includes(searchVal) ||
    (d.url  || "").toLowerCase().includes(searchVal)
  );

  if (filtered.length === 0) {
    container.innerHTML = '<div class="queue-empty">No downloads yet. Paste a URL above to get started.</div>';
    return;
  }

  container.innerHTML = filtered.map(d => buildQueueItem(d)).join("");
}

function buildQueueItem(d) {
  const icons = { youtube: "▶️", torrent: "🔗", direct: "📦", video: "🎬" };
  const icon  = icons[d.type] || "📥";
  const name  = d.name || d.url || "Unknown";
  const sid   = d.session_id;
  const typeBadge   = `<span class="type-badge type-badge--${d.type || "direct"}">${d.type || "file"}</span>`;
  const statusBadge = `<span class="status-badge status-badge--${d.status}">${d.status}</span>`;
  const showBar     = d.status === "downloading" || d.status === "paused";

  const isClickable = d.status === "completed" && d.file_exists === true && d.filepath;
  const nameClass   = isClickable ? "queue-item-name queue-item-name--clickable" : "queue-item-name";
  const nameAttrs   = isClickable
    ? `data-filepath="${escHtml(d.filepath)}" onclick="openFile(this.dataset.filepath)"`
    : "";

  let folderBtn = "";
  if (d.status === "completed" && d.filepath) {
    if (d.file_exists === false) {
      folderBtn = `<button type="button" class="btn-show-folder btn-show-folder--missing"
        data-filepath="${escHtml(d.filepath)}" onclick="showInFolder(this.dataset.filepath)">⚠️ File moved?</button>
        <button type="button" class="btn-action btn-action--retry" onclick="retryDownload('${sid}')">↩ Re-download</button>`;
    } else {
      folderBtn = `<button type="button" class="btn-show-folder"
        data-filepath="${escHtml(d.filepath)}" onclick="showInFolder(this.dataset.filepath)">📂 Show in folder</button>`;
    }
  }

  let pauseBtn = "";
  if (d.status === "downloading") {
    pauseBtn = `<button type="button" class="btn-action btn-action--pause" onclick="pauseDownload('${sid}')">⏸ Pause</button>`;
  } else if (d.status === "paused") {
    pauseBtn = `<button type="button" class="btn-action btn-action--resume" onclick="resumeDownload('${sid}')">▶ Resume</button>`;
  } else if (d.status === "error" || d.status === "interrupted") {
    pauseBtn = `<button type="button" class="btn-action btn-action--retry" onclick="retryDownload('${sid}')">↩ Retry</button>`;
  }

  const deleteBtn = (d.status === "completed" && d.file_exists !== false)
    ? `<button type="button" class="btn-action btn-action--delete-file"
         onclick="removeSession('${sid}', true)" title="Delete file from disk">🗑 Delete file</button>`
    : "";

  const copyBtn = d.url
    ? `<button type="button" class="btn-action btn-action--copy"
         data-url="${escHtml(d.url)}" onclick="copyLink(this.dataset.url)" title="Copy source URL">📋 Copy link</button>`
    : "";

  return `
    <div class="queue-item">
      <input type="checkbox" class="queue-item-check" data-sid="${sid}"
        onchange="toggleSessionSelect('${sid}', this.checked)"
        ${selectedSessions.has(sid) ? "checked" : ""}>
      <div class="queue-item-icon">${icon}</div>
      <div class="queue-item-info">
        <div class="${nameClass}" ${nameAttrs} title="${escHtml(name)}">${escHtml(name)}</div>
        <div class="queue-item-meta">${typeBadge} ${statusBadge}${pauseBtn}${folderBtn}${copyBtn}</div>
        ${showBar ? `
          <div class="queue-item-progress-bar">
            <div class="queue-item-progress-fill" style="width:${d.progress || 0}%"></div>
          </div>
        ` : ""}
        <div class="queue-item-msg">${escHtml(d.message || "")}</div>
        <div class="queue-item-remove-row">
          <button type="button" class="btn-action btn-action--remove"
            onclick="removeSession('${sid}', false)" title="Remove from list">✕ Remove</button>
          ${deleteBtn}
        </div>
      </div>
    </div>
  `;
}

async function showInFolder(filepath) {
  if (!filepath) { showError("File location not recorded for this download."); return; }
  try {
    const res  = await fetch("/api/show-in-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filepath })
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.error === "file_not_found") openMissingModal(filepath);
      else showError(data.error || "Could not open folder");
    }
  } catch (e) { showError(e.message); }
}

async function openFile(filepath) {
  if (!filepath) return;
  try {
    const res  = await fetch("/api/open-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filepath })
    });
    const data = await safeJson(res);
    if (!res.ok) {
      if (data.error === "file_not_found") openMissingModal(filepath);
      else showError(data.error || "Could not open file");
    }
  } catch (e) { showError(e.message); }
}

function openMissingModal(filepath) {
  swalDark.fire({
    icon: "warning",
    title: "File Not Found",
    html: `
      <p style="margin:0 0 12px;color:#d4c4b0;font-size:14px">The file can no longer be found at its saved location:</p>
      <code style="display:block;background:rgba(255,255,255,0.05);border:1px solid rgba(212,196,55,0.22);
        border-radius:8px;padding:10px 14px;font-size:12px;color:#D4AF37;word-break:break-all;
        text-align:left;font-family:Consolas,Monaco,monospace">${escHtml(filepath)}</code>
      <p style="margin:12px 0 0;color:#d4c4b0;font-size:14px">It may have been moved, renamed, or deleted.</p>
    `,
  });
}

// ══════════════════════════════════════════════════
// Queue item actions
// ══════════════════════════════════════════════════
function toggleSessionSelect(sid, checked) {
  if (checked) selectedSessions.add(sid);
  else         selectedSessions.delete(sid);
}

function toggleSelectAll(queueId, checked) {
  const container = document.getElementById(queueId);
  if (!container) return;
  container.querySelectorAll(".queue-item-check").forEach(cb => {
    cb.checked = checked;
    if (checked) selectedSessions.add(cb.dataset.sid);
    else         selectedSessions.delete(cb.dataset.sid);
  });
}

async function pauseDownload(sid) {
  try { await fetch(`/api/pause/${sid}`, { method: "POST" }); refreshAllQueues(); }
  catch (e) { showError(e.message); }
}

async function resumeDownload(sid) {
  try {
    const res = await fetch(`/api/resume/${sid}`, { method: "POST" });
    if (!res.ok) { const d = await res.json(); showError(d.error || "Could not resume"); }
    refreshAllQueues();
  } catch (e) { showError(e.message); }
}

async function pauseSelected(queueId) {
  const container = document.getElementById(queueId);
  if (!container) return;
  const ids = [...container.querySelectorAll(".queue-item-check:checked")].map(cb => cb.dataset.sid);
  for (const sid of ids) { try { await fetch(`/api/pause/${sid}`, { method: "POST" }); } catch (_) {} }
  refreshAllQueues();
}

async function resumeSelected(queueId) {
  const container = document.getElementById(queueId);
  if (!container) return;
  const ids = [...container.querySelectorAll(".queue-item-check:checked")].map(cb => cb.dataset.sid);
  for (const sid of ids) {
    try {
      const res = await fetch(`/api/resume/${sid}`, { method: "POST" });
      if (!res.ok) { const d = await res.json(); showError(d.error || "Could not resume"); }
    } catch (_) {}
  }
  refreshAllQueues();
}

async function retryDownload(sid) {
  try {
    const res = await fetch(`/api/retry/${sid}`, { method: "POST" });
    if (!res.ok) { const d = await res.json(); showError(d.error || "Could not retry"); return; }
    refreshAllQueues();
  } catch (e) { showError(e.message); }
}

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    swalToast.fire({ icon: "success", title: "Link copied!" });
  } catch (e) { showError("Could not copy: " + e.message); }
}

async function removeSession(sid, deleteFile) {
  const result = await swalDark.fire({
    icon: "warning",
    title: deleteFile ? "Delete file?" : "Remove download?",
    text: deleteFile
      ? "This will permanently delete the file from disk and remove it from the list."
      : "This will remove the download from the list.",
    showCancelButton: true,
    confirmButtonText: deleteFile ? "🗑 Delete" : "✕ Remove",
    cancelButtonText: "Cancel",
  });
  if (!result.isConfirmed) return;
  try {
    const res  = await fetch(`/api/remove/${sid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete_file: deleteFile })
    });
    const data = await res.json();
    if (!res.ok) { showError(data.error || "Could not remove"); return; }
    showSuccess(deleteFile
      ? (data.deleted ? "File deleted and removed." : "Removed (file was already gone).")
      : "Removed from list.");
    selectedSessions.delete(sid);
    refreshAllQueues();
  } catch (e) { showError(e.message); }
}

// ══════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isYouTubeUrl(url) { return /(?:youtube\.com|youtu\.be)/i.test(url); }
function isTorrentUrl(url)  { return url.startsWith("magnet:") || /\.torrent(\?|$)/i.test(url); }

async function safeJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch (_) { return { error: `Server returned unexpected response (HTTP ${res.status}).` }; }
}

function buildInfoRow(label, value) {
  return `<div class="info-item">
    <span class="info-label">${label}</span>
    <span class="info-value">${escHtml(String(value))}</span>
  </div>`;
}

function setLoading(button, isLoading) {
  const btnText = button.querySelector(".btn-text");
  const spinner = button.querySelector(".spinner");
  if (isLoading) {
    btnText?.classList.add("hidden");
    spinner?.classList.remove("hidden");
    button.disabled = true;
  } else {
    btnText?.classList.remove("hidden");
    spinner?.classList.add("hidden");
    button.disabled = false;
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024)                return `${bytes} B`;
  if (bytes < 1024 * 1024)         return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function checkDuplicate(url) {
  if (!url) return "proceed";
  const dupe = cachedDownloads.find(d =>
    d.url === url && d.status === "completed" && d.file_exists === true
  );
  if (!dupe) return "proceed";

  const result = await swalDark.fire({
    icon: "warning",
    title: "Already Downloaded",
    html: `<p style="margin:0 0 10px;color:#d4c4b0;font-size:14px">This URL was already downloaded:</p>
           <strong style="color:#D4AF37;word-break:break-all">${escHtml(dupe.name)}</strong>
           <p style="margin:10px 0 0;color:#d4c4b0;font-size:13px">What would you like to do?</p>`,
    showDenyButton: true,
    showCancelButton: true,
    confirmButtonText: "📋 Rename",
    denyButtonText: "♻️ Overwrite",
    cancelButtonText: "✕ Abort",
    denyButtonColor: "#6c757d",
  });

  if (result.isConfirmed) return "rename";
  if (result.isDenied)    return "overwrite";
  return "abort";
}

// Live search / filter wiring
document.getElementById("search-all")?.addEventListener("input", refreshAllQueues);
document.getElementById("filter-type-all")?.addEventListener("change", refreshAllQueues);
document.getElementById("filter-status-all")?.addEventListener("change", refreshAllQueues);

// ══════════════════════════════════════════════════
// Global fetch handler
// ══════════════════════════════════════════════════
function handleGlobalDownload() {
  const url = globalUrlInput.value.trim();
  if (!url) { showError("Please enter a URL"); return; }

  if (isYouTubeUrl(url)) {
    currentMode = "youtube";
    if (urlCache[url]?.mode === "youtube") { restoreFromCache(url); return; }
    fetchVideoInfo();
  } else if (isTorrentUrl(url)) {
    currentMode = "torrent";
    startTorrentDownload();
  } else {
    currentMode = "others";
    if (urlCache[url]?.mode === "others") { restoreFromCache(url); return; }
    analyzeOthersUrl();
  }
}

globalDownloadBtn.addEventListener("click", handleGlobalDownload);
globalUrlInput.addEventListener("keypress", e => { if (e.key === "Enter") handleGlobalDownload(); });

// Torrent file — show confirmation modal first, upload only on confirm
globalTorrentFileInput.addEventListener("change", () => {
  const file = globalTorrentFileInput.files[0];
  if (!file) return;
  globalTorrentFileInput.value = "";
  showTorrentFileModal(file);
});

// ══════════════════════════════════════════════════
// Torrent
// ══════════════════════════════════════════════════
function startTorrentDownload() {
  const url = globalUrlInput.value.trim();
  if (!url) return;
  const isMagnet = url.startsWith("magnet:");
  dlModalTitle.textContent = isMagnet ? "Magnet Link" : "Torrent Download";
  dlModalMeta.innerHTML    = `<span class="type-badge type-badge--torrent">torrent</span>`;
  const displayUrl = url.length > 90 ? url.slice(0, 90) + "…" : url;
  dlTorrentInfo.innerHTML  =
    buildInfoRow("🔗 URL",  displayUrl) +
    buildInfoRow("📂 Type", isMagnet ? "Magnet link" : "Torrent URL");
  dlConfirmBtn.disabled = false;
  openDownloadModal("torrent");
}

function showTorrentFileModal(file) {
  pendingTorrentFile = file;
  currentMode = "torrent_file";

  dlModalTitle.textContent = file.name.replace(/\.torrent$/i, "") || file.name;
  dlModalMeta.innerHTML    = `<span class="type-badge type-badge--torrent">torrent file</span>`;
  dlTorrentInfo.innerHTML  =
    buildInfoRow("📄 File", file.name) +
    buildInfoRow("📊 Size", formatFileSize(file.size)) +
    buildInfoRow("📂 Type", ".torrent file");
  dlConfirmBtn.disabled = false;
  openDownloadModal("torrent_file");
}

async function startTorrentDownloadConfirmed() {
  const url = globalUrlInput.value.trim();
  if (!url) return;
  setLoading(dlConfirmBtn, true);
  try {
    const res  = await fetch("/api/download-torrent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || "Torrent failed");
    globalUrlInput.value = "";
    closeDownloadModal();
    showSuccess("Torrent started! Track progress in the queue below.");
    startQueuePolling();
  } catch (e) { showError(e.message); }
  finally { setLoading(dlConfirmBtn, false); }
}

async function startTorrentFileDownload() {
  if (!pendingTorrentFile) return;
  const file = pendingTorrentFile;
  setLoading(dlConfirmBtn, true);
  try {
    const formData = new FormData();
    formData.append("file", file);
    const res  = await fetch("/api/upload-torrent", { method: "POST", body: formData });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || "Upload failed");
    pendingTorrentFile = null;
    closeDownloadModal();
    showSuccess("Torrent started! Track progress in the queue below.");
    startQueuePolling();
  } catch (e) { showError(e.message); }
  finally { setLoading(dlConfirmBtn, false); }
}

// ══════════════════════════════════════════════════
// Others (direct files / non-YouTube video sites)
// ══════════════════════════════════════════════════
async function analyzeOthersUrl() {
  const url = globalUrlInput.value.trim();
  if (!url) { showError("Please enter a URL"); return; }

  othersAnalyzedData = null;

  // Open modal immediately with skeleton (modal-first UX)
  dlModalTitle.textContent = "Analyzing…";
  dlModalMeta.innerHTML    = "";
  dlOthersInfo.innerHTML   = `
    <div class="skeleton skeleton-format-item"></div>
    <div class="skeleton skeleton-format-item"></div>
  `;
  dlConfirmBtn.disabled = true;
  openDownloadModal("others");

  setLoading(globalDownloadBtn, true);

  try {
    const res  = await fetch("/api/analyze-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || "Analysis failed");

    othersAnalyzedData = data;

    dlModalTitle.textContent = data.title || data.filename || "File Download";
    dlModalMeta.innerHTML    = `<span class="type-badge type-badge--${data.type || "direct"}">${data.type || "direct"}</span>`;

    let rows = "";
    if (data.filename) rows += buildInfoRow("📄 File", data.filename);
    if (data.size)     rows += buildInfoRow("📊 Size", data.size);
    rows += buildInfoRow("🏷️ Type", data.type || "direct file");
    dlOthersInfo.innerHTML = rows;

    dlConfirmBtn.disabled = false;
    urlCache[url] = { mode: "others", othersData: data };

  } catch (e) {
    showError(e.message);
    closeDownloadModal();
  } finally {
    setLoading(globalDownloadBtn, false);
  }
}

async function startOthersDownload() {
  if (!othersAnalyzedData) return;
  const url = globalUrlInput.value.trim();

  const action = await checkDuplicate(url);
  if (action === "abort") return;
  const rename_mode = action === "rename";

  setLoading(dlConfirmBtn, true);
  try {
    const endpoint = othersAnalyzedData.type === "video"
      ? "/api/download-video-best"
      : "/api/download-direct";
    const res  = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, rename_mode })
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || "Download failed");
    closeDownloadModal();
    globalUrlInput.value = "";
    othersAnalyzedData = null;
    delete urlCache[url];
    showSuccess("Download started! Track progress in the queue below.");
    startQueuePolling();
  } catch (e) { showError(e.message); }
  finally { setLoading(dlConfirmBtn, false); }
}

// ══════════════════════════════════════════════════
// YouTube — fetch info then formats
// ══════════════════════════════════════════════════
async function fetchVideoInfo() {
  const url = globalUrlInput.value.trim();
  if (!url) { showError("Please enter a URL"); return; }
  fetchedUrl = url;

  skippedIndices.clear();
  currentData         = null;
  selectedVideoFormat = null;
  selectedAudioFormat = null;

  // Open modal immediately with skeleton content (modal-first UX)
  dlModalTitle.textContent = "Loading…";
  dlModalMeta.innerHTML    = "";
  const skel = `
    <div class="skeleton skeleton-format-item"></div>
    <div class="skeleton skeleton-format-item"></div>
    <div class="skeleton skeleton-format-item"></div>
  `;
  dlVideoFormatList.innerHTML  = skel;
  dlAudioFormatListV.innerHTML = skel;
  dlAudioFormatListA.innerHTML = skel;
  dlConfirmBtn.disabled = true;
  setDlTab("video");
  dlPlaylistSection.classList.add("hidden");
  openDownloadModal("youtube");

  setLoading(globalDownloadBtn, true);

  try {
    // Phase 1: basic info
    const infoRes  = await fetch("/api/fetch-info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const infoData = await safeJson(infoRes);
    if (!infoRes.ok) throw new Error(infoData.error || "Failed to fetch video info");

    currentData = infoData;

    dlModalTitle.textContent = infoData.title || "Video";
    dlModalMeta.innerHTML    = infoData.is_playlist
      ? `<span class="badge">${infoData.video_count || "?"} videos</span>`
      : `<span class="type-badge type-badge--youtube">YouTube</span>`;

    if (infoData.is_playlist && infoData.videos) {
      playlistData = infoData.videos;
      displayPlaylistVideos(infoData.videos);
      dlPlaylistSection.classList.remove("hidden");
    }

    setLoading(globalDownloadBtn, false);

    // Phase 2: formats (modal stays open, formats replace skeletons)
    const firstVideoUrl = infoData.is_playlist && infoData.videos?.length > 0
      ? infoData.videos[0].url : null;

    const fmtRes  = await fetch("/api/fetch-formats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, is_playlist: infoData.is_playlist, first_video_url: firstVideoUrl }),
    });
    const fmtData = await safeJson(fmtRes);
    if (!fmtRes.ok) throw new Error(fmtData.error || "Failed to fetch formats");

    currentData = { ...currentData, ...fmtData };
    displayFormats(fmtData);
    dlConfirmBtn.disabled = false;

    urlCache[url] = { mode: "youtube", infoData, formatsData: fmtData };

  } catch (error) {
    showError(error.message);
    closeDownloadModal();
    setLoading(globalDownloadBtn, false);
  }
}

function displayFormats(data) {
  dlVideoFormatList.innerHTML = "";
  data.video_formats.forEach((fmt, i) =>
    dlVideoFormatList.appendChild(createFormatItem(fmt, "video", i)));

  dlAudioFormatListV.innerHTML = "";
  dlAudioFormatListA.innerHTML = "";
  data.audio_formats.forEach((fmt, i) => {
    dlAudioFormatListV.appendChild(createFormatItem(fmt, "audio", i));
    dlAudioFormatListA.appendChild(createFormatItem(fmt, "audio", i));
  });

  if (data.video_formats.length > 0)
    selectFormat(dlVideoFormatList.children[0], data.video_formats[0], "video");
  if (data.audio_formats.length > 0)
    selectFormat(dlAudioFormatListV.children[0], data.audio_formats[0], "audio");
}

function createFormatItem(format, type, index) {
  const div = document.createElement("div");
  div.className = `format-item format-item--${type}`;
  div.dataset.formatId = String(format.id);
  const detail = type === "video" ? format.res : `${Math.round(format.abr || 0)}kbps`;
  div.innerHTML = `
    <div class="format-main">
      <span class="format-ext">${format.ext}</span>
      <span class="format-detail">${detail}</span>
    </div>
    ${format.note ? `<span class="format-note">${escHtml(format.note)}</span>` : ""}
  `;
  div.addEventListener("click", () => selectFormat(div, format, type));
  return div;
}

function selectFormat(element, format, type) {
  if (type === "video") {
    dlVideoFormatList.querySelectorAll(".format-item").forEach(el => el.classList.remove("selected"));
    element.classList.add("selected");
    selectedVideoFormat = format.id;
  } else {
    const fid = String(format.id);
    [dlAudioFormatListV, dlAudioFormatListA].forEach(list => {
      list.querySelectorAll(".format-item").forEach(el => {
        el.classList.toggle("selected", el.dataset.formatId === fid);
      });
    });
    selectedAudioFormat = format.id;
  }
}

function displayPlaylistVideos(videos) {
  dlPlaylistVideos.innerHTML = "";
  videos.forEach(video => {
    const item = document.createElement("div");
    item.className = "playlist-video-item";
    item.dataset.index = video.index;
    item.innerHTML = `
      <div class="playlist-video-checkbox">
        <input type="checkbox" id="video-${video.index}" checked>
      </div>
      <div class="playlist-video-info">
        <div class="playlist-video-number">${video.index}</div>
        <div class="playlist-video-details">
          <div class="playlist-video-title">${escHtml(video.title)}</div>
          <div class="playlist-video-duration">${formatDuration(video.duration)}</div>
        </div>
      </div>
    `;
    item.querySelector('input[type="checkbox"]').addEventListener("change", e => {
      if (e.target.checked) { skippedIndices.delete(video.index); item.classList.remove("skipped"); }
      else                  { skippedIndices.add(video.index);    item.classList.add("skipped"); }
      updateDownloadCount();
    });
    dlPlaylistVideos.appendChild(item);
  });
  updateDownloadCount();
}

function formatDuration(seconds) {
  if (!seconds) return "Unknown";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function updateDownloadCount() {
  if (!currentData?.videos) return;
  const total    = currentData.videos.length;
  const selected = total - skippedIndices.size;
  if (dlSelectedCount) dlSelectedCount.textContent = `${selected} of ${total} videos selected`;
}

function selectAllVideos() {
  skippedIndices.clear();
  dlPlaylistVideos.querySelectorAll(".playlist-video-item").forEach(item => {
    item.querySelector('input[type="checkbox"]').checked = true;
    item.classList.remove("skipped");
  });
  updateDownloadCount();
}

function deselectAllVideos() {
  dlPlaylistVideos.querySelectorAll(".playlist-video-item").forEach(item => {
    skippedIndices.add(parseInt(item.dataset.index));
    item.querySelector('input[type="checkbox"]').checked = false;
    item.classList.add("skipped");
  });
  updateDownloadCount();
}

// ══════════════════════════════════════════════════
// Start YouTube download
// ══════════════════════════════════════════════════
async function startDownload() {
  const downloadType = dlTabMode;

  if (!selectedAudioFormat) { showError("Please select an audio quality"); return; }
  if (downloadType === "video" && !selectedVideoFormat) { showError("Please select a video quality"); return; }

  const action = await checkDuplicate(fetchedUrl);
  if (action === "abort") return;
  const rename_mode = action === "rename";

  setLoading(dlConfirmBtn, true);
  try {
    const res  = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url:             fetchedUrl,
        download_type:   downloadType,
        video_format_id: selectedVideoFormat,
        audio_format_id: selectedAudioFormat,
        is_playlist:     currentData.is_playlist,
        skip_indices:    Array.from(skippedIndices),
        rename_mode,
      }),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || "Failed to start download");
    closeDownloadModal();
    globalUrlInput.value = "";
    delete urlCache[fetchedUrl];
    showSuccess("Download started! Track progress in the queue below.");
    startQueuePolling();
  } catch (error) { showError(error.message); }
  finally { setLoading(dlConfirmBtn, false); }
}

// ══════════════════════════════════════════════════
// SweetAlert2 themed helpers
// ══════════════════════════════════════════════════
const swalDark = Swal.mixin({
  background: "#1a1c23",
  color: "#f5ebe0",
  confirmButtonColor: "#D4AF37",
  cancelButtonColor: "rgba(255,255,255,0.12)",
  customClass: { popup: "swal-afriway" }
});

const swalToast = swalDark.mixin({
  toast: true,
  position: "top-end",
  showConfirmButton: false,
  timer: 3000,
  timerProgressBar: true,
});

function showError(message)   { swalDark.fire({ icon: "error",   title: "Error",   text: message }); }
function showSuccess(message) { swalToast.fire({ icon: "success", title: message }); }

// ══════════════════════════════════════════════════
// Init
// ══════════════════════════════════════════════════
loadDrives();
refreshAllQueues();
startQueuePolling();
