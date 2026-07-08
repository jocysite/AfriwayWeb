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
  loadDiskSpace();
}

function closeSettings() {
  document.getElementById("settingsModal").classList.add("hidden");
}

document.getElementById("settingsBtn").addEventListener("click", openSettings);

// ══════════════════════════════════════════════════
// Free Space (disk usage for the current download drive)
// ══════════════════════════════════════════════════
async function loadDiskSpace() {
  const fill      = document.getElementById("storageBarFill");
  const usedLabel = document.getElementById("storageUsedLabel");
  const freeLabel = document.getElementById("storageFreeLabel");
  if (!fill || !usedLabel || !freeLabel) return;
  try {
    const res  = await fetch("/api/disk-space");
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "unavailable");
    const pct = data.total > 0 ? (data.used / data.total) * 100 : 0;
    fill.style.width      = Math.min(pct, 100) + "%";
    fill.style.background = pct > 90 ? "#e74c3c" : pct > 75 ? "#e67e22" : "";
    usedLabel.textContent = `${formatFileSize(data.used)} used`;
    freeLabel.textContent = `${formatFileSize(data.free)} free of ${formatFileSize(data.total)}`;
  } catch (_) {
    usedLabel.textContent = "Free space unavailable";
    freeLabel.textContent = "";
  }
}

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
  loadDownloadLocation();
}

// ══════════════════════════════════════════════════
// Download location — full folder, not just a drive
// ══════════════════════════════════════════════════
async function loadDownloadLocation() {
  const el = document.getElementById("dlLocationPath");
  if (!el) return;
  try {
    const res  = await fetch("/api/get-location");
    const data = await res.json();
    el.textContent = data.path || "Downloads/Afriway";
    el.title = data.path || "";
  } catch (_) {}
}

async function pickDownloadLocation() {
  if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.pick_folder) {
    showError("Choosing a folder is only available in the desktop app.");
    return;
  }
  try {
    const folder = await window.pywebview.api.pick_folder();
    if (!folder) return; // user cancelled
    const res  = await fetch("/api/set-location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location: folder })
    });
    const data = await safeJson(res);
    if (!res.ok) { showError(data.error || "Could not set folder"); return; }
    await loadDownloadLocation();
    loadDiskSpace();
    showSuccess("Downloads will now be saved under: " + data.path);
  } catch (e) { showError(e.message); }
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
    selectedVideoFormat = null;
    selectedAudioFormat = null;

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
        loadDiskSpace();
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
    renderPlaylistProgress();
    updateClearButtons();
  } catch (_) {}
}

function updateClearButtons() {
  const clearBtn    = document.getElementById("clearSelectedBtn");
  const clearAllBtn = document.getElementById("clearAllBtn");
  if (clearBtn)    clearBtn.disabled    = selectedSessions.size === 0;
  if (clearAllBtn) clearAllBtn.disabled = cachedDownloads.length === 0;
}

// ══════════════════════════════════════════════════
// Playlist per-video progress modal
// ══════════════════════════════════════════════════
let activePlaylistSid = null;

function openPlaylistProgress(sid) {
  activePlaylistSid = sid;
  document.getElementById("playlistProgressModal")?.classList.remove("hidden");
  renderPlaylistProgress();
}

function closePlaylistProgress() {
  activePlaylistSid = null;
  document.getElementById("playlistProgressModal")?.classList.add("hidden");
}

function renderPlaylistProgress() {
  if (!activePlaylistSid) return;
  const modal = document.getElementById("playlistProgressModal");
  if (!modal || modal.classList.contains("hidden")) return;

  const d = cachedDownloads.find(x => x.session_id === activePlaylistSid);
  if (!d) { closePlaylistProgress(); return; }

  const titleEl = document.getElementById("pvModalTitle");
  const metaEl  = document.getElementById("pvModalMeta");
  if (titleEl) titleEl.textContent = (d.name && d.name !== d.url) ? d.name : "Playlist Download";
  if (metaEl)  metaEl.innerHTML = `<span class="status-badge status-badge--${d.status}">${d.status}</span>`;

  const videos  = d.videos || [];
  const active  = videos.filter(v => v.status !== "skipped");
  const overallPct = active.length
    ? active.reduce((sum, v) => sum + (v.progress || 0), 0) / active.length
    : 0;
  const doneCount = active.filter(v => v.status === "completed").length;

  const overallEl = document.getElementById("pvOverall");
  if (overallEl) {
    overallEl.innerHTML =
      `<span>📊 Overall: ${overallPct.toFixed(1)}%</span><span>${doneCount}/${active.length} videos completed</span>`;
  }

  const listEl = document.getElementById("pvVideoList");
  if (!listEl) return;
  listEl.innerHTML = videos.map(v => {
    const pct       = v.status === "skipped" ? 0 : (v.progress || 0);
    const speedStr  = v.status === "downloading" ? formatSpeed(v.speed) : "";
    const openable  = v.status === "completed" && v.filepath;
    const titleAttrs = openable
      ? `data-filepath="${escHtml(v.filepath)}" onclick="openFile(this.dataset.filepath)"`
      : "";
    return `
      <div class="pv-item">
        <div class="pv-item-top">
          <div class="pv-item-number">${v.index}</div>
          <div class="pv-item-title${openable ? ' pv-item-title--clickable' : ''}" ${titleAttrs} title="${escHtml(v.title || "")}">${escHtml(v.title || "Video " + v.index)}</div>
          <div class="pv-item-pct">${v.status === "skipped" ? "—" : pct.toFixed(1) + "%"}</div>
        </div>
        <div class="pv-item-bar"><div class="pv-item-fill" style="width:${pct}%"></div></div>
        <div class="pv-item-meta">
          <span class="status-badge status-badge--${v.status}">${v.status}</span>
          ${speedStr ? `<span class="speed-badge">⚡ ${speedStr}</span>` : ""}
        </div>
      </div>
    `;
  }).join("");
}

document.addEventListener("keydown", e => {
  if (e.key === "Escape") closePlaylistProgress();
});

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

function formatSpeed(bps) {
  if (!bps || bps <= 0) return '';
  if (bps >= 1024 * 1024 * 1024) return (bps / (1024 * 1024 * 1024)).toFixed(2) + ' GB/s';
  if (bps >= 1024 * 1024)        return (bps / (1024 * 1024)).toFixed(1) + ' MB/s';
  if (bps >= 1024)                return (bps / 1024).toFixed(0) + ' KB/s';
  return bps + ' B/s';
}

