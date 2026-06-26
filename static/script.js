// ══════════════════════════════════════════════════
// State
// ══════════════════════════════════════════════════
let currentData = null;
let selectedVideoFormat = null;
let selectedAudioFormat = null;
let playlistData = [];
let skippedIndices = new Set();
let othersAnalyzedData = null;
let fetchedUrl = "";
let queuePollInterval = null;
const selectedSessions = new Set(); // session IDs checked via queue-item checkboxes

// ══════════════════════════════════════════════════
// DOM — YouTube
// ══════════════════════════════════════════════════
const globalUrlInput = document.getElementById("globalUrlInput");
const globalDownloadBtn = document.getElementById("globalDownloadBtn");
const globalTorrentFileInput = document.getElementById("globalTorrentFileInput");
const infoSection = document.getElementById("infoSection");
const videoInfo = document.getElementById("videoInfo");
const typeSection = document.getElementById("typeSection");
const qualitySection = document.getElementById("qualitySection");
const downloadSection = document.getElementById("downloadSection");
const videoQualityContainer = document.getElementById("videoQualityContainer");
const videoFormats = document.getElementById("videoFormats");
const audioFormats = document.getElementById("audioFormats");
const downloadBtn = document.getElementById("downloadBtn");
const progressSection = document.getElementById("progressSection");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");
const playlistSection = document.getElementById("playlistSection");
const playlistVideosContainer = document.getElementById("playlistVideos");

// ══════════════════════════════════════════════════
// DOM — Shared / other tabs
// ══════════════════════════════════════════════════
const partitionSelect = document.getElementById("partitionSelect");
const savePartitionBtn = document.getElementById("savePartitionBtn");
const afriwayPathPreview = document.getElementById("afriwayPathPreview");
const downloadOthersBtn = document.getElementById("downloadOthersBtn");

// ══════════════════════════════════════════════════
// Tabs
// ══════════════════════════════════════════════════
function switchToTab(tabId) {
  document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
  const btn = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
  if (btn) btn.classList.add("active");
  const pane = document.getElementById(`pane-${tabId}`);
  if (pane) pane.classList.add("active");
}

document.querySelectorAll(".nav-item[data-tab]").forEach(btn => {
  btn.addEventListener("click", () => switchToTab(btn.dataset.tab));
});

function isYouTubeUrl(url) {
  return /(?:youtube\.com|youtu\.be)/i.test(url);
}
function isTorrentUrl(url) {
  return url.startsWith("magnet:") || /\.torrent(\?|$)/i.test(url);
}

// ══════════════════════════════════════════════════
// Download location — Afriway partition selector
// ══════════════════════════════════════════════════
async function loadDrives() {
  try {
    const res = await fetch("/api/drives");
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
    const res = await fetch("/api/get-partition");
    const data = await res.json();
    if (partitionSelect && data.partition) {
      partitionSelect.value = data.partition;
    }
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
      const res = await fetch("/api/set-partition", {
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
    } catch (e) {
      showError(e.message);
    }
  });
}

// ══════════════════════════════════════════════════
// Queue polling (every 2s)
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
    renderQueue("queue-all",     downloads, null,       null);
    renderQueue("queue-youtube", downloads, "youtube",  null);
    renderQueue("queue-torrent", downloads, "torrent",  null);
    renderQueue("queue-others",  downloads, null,       ["direct", "video"]);
  } catch (_) {}
}