function buildQueueItem(d) {
  const icons = { youtube: "▶️", torrent: "🔗", direct: "📦", video: "🎬" };
  const icon  = icons[d.type] || "📥";
  const name  = d.name || d.url || "Unknown";
  const sid   = d.session_id;
  const typeBadge   = `<span class="type-badge type-badge--${d.type || "direct"}">${d.type || "file"}</span>`;
  const statusBadge = `<span class="status-badge status-badge--${d.status}">${d.status}</span>`;
  const showBar     = d.status === "downloading" || d.status === "paused";
  const speedStr    = d.status === "downloading" ? formatSpeed(d.speed) : '';
  const speedBadge  = speedStr ? `<span class="speed-badge">⚡ ${speedStr}</span>` : '';

  const isPlaylist  = !!d.is_playlist;
  const isClickable = isPlaylist || (d.status === "completed" && d.file_exists === true && d.filepath);
  const nameClass   = isClickable ? "queue-item-name queue-item-name--clickable" : "queue-item-name";
  const nameAttrs   = isPlaylist
    ? `onclick="openPlaylistProgress('${sid}')"`
    : (isClickable
        ? `data-filepath="${escHtml(d.filepath)}" onclick="openFile(this.dataset.filepath)"`
        : "");

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
  } else if (d.save_dir) {
    // Destination folder is known before completion too (downloading/paused/error/interrupted)
    folderBtn = `<button type="button" class="btn-show-folder"
      data-filepath="${escHtml(d.save_dir)}" onclick="showInFolder(this.dataset.filepath)">📂 Show in folder</button>`;
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
        <div class="queue-item-meta">${typeBadge} ${statusBadge}${speedBadge}${pauseBtn}${folderBtn}${copyBtn}</div>
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
        border-radius:8px;padding:10px 14px;font-size:12px;color:#C9A227;word-break:break-all;
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
  updateClearButtons();
}

function toggleSelectAll(queueId, checked) {
  const container = document.getElementById(queueId);
  if (!container) return;
  container.querySelectorAll(".queue-item-check").forEach(cb => {
    cb.checked = checked;
    if (checked) selectedSessions.add(cb.dataset.sid);
    else         selectedSessions.delete(cb.dataset.sid);
  });
  updateClearButtons();
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

async function clearSelected(queueId) {
  const container = document.getElementById(queueId);
  if (!container) return;
  const ids = [...container.querySelectorAll(".queue-item-check:checked")].map(cb => cb.dataset.sid);
  if (!ids.length) return;

  const result = await swalDark.fire({
    icon: "warning",
    title: "Clear selected downloads?",
    text: `This will remove ${ids.length} download${ids.length > 1 ? "s" : ""} from the list. Downloaded files will not be deleted.`,
    showCancelButton: true,
    confirmButtonText: "🗑 Clear",
    cancelButtonText: "Cancel",
  });
  if (!result.isConfirmed) return;

  for (const sid of ids) {
    try {
      await fetch(`/api/remove/${sid}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete_file: false })
      });
    } catch (_) {}
    selectedSessions.delete(sid);
  }
  showSuccess("Cleared selected downloads from the list.");
  refreshAllQueues();
}

async function clearAllDownloads() {
  if (!cachedDownloads.length) return;
  const ids = cachedDownloads.map(d => d.session_id);

  const result = await swalDark.fire({
    icon: "warning",
    title: "Clear all downloads?",
    text: `This will remove all ${ids.length} download${ids.length > 1 ? "s" : ""} from the list. Downloaded files will not be deleted.`,
    showCancelButton: true,
    confirmButtonText: "🗑 Clear All",
    cancelButtonText: "Cancel",
  });
  if (!result.isConfirmed) return;

  for (const sid of ids) {
    try {
      await fetch(`/api/remove/${sid}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete_file: false })
      });
    } catch (_) {}
  }
  selectedSessions.clear();
  showSuccess("Cleared all downloads from the list.");
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
  catch (_) {
    // Show first 300 chars of the raw response so the real error is visible
    const preview = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 300);
    return { error: `HTTP ${res.status}: ${preview || '(empty response)'}` };
  }
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
           <strong style="color:#C9A227;word-break:break-all">${escHtml(dupe.name)}</strong>
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

// Video defaults to 720p (closest available) so the pick is sensible without
// forcing users to hunt for it. Audio (a separate standalone file) is opt-in —
// no default there, so it isn't downloaded unless the user actively picks a quality.
function pickDefaultVideoIndex(formats) {
  let bestIdx = 0, bestDiff = Infinity;
  formats.forEach((fmt, i) => {
    const diff = Math.abs((fmt.height || 0) - 720);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  });
  return bestIdx;
}

function displayFormats(data) {
  const noFmt = `<div class="format-empty">No formats available</div>`;

  dlVideoFormatList.innerHTML = "";
  if (data.video_formats.length === 0) {
    dlVideoFormatList.innerHTML = noFmt;
  } else {
    data.video_formats.forEach((fmt, i) =>
      dlVideoFormatList.appendChild(createFormatItem(fmt, "video", i)));
    const defaultIdx = pickDefaultVideoIndex(data.video_formats);
    selectFormat(dlVideoFormatList.children[defaultIdx], data.video_formats[defaultIdx], "video");
  }

  dlAudioFormatListA.innerHTML = "";
  if (data.audio_formats.length === 0) {
    dlAudioFormatListA.innerHTML = noFmt;
  } else {
    data.audio_formats.forEach((fmt, i) =>
      dlAudioFormatListA.appendChild(createFormatItem(fmt, "audio", i)));
  }
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
  div.addEventListener("click", () => toggleFormat(div, format, type));
  return div;
}

// Clicking a format selects it; clicking the already-selected one deselects it
// (so a video and/or audio quality can each be picked independently — see startDownload()).
function toggleFormat(element, format, type) {
  const isSame = type === "video"
    ? selectedVideoFormat === format.id
    : selectedAudioFormat === format.id;

  if (isSame) {
    element.classList.remove("selected");
    if (type === "video") selectedVideoFormat = null;
    else                  selectedAudioFormat = null;
  } else {
    selectFormat(element, format, type);
  }
}

function selectFormat(element, format, type) {
  if (type === "video") {
    dlVideoFormatList.querySelectorAll(".format-item").forEach(el => el.classList.remove("selected"));
    element.classList.add("selected");
    selectedVideoFormat = format.id;
  } else {
    dlAudioFormatListA.querySelectorAll(".format-item").forEach(el => el.classList.remove("selected"));
    element.classList.add("selected");
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
  if (!selectedVideoFormat && !selectedAudioFormat) {
    showError("Please select a video and/or audio quality");
    return;
  }

  // Video + Audio always travel together as one merged file; a standalone Audio
  // file is a separate, independent job. Either or both can be requested at once.
  const jobs = [];
  if (selectedVideoFormat) {
    jobs.push({ download_type: "video", video_format_id: selectedVideoFormat, audio_format_id: "bestaudio" });
  }
  if (selectedAudioFormat) {
    jobs.push({ download_type: "audio", video_format_id: null, audio_format_id: selectedAudioFormat });
  }

  const action = await checkDuplicate(fetchedUrl);
  if (action === "abort") return;
  const rename_mode = action === "rename";

  setLoading(dlConfirmBtn, true);
  try {
    for (const job of jobs) {
      const res  = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url:             fetchedUrl,
          download_type:   job.download_type,
          video_format_id: job.video_format_id,
          audio_format_id: job.audio_format_id,
          is_playlist:     currentData.is_playlist,
          skip_indices:    Array.from(skippedIndices),
          rename_mode,
        }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || "Failed to start download");
    }
    closeDownloadModal();
    globalUrlInput.value = "";
    delete urlCache[fetchedUrl];
    showSuccess(jobs.length > 1
      ? "Downloads started! Track progress in the queue below."
      : "Download started! Track progress in the queue below.");
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
  confirmButtonColor: "#C9A227",
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
// Theme
// ══════════════════════════════════════════════════
// ══════════════════════════════════════════════════
// YouTube Cookies
// ══════════════════════════════════════════════════
async function loadCookieStatus() {
  try {
    const r = await fetch('/api/cookies/status');
    const d = await r.json();
    const pill = document.getElementById('cookieStatusPill');
    const icon = document.getElementById('cookieStatusIcon');
    const text = document.getElementById('cookieStatusText');
    const clearBtn = document.getElementById('clearCookiesBtn');
    if (d.loaded) {
      pill.classList.add('cookie-loaded');
      icon.textContent = '✓';
      text.textContent = `Cookies loaded (${(d.size/1024).toFixed(1)} KB · ${d.date})`;
      clearBtn.style.display = '';
    } else {
      pill.classList.remove('cookie-loaded');
      icon.textContent = '○';
      text.textContent = 'No cookies loaded';
      clearBtn.style.display = 'none';
    }
  } catch (_) {}
}

async function uploadCookies(input) {
  const file = input.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch('/api/cookies/upload', { method: 'POST', body: fd });
    const d = await r.json();
    if (d.ok) { showSuccess('YouTube cookies loaded successfully!'); loadCookieStatus(); }
    else showError(d.error || 'Failed to upload cookies');
  } catch (e) { showError(e.message); }
  input.value = '';
}

async function clearCookies() {
  try {
    await fetch('/api/cookies/clear', { method: 'POST' });
    showSuccess('YouTube cookies cleared.');
    loadCookieStatus();
  } catch (e) { showError(e.message); }
}

function setTheme(name) {
  document.documentElement.setAttribute('data-theme', name);
  document.querySelectorAll('.theme-opt').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.theme === name)
  );
  document.getElementById('themeMenu')?.classList.add('hidden');
  fetch('/api/prefs', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({theme: name})
  }).catch(() => {});
}

function toggleThemeMenu(e) {
  e.stopPropagation();
  document.getElementById('themeMenu')?.classList.toggle('hidden');
}

// Close theme menu when clicking outside
document.addEventListener('click', () => {
  document.getElementById('themeMenu')?.classList.add('hidden');
});

// Sync active button with server-set theme on the <html> element
(function() {
  const current = document.documentElement.getAttribute('data-theme') || 'default';
  document.querySelectorAll('.theme-opt').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.theme === current)
  );
})();

// ══════════════════════════════════════════════════
// Init
// ══════════════════════════════════════════════════
// URL Input Right-Click Context Menu
// ══════════════════════════════════════════════════
// The desktop app's webview (pywebview/WebView2) has no permission-prompt UI,
// so navigator.clipboard.readText()/writeText() are silently denied there.
// Route through the OS clipboard via the backend instead — see /api/clipboard.
async function readClipboardText() {
  try {
    const res  = await fetch('/api/clipboard');
    const data = await res.json();
    return data.text || '';
  } catch (_) { return ''; }
}