function renderQueue(queueId, downloads, typeFilter, typesArray) {
  const container = document.getElementById(queueId);
  if (!container) return;

  const searchIdMap = {
    "queue-all":     "search-all",
    "queue-youtube": "search-youtube",
    "queue-torrent": "search-torrent",
    "queue-others":  "search-others"
  };
  const searchEl = document.getElementById(searchIdMap[queueId]);
  const searchVal = (searchEl?.value || "").toLowerCase();

  let filtered = [...downloads];

  if (typeFilter) filtered = filtered.filter(d => d.type === typeFilter);
  if (typesArray) filtered = filtered.filter(d => typesArray.includes(d.type));

  if (queueId === "queue-all") {
    const typeDropdown  = document.getElementById("filter-type-all")?.value;
    const statusDropdown = document.getElementById("filter-status-all")?.value;
    if (typeDropdown)   filtered = filtered.filter(d => d.type === typeDropdown);
    if (statusDropdown) filtered = filtered.filter(d => d.status === statusDropdown);
  }

  if (searchVal) {
    filtered = filtered.filter(d =>
      (d.name || "").toLowerCase().includes(searchVal) ||
      (d.url  || "").toLowerCase().includes(searchVal)
    );
  }

  if (filtered.length === 0) {
    container.innerHTML = '<div class="queue-empty">No downloads here yet.</div>';
    return;
  }

  container.innerHTML = filtered.map(d => buildQueueItem(d)).join("");
}

function buildQueueItem(d) {
  const icons = { youtube: "▶️", torrent: "🔗", direct: "📦", video: "🎬" };
  const icon = icons[d.type] || "📥";
  const name = d.name || d.url || "Unknown";
  const sid  = d.session_id;
  const typeBadge   = `<span class="type-badge type-badge--${d.type || "direct"}">${d.type || "file"}</span>`;
  const statusBadge = `<span class="status-badge status-badge--${d.status}">${d.status}</span>`;
  const progressPct = d.progress || 0;
  const showBar     = d.status === "downloading" || d.status === "paused";

  let folderBtn = "";
  if (d.status === "completed" && d.filepath) {
    // Use data-filepath (not an inline JS string) so Windows backslashes aren't eaten as escape sequences
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
        <div class="queue-item-name" title="${escHtml(name)}">${escHtml(name)}</div>
        <div class="queue-item-meta">${typeBadge} ${statusBadge}${pauseBtn}${folderBtn}${copyBtn}</div>
        ${showBar ? `
          <div class="queue-item-progress-bar">
            <div class="queue-item-progress-fill" style="width:${progressPct}%"></div>
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
    const res = await fetch("/api/show-in-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filepath })
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.error === "file_not_found") {
        openMissingModal(filepath);
      } else {
        showError(data.error || "Could not open folder");
      }
    }
  } catch (e) {
    showError(e.message);
  }
}

function openMissingModal(filepath) {
  swalDark.fire({
    icon: "warning",
    title: "File Not Found",
    html: `
      <p style="margin:0 0 12px;color:#d4c4b0;font-size:14px">The file can no longer be found at its saved location:</p>
      <code style="display:block;background:rgba(255,255,255,0.05);border:1px solid rgba(212,175,55,0.22);
        border-radius:8px;padding:10px 14px;font-size:12px;color:#D4AF37;word-break:break-all;
        text-align:left;font-family:Consolas,Monaco,monospace">${escHtml(filepath)}</code>
      <p style="margin:12px 0 0;color:#d4c4b0;font-size:14px">It may have been moved, renamed, or deleted.</p>
    `,
  });
}

// ══════════════════════════════════════════════════
// Pause / Resume controls
// ══════════════════════════════════════════════════
function toggleSessionSelect(sid, checked) {
  if (checked) selectedSessions.add(sid);
  else selectedSessions.delete(sid);
}

function toggleSelectAll(queueId, checked) {
  const container = document.getElementById(queueId);
  if (!container) return;
  container.querySelectorAll(".queue-item-check").forEach(cb => {
    cb.checked = checked;
    if (checked) selectedSessions.add(cb.dataset.sid);
    else selectedSessions.delete(cb.dataset.sid);
  });
}

async function pauseDownload(sid) {
  try {
    await fetch(`/api/pause/${sid}`, { method: "POST" });
    refreshAllQueues();
  } catch (e) { showError(e.message); }
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
  for (const sid of ids) {
    try { await fetch(`/api/pause/${sid}`, { method: "POST" }); } catch (_) {}
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
  } catch (e) {
    showError("Could not copy to clipboard: " + e.message);
  }
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
    const res = await fetch(`/api/remove/${sid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete_file: deleteFile })
    });
    const data = await res.json();
    if (!res.ok) { showError(data.error || "Could not remove"); return; }
    if (deleteFile) showSuccess(data.deleted ? "File deleted and removed from list." : "Removed from list (file was already gone).");
    else showSuccess("Removed from list.");
    selectedSessions.delete(sid);
    refreshAllQueues();
  } catch (e) { showError(e.message); }
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

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Live search wiring
["search-all", "search-youtube", "search-torrent", "search-others"].forEach(id => {
  document.getElementById(id)?.addEventListener("input", refreshAllQueues);
});
["filter-type-all", "filter-status-all"].forEach(id => {
  document.getElementById(id)?.addEventListener("change", refreshAllQueues);
});

// ══════════════════════════════════════════════════
// Torrent tab
// ══════════════════════════════════════════════════

const torrentFileInput = document.getElementById("torrentFileInput");
const torrentFileName  = document.getElementById("torrentFileName");

torrentFileInput.addEventListener("change", () => {
  const file = torrentFileInput.files[0];
  if (!file) return;
  torrentFileName.textContent = file.name;
  document.querySelector("label[for='torrentFileInput']").classList.add("has-file");
  uploadTorrentFile(file);
});

async function uploadTorrentFile(file) {
  const label = document.querySelector("label[for='torrentFileInput']");
  label.textContent = "⏳ Uploading...";
  try {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/upload-torrent", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed");
    const section = document.getElementById("torrentInfoSection");
    const body    = document.getElementById("torrentInfoBody");
    section.classList.remove("hidden");
    body.innerHTML = `
      <div class="info-item">
        <span class="info-label">File:</span>
        <span class="info-value">${escHtml(file.name)}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Status:</span>
        <span class="status-badge status-badge--downloading">Downloading</span>
      </div>
    `;
    startQueuePolling();
  } catch (e) {
    showError(e.message);
    torrentFileName.textContent = "No file selected";
    document.querySelector("label[for='torrentFileInput']").classList.remove("has-file");
  } finally {
    label.textContent = "📂 Choose .torrent file";
    torrentFileInput.value = "";
  }
}

async function startTorrentDownload() {
  const url = globalUrlInput.value.trim();
  if (!url) { showError("Please enter a URL"); return; }
  switchToTab("torrent");

  setLoading(globalDownloadBtn, true);
  try {
    const res = await fetch("/api/download-torrent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Torrent failed");
    globalUrlInput.value = "";
    const section = document.getElementById("torrentInfoSection");
    const body = document.getElementById("torrentInfoBody");
    section.classList.remove("hidden");
    body.innerHTML = `
      <div class="info-item">
        <span class="info-label">Session:</span>
        <span class="info-value">${escHtml(data.session_id)}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Status:</span>
        <span class="status-badge status-badge--downloading">Downloading</span>
      </div>
    `;
    startQueuePolling();
  } catch (e) {
    showError(e.message);
  } finally {
    setLoading(globalDownloadBtn, false);
  }
}

// ══════════════════════════════════════════════════
// Others tab
// ══════════════════════════════════════════════════
downloadOthersBtn.addEventListener("click", startOthersDownload);

async function analyzeOthersUrl() {
  const url = globalUrlInput.value.trim();
  if (!url) { showError("Please enter a URL"); return; }
  switchToTab("others");

  setLoading(globalDownloadBtn, true);
  const section = document.getElementById("othersInfoSection");
  const body = document.getElementById("othersInfoBody");
  section.classList.add("hidden");
  othersAnalyzedData = null;
  try {
    const res = await fetch("/api/analyze-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Analysis failed");
    othersAnalyzedData = data;
    const rows = [];
    if (data.filename) rows.push(`<div class="info-item"><span class="info-label">File:</span><span class="info-value">${escHtml(data.filename)}</span></div>`);
    if (data.title && data.title !== data.filename) rows.push(`<div class="info-item"><span class="info-label">Title:</span><span class="info-value">${escHtml(data.title)}</span></div>`);
    if (data.size)     rows.push(`<div class="info-item"><span class="info-label">Size:</span><span class="info-value">${escHtml(data.size)}</span></div>`);
    rows.push(`<div class="info-item"><span class="info-label">Type:</span><span class="type-badge type-badge--${escHtml(data.type)}">${escHtml(data.type)}</span></div>`);
    body.innerHTML = `<div class="video-info">${rows.join("")}</div>`;
    section.classList.remove("hidden");
  } catch (e) {
    showError(e.message);
  } finally {
    setLoading(globalDownloadBtn, false);
  }
}