async function writeClipboardText(text) {
  try {
    await fetch('/api/clipboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (_) {}
}

(function () {
  const urlInput = document.getElementById('globalUrlInput');
  const wrap     = document.querySelector('.url-input-wrap');
  const menu     = document.getElementById('urlContextMenu');
  const btnCut   = document.getElementById('ctxCut');
  const btnCopy  = document.getElementById('ctxCopy');
  const btnPaste = document.getElementById('ctxPaste');

  if (!urlInput || !menu) return;

  function hideMenu() {
    menu.classList.add('hidden');
  }

  function showMenu(x, y) {
    menu.classList.remove('hidden');
    const vw = window.innerWidth, vh = window.innerHeight;
    const mw = menu.offsetWidth  || 170;
    const mh = menu.offsetHeight || 110;
    menu.style.left = Math.min(x, vw - mw - 6) + 'px';
    menu.style.top  = Math.min(y, vh - mh - 6) + 'px';
  }

  // Listen on the whole input wrapper (covers right-clicking the paste button too),
  // not just the bare <input>.
  (wrap || urlInput).addEventListener('contextmenu', function (e) {
    e.preventDefault();
    urlInput.focus();
    const hasSel = urlInput.selectionStart !== urlInput.selectionEnd;
    btnCut.dataset.disabled  = hasSel ? 'false' : 'true';
    btnCopy.dataset.disabled = hasSel ? 'false' : 'true';
    showMenu(e.clientX, e.clientY);
  });

  btnCut.addEventListener('click', async function () {
    const start = urlInput.selectionStart;
    const end   = urlInput.selectionEnd;
    if (start !== end) {
      await writeClipboardText(urlInput.value.slice(start, end));
      urlInput.value = urlInput.value.slice(0, start) + urlInput.value.slice(end);
      urlInput.focus();
      urlInput.setSelectionRange(start, start);
      urlInput.dispatchEvent(new Event('input'));
    }
    hideMenu();
  });

  btnCopy.addEventListener('click', async function () {
    const start = urlInput.selectionStart;
    const end   = urlInput.selectionEnd;
    if (start !== end) {
      await writeClipboardText(urlInput.value.slice(start, end));
    }
    hideMenu();
  });

  btnPaste.addEventListener('click', async function () {
    const text = await readClipboardText();
    if (text) {
      const start = urlInput.selectionStart;
      const end   = urlInput.selectionEnd;
      const val   = urlInput.value;
      urlInput.value = val.slice(0, start) + text + val.slice(end);
      const cursor = start + text.length;
      urlInput.focus();
      urlInput.setSelectionRange(cursor, cursor);
      urlInput.dispatchEvent(new Event('input'));
    }
    hideMenu();
  });

  document.addEventListener('click', function (e) {
    if (!menu.contains(e.target) && e.target !== urlInput) hideMenu();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hideMenu();
  });
})();

// ── Inline paste button inside URL input ──
(function () {
  const btn      = document.getElementById('urlPasteBtn');
  const urlInput = document.getElementById('globalUrlInput');
  if (!btn || !urlInput) return;

  btn.addEventListener('click', async function () {
    const text = (await readClipboardText()).trim();
    if (text) {
      urlInput.value = text;
      urlInput.focus();
      urlInput.dispatchEvent(new Event('input'));
    }
  });
})();

// ── Inline copy button inside URL input ──
(function () {
  const btn      = document.getElementById('urlCopyBtn');
  const urlInput = document.getElementById('globalUrlInput');
  if (!btn || !urlInput) return;

  btn.addEventListener('click', async function () {
    if (!urlInput.value) return;
    await writeClipboardText(urlInput.value);
    swalToast.fire({ icon: 'success', title: 'Copied!' });
  });
})();

// ══════════════════════════════════════════════════
// Speed Test
// ══════════════════════════════════════════════════
const CF_TRACE     = 'https://speed.cloudflare.com/cdn-cgi/trace';
const CF_DOWN      = 'https://speed.cloudflare.com/__down?bytes=26214400'; // 25 MB
const CF_UP        = 'https://speed.cloudflare.com/__up';
const CF_LIVE_DOWN = 'https://speed.cloudflare.com/__down?bytes=2097152';  // 2 MB — lightweight ambient probe
const SPEED_GAUGE_R        = 95;
const SPEED_GAUGE_CIRC     = 2 * Math.PI * SPEED_GAUGE_R;        // ~596.9 — full circle
const SPEED_GAUGE_SWEEP    = 270;                                 // degrees the gauge actually spans
const SPEED_GAUGE_ARC_LEN  = SPEED_GAUGE_CIRC * (SPEED_GAUGE_SWEEP / 360); // ~447.68
// Non-linear scale so common home-broadband speeds (the low end) get more of the
// dial, matching a typical speedometer-style speed test rather than a linear one.
const SPEED_GAUGE_TICKS = [0, 5, 10, 50, 100, 250, 500, 750, 1000];

let speedAbort = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function openSpeedTest() {
  document.getElementById("speedTestModal").classList.remove("hidden");
  loadSpeedHistory();
  startSpeedTest();
}

function closeSpeedTest() {
  document.getElementById("speedTestModal").classList.add("hidden");
  if (speedAbort) speedAbort.abort();
}

function cancelSpeedTest() {
  if (speedAbort) speedAbort.abort();
  closeSpeedTest();
}

function showSpeedPhase(suffix) {
  ["Error", "Active"].forEach(s => {
    document.getElementById("speed" + s).classList.toggle("hidden", s !== suffix);
  });
}

function mbpsToGaugePct(mbps) {
  const v     = Math.max(0, mbps);
  const ticks = SPEED_GAUGE_TICKS;
  if (v >= ticks[ticks.length - 1]) return 1;
  for (let i = 0; i < ticks.length - 1; i++) {
    if (v <= ticks[i + 1]) {
      const segFrac = (v - ticks[i]) / (ticks[i + 1] - ticks[i]);
      return (i + segFrac) / (ticks.length - 1);
    }
  }
  return 1;
}

function setGaugeValue(mbps) {
  const arc   = document.getElementById("speedGaugeArc");
  const value = document.getElementById("speedGaugeValue");
  const pct   = mbpsToGaugePct(mbps);
  arc.style.strokeDashoffset = SPEED_GAUGE_ARC_LEN * (1 - pct);
  value.textContent = mbps >= 10 ? mbps.toFixed(1) : mbps > 0 ? mbps.toFixed(2) : "0.0";
}

// ── Ping + ISP (Cloudflare trace) ──
// onInfo fires as soon as the first round replies — the caller can show
// ISP/server info immediately instead of waiting for all 5 ping rounds.
async function measureSpeedPing(signal, onInfo) {
  const rtts = [];
  let colo = "";
  for (let i = 0; i < 5; i++) {
    if (signal.aborted) break;
    try {
      const t0   = Date.now();
      const resp = await fetch(CF_TRACE, { cache: "no-store", signal });
      rtts.push(Date.now() - t0);
      if (i === 0) {
        // Cloudflare's trace endpoint doesn't reliably include an ISP org
        // name (confirmed empty for plenty of real connections) — colo (the
        // edge datacenter code) is the one field it does consistently have.
        const text  = await resp.text();
        const coloM = text.match(/^colo=(.+)$/m);
        if (coloM) colo = coloM[1];
        if (onInfo) onInfo({ colo });
      }
    } catch (_) { /* ignore individual failures */ }
    if (i < 4) await sleep(100);
  }
  if (rtts.length === 0) return { ping: 0, jitter: 0, colo: "" };
  const avg    = rtts.reduce((a, b) => a + b, 0) / rtts.length;
  const jitter = rtts.length > 1
    ? rtts.slice(1).reduce((s, r, i) => s + Math.abs(r - rtts[i]), 0) / (rtts.length - 1)
    : 0;
  return { ping: Math.round(avg), jitter: Math.round(jitter), colo };
}

// Cloudflare's `colo` trace field is a standard IATA airport code identifying
// which edge datacenter served the request — map the common ones to a city.
const CF_COLO_CITY = {
  ADD: "Addis Ababa", NBO: "Nairobi", JNB: "Johannesburg", CPT: "Cape Town",
  CAI: "Cairo", LOS: "Lagos", ACC: "Accra", DAR: "Dar es Salaam", KGL: "Kigali",
  MRU: "Port Louis", TUN: "Tunis", CMN: "Casablanca", DJI: "Djibouti",
  LHR: "London", CDG: "Paris", FRA: "Frankfurt", AMS: "Amsterdam", MAD: "Madrid",
  MXP: "Milan", VIE: "Vienna", WAW: "Warsaw", ARN: "Stockholm", CPH: "Copenhagen",
  DUB: "Dublin", ZRH: "Zurich", BRU: "Brussels", LIS: "Lisbon", ATH: "Athens",
  IST: "Istanbul", DXB: "Dubai", DOH: "Doha", RUH: "Riyadh", TLV: "Tel Aviv",
  BOM: "Mumbai", DEL: "Delhi", BLR: "Bengaluru", MAA: "Chennai", CCU: "Kolkata",
  SIN: "Singapore", HKG: "Hong Kong", NRT: "Tokyo", ICN: "Seoul", TPE: "Taipei",
  BKK: "Bangkok", KUL: "Kuala Lumpur", CGK: "Jakarta", MNL: "Manila", SYD: "Sydney",
  MEL: "Melbourne", AKL: "Auckland", JFK: "New York", EWR: "Newark",
  IAD: "Washington D.C.", ATL: "Atlanta", ORD: "Chicago", DFW: "Dallas",
  LAX: "Los Angeles", SJC: "San Jose", SEA: "Seattle", MIA: "Miami",
  YYZ: "Toronto", YVR: "Vancouver", GRU: "São Paulo", GIG: "Rio de Janeiro",
  EZE: "Buenos Aires", SCL: "Santiago", BOG: "Bogotá", LIM: "Lima", MEX: "Mexico City",
};

function resolveColoLocation(colo) {
  if (!colo) return "";
  return CF_COLO_CITY[colo] || `Cloudflare edge (${colo})`;
}

// Shows shimmering placeholders the instant a test starts, before any network
// data has actually arrived — replaced live by updateSpeedNetInfoLive() the
// moment the first ping round resolves (it doesn't wait for all 5 rounds).
function resetSpeedNetInfoSkeleton() {
  const box = document.getElementById("speedNetInfo");
  if (!box) return;
  box.classList.remove("hidden");
  [["speedIspName", "70%"], ["speedIspIp", "50%"], ["speedServerName", "70%"], ["speedServerLoc", "50%"]]
    .forEach(([id, w]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = "";
      el.style.width = w;
      el.classList.add("skeleton", "skeleton-text");
    });
}

function setSpeedNetInfoText(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("skeleton", "skeleton-text");
  el.style.width = "";
  el.textContent = text;
}

// Independent of the ping/colo lookup below — updates the moment ipapi.co
// responds, whether that's before or after the Cloudflare trace resolves.
async function fetchIspInfo(signal) {
  try {
    const res  = await fetch("https://ipapi.co/json/", { cache: "no-store", signal });
    const data = await res.json();
    setSpeedNetInfoText("speedIspName", data.org || "Unknown ISP");
    setSpeedNetInfoText("speedIspIp", data.ip || "—");
  } catch (_) {
    setSpeedNetInfoText("speedIspName", "Unknown ISP");
    setSpeedNetInfoText("speedIspIp", "—");
  }
}

function updateSpeedServerLive(colo) {
  setSpeedNetInfoText("speedServerName", "Cloudflare");
  setSpeedNetInfoText("speedServerLoc", resolveColoLocation(colo) || "—");
}

// Averages the top half of collected samples — filters out TCP slow-start noise
// without needing a minimum absolute speed, so a very slow but real connection
// (a few KB/s or even B/s) still produces a legitimate reading instead of "0".
function averageTopHalf(readings) {
  const sorted = [...readings].sort((a, b) => b - a);
  const top    = sorted.slice(0, Math.ceil(sorted.length / 2));
  return top.reduce((a, b) => a + b) / top.length;
}

// ── Download speed ──
function measureSpeedDownload(onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const t0  = Date.now();
    let lastLoaded = 0, lastTime = t0;
    const readings = [];

    xhr.open("GET", CF_DOWN, true);
    xhr.onprogress = (e) => {
      const now     = Date.now();
      const elapsed = (now - lastTime) / 1000;
      if (elapsed >= 0.25 && e.loaded > lastLoaded) {
        const mbps = ((e.loaded - lastLoaded) * 8) / (1024 * 1024 * elapsed);
        if (mbps > 0) {
          readings.push(mbps);
          const pct = e.lengthComputable && e.total > 0 ? e.loaded / e.total : 0;
          onProgress(mbps, pct);
        }
        lastLoaded = e.loaded;
        lastTime   = now;
      }
    };
    xhr.onload = () => {
      if (readings.length === 0) {
        const elapsed = (Date.now() - t0) / 1000;
        resolve({ mbps: elapsed > 0 ? (26 * 8) / elapsed : 0, readings: [] });
        return;
      }
      resolve({ mbps: averageTopHalf(readings), readings });
    };
    // A very slow connection can legitimately never finish (or reset) within the
    // timeout — as long as we captured at least one real sample, report that
    // instead of failing the whole test outright.
    xhr.onerror = () => {
      if (readings.length > 0) { resolve({ mbps: averageTopHalf(readings), readings }); return; }
      reject(new Error("No internet connection. Check your network."));
    };
    xhr.ontimeout = () => {
      if (readings.length > 0) { resolve({ mbps: averageTopHalf(readings), readings }); return; }
      reject(new Error("Connection is too slow to measure. Try again."));
    };
    xhr.timeout   = 35000;
    signal.addEventListener("abort", () => { xhr.abort(); reject(new Error("Aborted")); });
    xhr.send();
  });
}