async function startOthersDownload() {
  if (!othersAnalyzedData) return;
  const url = globalUrlInput.value.trim();
  setLoading(downloadOthersBtn, true);
  try {
    const endpoint = othersAnalyzedData.type === "video"
      ? "/api/download-video-best"
      : "/api/download-direct";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Download failed");
    startQueuePolling();
    showSuccess("Download started! Track progress in the queue below.");
  } catch (e) {
    showError(e.message);
  } finally {
    setLoading(downloadOthersBtn, false);
  }
}

// ══════════════════════════════════════════════════
// Global download handler
// ══════════════════════════════════════════════════
function handleGlobalDownload() {
  const url = globalUrlInput.value.trim();
  if (!url) { showError("Please enter a URL"); return; }
  if (isYouTubeUrl(url)) fetchVideoInfo();
  else if (isTorrentUrl(url)) startTorrentDownload();
  else analyzeOthersUrl();
}

globalDownloadBtn.addEventListener("click", handleGlobalDownload);
globalUrlInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") handleGlobalDownload();
});

globalTorrentFileInput.addEventListener("change", () => {
  const file = globalTorrentFileInput.files[0];
  if (!file) return;
  globalTorrentFileInput.value = "";
  switchToTab("torrent");
  const torrentFileName = document.getElementById("torrentFileName");
  if (torrentFileName) torrentFileName.textContent = file.name;
  const tabLabel = document.querySelector("label[for='torrentFileInput']");
  if (tabLabel) tabLabel.classList.add("has-file");
  uploadTorrentFile(file);
});

// ══════════════════════════════════════════════════
// YouTube — fetch and progressive display
// ══════════════════════════════════════════════════

document.querySelectorAll('input[name="downloadType"]').forEach((radio) => {
  radio.addEventListener("change", handleDownloadTypeChange);
});

downloadBtn.addEventListener("click", startDownload);

async function fetchVideoInfo() {
  const url = globalUrlInput.value.trim();
  if (!url) { showError("Please enter a URL"); return; }
  fetchedUrl = url;
  switchToTab("youtube");

  setLoading(globalDownloadBtn, true);
  skippedIndices.clear();
  currentData = null;
  selectedVideoFormat = null;
  selectedAudioFormat = null;

  progressSection.classList.add("hidden");
  playlistSection.classList.add("hidden");
  showSkeletonStructure();

  try {
    const infoResponse = await fetch("/api/fetch-info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const infoData = await infoResponse.json();
    if (!infoResponse.ok) throw new Error(infoData.error || "Failed to fetch video info");

    currentData = infoData;
    displayVideoInfo(infoData);

    if (infoData.is_playlist && infoData.videos) {
      playlistData = infoData.videos;
      displayPlaylistVideos(infoData.videos);
      playlistSection.classList.remove("hidden");
    }

    if (infoData.formats_ready) {
      displayFormats(infoData);
      downloadBtn.disabled = false;
      setLoading(globalDownloadBtn, false);
    } else {
      const firstVideoUrl = infoData.is_playlist && infoData.videos.length > 0
        ? infoData.videos[0].url : null;
      const formatsResponse = await fetch("/api/fetch-formats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, is_playlist: infoData.is_playlist, first_video_url: firstVideoUrl }),
      });
      const formatsData = await formatsResponse.json();
      if (!formatsResponse.ok) throw new Error(formatsData.error || "Failed to fetch formats");
      currentData = { ...currentData, ...formatsData };
      displayFormats(formatsData);
      downloadBtn.disabled = false;
      setLoading(globalDownloadBtn, false);
    }
  } catch (error) {
    showError(error.message);
    hideAllSections();
    setLoading(globalDownloadBtn, false);
  }
}

function showSkeletonStructure() {
  const skeletonItems = `
    <div class="skeleton skeleton-format-item"></div>
    <div class="skeleton skeleton-format-item"></div>
    <div class="skeleton skeleton-format-item"></div>
  `;
  videoInfo.innerHTML = `
    <div class="info-item">
      <div class="skeleton skeleton-icon"></div>
      <span class="info-label">Title:</span>
      <div class="skeleton skeleton-text" style="width:60%"></div>
    </div>
    <div class="info-item">
      <div class="skeleton skeleton-icon"></div>
      <span class="info-label">Type:</span>
      <div class="skeleton skeleton-text" style="width:30%"></div>
    </div>
  `;
  infoSection.classList.remove("hidden");
  typeSection.classList.remove("hidden");
  videoFormats.innerHTML = skeletonItems;
  audioFormats.innerHTML = skeletonItems;
  qualitySection.classList.remove("hidden");
  downloadBtn.disabled = true;
  downloadSection.classList.remove("hidden");
}

function displayPlaylistVideos(videos) {
  playlistVideosContainer.innerHTML = "";
  videos.forEach((video) => {
    const videoItem = document.createElement("div");
    videoItem.className = "playlist-video-item";
    videoItem.dataset.index = video.index;
    const duration = formatDuration(video.duration);
    videoItem.innerHTML = `
      <div class="playlist-video-checkbox">
        <input type="checkbox" id="video-${video.index}" checked>
      </div>
      <div class="playlist-video-info">
        <div class="playlist-video-number">${video.index}</div>
        <div class="playlist-video-details">
          <div class="playlist-video-title">${escHtml(video.title)}</div>
          <div class="playlist-video-duration">${duration}</div>
        </div>
      </div>
    `;
    const checkbox = videoItem.querySelector('input[type="checkbox"]');
    checkbox.addEventListener("change", (e) => {
      if (e.target.checked) {
        skippedIndices.delete(video.index);
        videoItem.classList.remove("skipped");
      } else {
        skippedIndices.add(video.index);
        videoItem.classList.add("skipped");
      }
      updateDownloadCount();
    });
    playlistVideosContainer.appendChild(videoItem);
  });
  updateDownloadCount();
}