// ── Upload speed ──
function measureSpeedUpload(onProgress, signal) {
  return new Promise((resolve, reject) => {
    // 8 MB — big enough that the phase is visible and past TCP slow-start on
    // typical connections (2 MB finishes almost instantly and barely shows).
    const SIZE = 8 * 1024 * 1024;
    const body = "0".repeat(SIZE);
    const xhr  = new XMLHttpRequest();
    const t0   = Date.now();
    let lastLoaded = 0, lastTime = t0;
    const readings = [];

    xhr.open("POST", CF_UP, true);
    xhr.setRequestHeader("Content-Type", "text/plain");
    xhr.upload.onprogress = (e) => {
      const now     = Date.now();
      const elapsed = (now - lastTime) / 1000;
      if (elapsed >= 0.2 && e.loaded > lastLoaded) {
        const mbps = ((e.loaded - lastLoaded) * 8) / (1024 * 1024 * elapsed);
        if (mbps > 0) {
          readings.push(mbps);
          const pct = e.lengthComputable && e.total > 0 ? e.loaded / e.total : 0;
          onProgress(mbps, pct);
        }
        lastLoaded = e.loaded;
        lastTime   = now;
      }
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        if (readings.length > 0) { resolve({ mbps: averageTopHalf(readings), readings }); return; }
        reject(new Error(`Upload test failed (HTTP ${xhr.status}).`));
        return;
      }
      if (readings.length === 0) {
        const elapsed = (Date.now() - t0) / 1000;
        resolve({ mbps: elapsed > 0 ? (SIZE * 8) / (1024 * 1024 * elapsed) : 0, readings: [] });
        return;
      }
      resolve({ mbps: averageTopHalf(readings), readings });
    };
    xhr.onerror = () => {
      if (readings.length > 0) { resolve({ mbps: averageTopHalf(readings), readings }); return; }
      reject(new Error("Upload test failed. Check your network."));
    };
    xhr.ontimeout = () => {
      if (readings.length > 0) { resolve({ mbps: averageTopHalf(readings), readings }); return; }
      reject(new Error("Upload is too slow to measure. Try again."));
    };
    xhr.timeout   = 30000;
    signal.addEventListener("abort", () => { xhr.abort(); reject(new Error("Aborted")); });
    xhr.send(body);
  });
}

function getSpeedRating(mbps) {
  if (mbps >= 200) return { label: "Blazing Fast", color: "#27ae60", emoji: "🚀", sub: "Perfect for 4K streaming & large downloads" };
  if (mbps >= 100) return { label: "Excellent",     color: "#2ecc71", emoji: "⚡", sub: "Perfect for 4K streaming & large downloads" };
  if (mbps >= 25)  return { label: "Good",          color: "#f1c40f", emoji: "✅", sub: "Great for HD video & fast downloads" };
  if (mbps >= 5)   return { label: "Fair",          color: "#f39c12", emoji: "👍", sub: "OK for streaming, may buffer on HD" };
  if (mbps > 0)    return { label: "Poor",          color: "#e74c3c", emoji: "⚠️", sub: "Basic browsing and SD streaming only" };
  return              { label: "—",              color: "#888",    emoji: "❓", sub: "Unable to measure download speed" };
}

async function startSpeedTest() {
  if (speedAbort) speedAbort.abort();
  const abort = new AbortController();
  speedAbort  = abort;

  showSpeedPhase("Active");
  setGaugeValue(0);
  document.getElementById("speedProgressTrack").classList.add("hidden");
  document.getElementById("speedProgressFill").style.width = "0%";
  document.getElementById("speedPhaseLabel").textContent = "Testing Latency…";
  document.getElementById("speedCancelBtn").classList.remove("hidden");
  document.getElementById("speedAgainBtn").classList.add("hidden");
  document.getElementById("speedRating").classList.add("hidden");
  document.getElementById("speedResultPing").textContent   = "—";
  document.getElementById("speedResultJitter").textContent = "";
  document.getElementById("speedResultDown").textContent     = "—";
  document.getElementById("speedResultDownUnit").textContent = "Mbps";
  document.getElementById("speedResultUp").textContent       = "—";
  document.getElementById("speedResultUpUnit").textContent   = "Mbps";
  document.getElementById("speedSignal").innerHTML     = `<p class="speed-detail-pending">Measuring…</p>`;
  document.getElementById("speedDetailDown").innerHTML = `<p class="speed-detail-pending">Waiting for download test…</p>`;
  document.getElementById("speedDetailUp").innerHTML   = `<p class="speed-detail-pending">Waiting for upload test…</p>`;
  resetSpeedNetInfoSkeleton();
  // Independent lookup — updates the ISP card the moment it resolves rather
  // than waiting on (or being blocked by) the ping/download/upload sequence.
  fetchIspInfo(abort.signal);

  try {
    const p = await measureSpeedPing(abort.signal, (info) => updateSpeedServerLive(info.colo));
    if (abort.signal.aborted) return;
    document.getElementById("speedResultPing").textContent   = p.ping;
    document.getElementById("speedResultJitter").textContent = p.jitter > 0 ? `±${p.jitter}ms` : "";

    document.getElementById("speedPhaseLabel").textContent = "DOWNLOAD";
    document.getElementById("speedProgressTrack").classList.remove("hidden");
    setGaugeValue(0);
    const dlReadingsLive = [];
    const dlResult = await measureSpeedDownload((mbps, pct) => {
      setGaugeValue(Math.round(mbps * 10) / 10);
      document.getElementById("speedProgressFill").style.width = Math.min(pct * 100, 100) + "%";
      dlReadingsLive.push(mbps);
      document.getElementById("speedDetailDown").innerHTML = renderDownloadDetailHtml(mbps, dlReadingsLive);
    }, abort.signal);
    if (abort.signal.aborted) return;
    const dl = dlResult.mbps;
    const dlFmt = formatMbpsAuto(dl);
    document.getElementById("speedResultDown").textContent = dlFmt.value;
    document.getElementById("speedResultDownUnit").textContent = dlFmt.unit;
    document.getElementById("speedDetailDown").innerHTML = renderDownloadDetailHtml(dl, dlResult.readings);
    // Ping and download are both known now — the combined signal reading can settle.
    document.getElementById("speedSignal").innerHTML = renderNetworkSignalHtml(p.ping, dl);

    document.getElementById("speedPhaseLabel").textContent = "UPLOAD";
    setGaugeValue(0);
    document.getElementById("speedProgressFill").style.width = "0%";
    let ul = 0;
    let ulReadingsFinal = [];
    let uploadFailed = false;
    try {
      const ulReadingsLive = [];
      const ulResult = await measureSpeedUpload((mbps, pct) => {
        setGaugeValue(Math.round(mbps * 10) / 10);
        document.getElementById("speedProgressFill").style.width = Math.min(pct * 100, 100) + "%";
        ulReadingsLive.push(mbps);
        document.getElementById("speedDetailUp").innerHTML = renderUploadDetailHtml(mbps, ulReadingsLive);
      }, abort.signal);
      ul = ulResult.mbps;
      ulReadingsFinal = ulResult.readings;
    } catch (e) {
      // Upload failure is non-fatal — ping/download results still stand — but
      // show it plainly instead of a silent, misleading "0".
      uploadFailed = true;
      console.warn("Upload speed test failed:", e);
    }
    if (abort.signal.aborted) return;
    const ulFmt = formatMbpsAuto(uploadFailed ? 0 : ul);
    document.getElementById("speedResultUp").textContent     = uploadFailed ? "—" : ulFmt.value;
    document.getElementById("speedResultUpUnit").textContent = uploadFailed ? "Mbps" : ulFmt.unit;
    document.getElementById("speedDetailUp").innerHTML = uploadFailed
      ? `<p class="speed-detail-pending">Upload test failed.</p>`
      : renderUploadDetailHtml(ul, ulReadingsFinal);

    // Test finished — the gauge/charts simply stop updating here rather than
    // being replaced by a separate "done" view, so the last live reading stays
    // on screen as the result.
    document.getElementById("speedPhaseLabel").textContent = "Done!";
    document.getElementById("speedProgressTrack").classList.add("hidden");
    document.getElementById("speedCancelBtn").classList.add("hidden");
    document.getElementById("speedAgainBtn").classList.remove("hidden");
    document.getElementById("speedRating").classList.remove("hidden");

    renderSpeedResults(dl);
    recordSpeedHistory(dl, uploadFailed ? 0 : ul, p.ping, p.jitter);
  } catch (e) {
    if (abort.signal.aborted) return;
    document.getElementById("speedErrorMsg").textContent = e.message || "Speed test failed.";
    showSpeedPhase("Error");
  }
}