function formatDuration(seconds) {
  if (!seconds) return "Unknown";
  const hours   = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs    = seconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function updateDownloadCount() {
  if (!currentData || !currentData.videos) return;
  const totalVideos  = currentData.videos.length;
  const selectedCount = totalVideos - skippedIndices.size;
  const countElement = document.getElementById("selectedCount");
  if (countElement) countElement.textContent = `${selectedCount} of ${totalVideos} videos selected`;
}

function selectAllVideos() {
  skippedIndices.clear();
  document.querySelectorAll(".playlist-video-item").forEach((item) => {
    item.querySelector('input[type="checkbox"]').checked = true;
    item.classList.remove("skipped");
  });
  updateDownloadCount();
}

function deselectAllVideos() {
  document.querySelectorAll(".playlist-video-item").forEach((item) => {
    const index = parseInt(item.dataset.index);
    skippedIndices.add(index);
    item.querySelector('input[type="checkbox"]').checked = false;
    item.classList.add("skipped");
  });
  updateDownloadCount();
}

function displayVideoInfo(data) {
  const playlistBadge = data.is_playlist
    ? `<span class="badge">${data.video_count} videos</span>` : "";
  videoInfo.innerHTML = `
    <div class="info-item">
      <svg class="info-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path>
        <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
      </svg>
      <span class="info-label">Title:</span>
      <span class="info-value">${escHtml(data.title)}</span>
    </div>
    <div class="info-item">
      <svg class="info-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"></path>
      </svg>
      <span class="info-label">Type:</span>
      <span class="info-value">
        ${data.is_playlist ? "Playlist" : "Single Video"}
        ${playlistBadge}
      </span>
    </div>
  `;
}

function displayFormats(data) {
  videoFormats.innerHTML = "";
  data.video_formats.forEach((format, index) => {
    videoFormats.appendChild(createFormatItem(format, "video", index));
  });
  audioFormats.innerHTML = "";
  data.audio_formats.forEach((format, index) => {
    audioFormats.appendChild(createFormatItem(format, "audio", index));
  });
  if (data.video_formats.length > 0) selectFormat(videoFormats.children[0], data.video_formats[0], "video");
  if (data.audio_formats.length > 0) selectFormat(audioFormats.children[0], data.audio_formats[0], "audio");
}

function createFormatItem(format, type, index) {
  const div = document.createElement("div");
  div.className = `format-item format-item--${type}`;
  const detail = type === "video" ? format.res : `${Math.round(format.abr)}kbps`;
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
  const container = type === "video" ? videoFormats : audioFormats;
  container.querySelectorAll(".format-item").forEach(item => item.classList.remove("selected"));
  element.classList.add("selected");
  if (type === "video") selectedVideoFormat = format.id;
  else selectedAudioFormat = format.id;
}

function handleDownloadTypeChange(e) {
  if (e.target.value === "audio") videoQualityContainer.style.display = "none";
  else videoQualityContainer.style.display = "block";
}

async function startDownload() {
  const downloadType = document.querySelector('input[name="downloadType"]:checked').value;
  if (!selectedAudioFormat) { showError("Please select an audio quality"); return; }
  if (downloadType === "video" && !selectedVideoFormat) { showError("Please select a video quality"); return; }

  setLoading(downloadBtn, true);
  progressSection.classList.remove("hidden");

  try {
    const response = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: fetchedUrl,
        download_type: downloadType,
        video_format_id: selectedVideoFormat,
        audio_format_id: selectedAudioFormat,
        is_playlist: currentData.is_playlist,
        skip_indices: Array.from(skippedIndices),
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to start download");

    startQueuePolling();
    pollDownloadStatus(data.session_id);
  } catch (error) {
    showError(error.message);
    setLoading(downloadBtn, false);
    progressSection.classList.add("hidden");
  }
}

async function pollDownloadStatus(sessionId) {
  const interval = setInterval(async () => {
    try {
      const response = await fetch(`/api/download-status/${sessionId}`);
      const data = await response.json();
      if (!response.ok) throw new Error("Failed to get download status");

      progressFill.style.width = `${data.progress}%`;
      progressText.textContent = data.message;

      if (data.status === "completed") {
        clearInterval(interval);
        setLoading(downloadBtn, false);
        showSuccess("Download completed successfully! Check your downloads folder.");
        setTimeout(() => {
          progressSection.classList.add("hidden");
          progressFill.style.width = "0%";
        }, 3000);
      } else if (data.status === "error") {
        clearInterval(interval);
        setLoading(downloadBtn, false);
        showError(data.message);
      }
    } catch (error) {
      clearInterval(interval);
      setLoading(downloadBtn, false);
      showError(error.message);
    }
  }, 1000);
}

// ══════════════════════════════════════════════════
// Utilities
// ══════════════════════════════════════════════════
function setLoading(button, isLoading) {
  const btnText = button.querySelector(".btn-text");
  const spinner = button.querySelector(".spinner");
  if (isLoading) {
    btnText.classList.add("hidden");
    spinner.classList.remove("hidden");
    button.disabled = true;
  } else {
    btnText.classList.remove("hidden");
    spinner.classList.add("hidden");
    button.disabled = false;
  }
}

function hideAllSections() {
  infoSection.classList.add("hidden");
  typeSection.classList.add("hidden");
  qualitySection.classList.add("hidden");
  downloadSection.classList.add("hidden");
  progressSection.classList.add("hidden");
  playlistSection.classList.add("hidden");
  downloadBtn.disabled = false;
}

// ══════════════════════════════════════════════════
// SweetAlert2 — themed helpers
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

function showError(message) {
  swalDark.fire({ icon: "error", title: "Error", text: message });
}

function showSuccess(message) {
  swalToast.fire({ icon: "success", title: message });
}

// ══════════════════════════════════════════════════
// Init — restore queue state immediately on page load / refresh
// ══════════════════════════════════════════════════
loadDrives();
refreshAllQueues();   // show persisted downloads right away without waiting 2s
startQueuePolling();