function renderSpeedResults(dlMbps) {
  const rating = getSpeedRating(dlMbps);
  document.getElementById("speedRating").innerHTML = `
    <span class="speed-rating-emoji">${rating.emoji}</span>
    <div>
      <div class="speed-rating-label" style="color:${rating.color}">${rating.label}</div>
      <div class="speed-rating-sub">${rating.sub}</div>
    </div>
  `;
  renderSpeedNetworkUsage();
}

function renderSpeedNetworkUsage() {
  const box    = document.getElementById("speedActiveDownloads");
  const active = cachedDownloads.filter(d => d.status === "downloading");
  const header = `<div style="font-size:11px;color:var(--text-muted);letter-spacing:0.5px;font-weight:700;margin-bottom:8px">NETWORK USAGE</div>`;
  if (active.length === 0) {
    box.innerHTML = header + `<div class="speed-usage-empty">No active downloads right now.</div>`;
    return;
  }
  const rows = active.map(d => `
    <div class="speed-usage-row">
      <span class="speed-usage-name" title="${escHtml(d.name || d.url || "")}">${escHtml(d.name || d.url || "Unknown")}</span>
      <span class="speed-usage-meta">${Math.round(d.progress || 0)}% · ${formatSpeed(d.speed) || "—"}</span>
    </div>
  `).join("");
  box.innerHTML = header + rows;
}

// ══════════════════════════════════════════════════
// Speed Test — Detailed Result (network signal + per-metric breakdown)
// ══════════════════════════════════════════════════
function formatMbpsAuto(mbps) {
  if (!mbps || mbps <= 0) return { value: "—", unit: "Mb/s" };
  const bps = mbps * 125000; // 1 Mbps = 125,000 bytes/s
  if (bps < 1024)              return { value: bps.toFixed(0),                    unit: "B/s"  };
  if (bps < 1048576)           return { value: (bps / 1024).toFixed(0),           unit: "KB/s" };
  if (bps < 1073741824)        return { value: (bps / 1048576).toFixed(1),        unit: "MB/s" };
  return                              { value: (bps / 1073741824).toFixed(2),     unit: "GB/s" };
}

function buildWaveSvg(readings, color, height = 46) {
  const width = 100;
  if (!readings || readings.length < 2) {
    return `<div class="speed-wave-wrap"><svg viewBox="0 0 ${width} ${height}" class="speed-wave-svg" preserveAspectRatio="none"></svg></div>`;
  }
  const recent = readings.slice(-80);
  const max    = Math.max(...recent, 0.001);
  const stepX  = width / (recent.length - 1);
  const pts    = recent.map((v, i) => ({
    x: i * stepX,
    y: height - (v / max) * (height - 4) - 2,
  }));

  let line = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const midX = (pts[i - 1].x + pts[i].x) / 2;
    const midY = (pts[i - 1].y + pts[i].y) / 2;
    line += ` Q ${pts[i - 1].x.toFixed(1)},${pts[i - 1].y.toFixed(1)} ${midX.toFixed(1)},${midY.toFixed(1)}`;
  }
  line += ` L ${pts[pts.length - 1].x.toFixed(1)},${pts[pts.length - 1].y.toFixed(1)}`;
  const fill = `${line} L ${pts[pts.length - 1].x.toFixed(1)},${height} L ${pts[0].x.toFixed(1)},${height} Z`;

  const peakFmt = formatMbpsAuto(max);
  return `
    <div class="speed-wave-wrap">
      <span class="speed-wave-peak">peak ${peakFmt.value} ${peakFmt.unit}</span>
      <svg viewBox="0 0 ${width} ${height}" class="speed-wave-svg" preserveAspectRatio="none">
        <path d="${fill}" fill="${color}" fill-opacity="0.18" stroke="none"></path>
        <path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round"></path>
      </svg>
    </div>
  `;
}

function renderNetworkSignalHtml(pingMs, dlMbps) {
  // Combine latency and actual throughput — a fast ping on a bandwidth-starved
  // connection shouldn't read as "Strong" while the rating above says "Poor".
  const pingPct  = pingMs <= 0 ? 50 : pingMs < 50 ? 100 : pingMs < 150 ? 50 : 0;
  const speedPct = dlMbps >= 25 ? 100 : dlMbps >= 5 ? 50 : 0;
  const pct      = Math.min(pingPct, speedPct);
  const label    = pct === 100 ? "Strong" : pct === 50 ? "Normal" : "Weak";
  return `
    <div class="speed-signal-track">
      <div class="speed-signal-fill" style="width:${pct}%"></div>
      ${[0, 50, 100].map(d => `<div class="speed-signal-dot${d === pct ? " speed-signal-dot--active" : ""}" style="left:${d}%"></div>`).join("")}
    </div>
    <div class="speed-signal-labels">
      <span${label === "Weak"   ? ' class="speed-signal-label--active"' : ""}>Weak</span>
      <span${label === "Normal" ? ' class="speed-signal-label--active"' : ""}>Normal</span>
      <span${label === "Strong" ? ' class="speed-signal-label--active"' : ""}>Strong</span>
    </div>
  `;
}

// Called on every progress tick during the download/upload phases (live update)
// as well as once more with the final averaged value when each phase finishes.
function renderDownloadDetailHtml(mbps, readings) {
  const fmt = formatMbpsAuto(mbps);
  return `
    <div class="speed-detail-top-row">
      <span class="speed-detail-icon">⬇️</span>
      <span class="speed-detail-label">Download</span>
      <span class="speed-detail-data-used">Data Used 25 MB</span>
    </div>
    <div class="speed-detail-big-val">${fmt.value}<span class="speed-detail-big-unit"> ${fmt.unit}</span></div>
    ${buildWaveSvg(readings, "#C9A227")}
  `;
}

function renderUploadDetailHtml(mbps, readings) {
  const fmt = formatMbpsAuto(mbps);
  return `
    <div class="speed-detail-top-row">
      <span class="speed-detail-icon">⬆️</span>
      <span class="speed-detail-label">Upload</span>
      <span class="speed-detail-data-used">Data Used 8 MB</span>
    </div>
    <div class="speed-detail-big-val">${fmt.value}<span class="speed-detail-big-unit"> ${fmt.unit}</span></div>
    ${buildWaveSvg(readings, "#27AE60")}
  `;
}

// ══════════════════════════════════════════════════
// Speed Test — History (persisted server-side, newest first, capped at 30)
// ══════════════════════════════════════════════════
async function recordSpeedHistory(dl, ul, ping, jitter) {
  try {
    const res  = await fetch("/api/speed-history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ts: Date.now(), dl, ul, ping, jitter }),
    });
    const data = await res.json();
    renderSpeedHistoryTable(data.history || []);
  } catch (_) {}
}

async function loadSpeedHistory() {
  try {
    const res  = await fetch("/api/speed-history");
    const data = await res.json();
    renderSpeedHistoryTable(data.history || []);
  } catch (_) {
    renderSpeedHistoryTable([]);
  }
}

function formatHistoryDate(ts) {
  const d   = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  return `${d.getDate()}-${d.toLocaleString("en", { month: "short" })}`;
}

function renderSpeedHistoryTable(history) {
  const box = document.getElementById("speedHistory");
  if (!box) return;
  if (!history || history.length === 0) {
    box.innerHTML = `<p class="speed-history-empty">No history yet.<br>Run a test to start recording.</p>`;
    return;
  }
  const headerRow = `
    <div class="speed-history-row speed-history-row--head">
      <span class="speed-history-header-cell">Date</span>
      <span class="speed-history-header-cell">Download</span>
      <span class="speed-history-header-cell">Upload</span>
      <span class="speed-history-header-cell">Ping</span>
    </div>`;
  const rows = history.map(rec => {
    const dl = formatMbpsAuto(rec.dl);
    const ul = formatMbpsAuto(rec.ul);
    return `
      <div class="speed-history-row">
        <span class="speed-history-cell">${formatHistoryDate(rec.ts)}</span>
        <span class="speed-history-cell speed-history-cell--gold">${dl.value} ${dl.unit}</span>
        <span class="speed-history-cell speed-history-cell--green">${ul.value} ${ul.unit}</span>
        <span class="speed-history-cell">${rec.ping}ms</span>
      </div>`;
  }).join("");
  box.innerHTML = headerRow + rows;
}

document.getElementById("speedTestBtn").addEventListener("click", openSpeedTest);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSpeedTest(); });

// ══════════════════════════════════════════════════
// Live internet speed — shown in the header, refreshed continuously
// ══════════════════════════════════════════════════
async function measureLiveSpeed() {
  const controller = new AbortController();
  const killTimer  = setTimeout(() => controller.abort(), 8000);
  try {
    const t0  = Date.now();
    const res = await fetch(CF_LIVE_DOWN, { cache: "no-store", signal: controller.signal });
    const buf = await res.arrayBuffer();
    const elapsed = (Date.now() - t0) / 1000;
    if (elapsed <= 0 || buf.byteLength === 0) return null;
    return Math.round(((buf.byteLength * 8) / (1024 * 1024 * elapsed)) * 10) / 10;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(killTimer);
  }
}

async function refreshLiveSpeedPill() {
  const pill = document.getElementById("statusPill");
  if (!pill) return;
  // Don't compete with an active full Speed Test run — it already shows a live gauge.
  if (speedAbort) return;
  const mbps = await measureLiveSpeed();
  if (speedAbort) return; // a real test may have started while we were probing
  pill.textContent = mbps === null ? "📶 Offline?" : `📶 ${mbps >= 10 ? mbps.toFixed(0) : mbps.toFixed(1)} Mbps`;
}

function startLiveSpeedMonitor() {
  refreshLiveSpeedPill();
  setInterval(refreshLiveSpeedPill, 30000);
}

// ══════════════════════════════════════════════════
loadDrives();
refreshAllQueues();
startQueuePolling();
loadCookieStatus();
startLiveSpeedMonitor();
