# Afriway Downloader

> A fast, all-in-one download manager built with Python and Flask, wrapped in a native desktop shell — inspired by the spirit of Africa. Download YouTube videos and playlists (in parallel, with independent video/audio control), torrents, direct files, and videos from 1,000+ sites, run a Cloudflare-powered speed test, and manage free disk space — all from one themed desktop app. No subscriptions, no ads.

<p align="center">
  <img src="static/AfriwayLogo.webp" width="120" alt="Afriway Logo" />
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-0A66C2">
  <img alt="Python" src="https://img.shields.io/badge/python-3.10%2B-3776AB?logo=python&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-C9A227">
</p>

---

## Features

### Download Modes

| Tab | What you can download |
|---|---|
| **YouTube** | Videos & playlists. Pick a video quality and/or an audio quality independently — download video+audio merged, audio-only, or both as separate files in one go |
| **Torrent** | Magnet links, `.torrent` URLs, or upload a `.torrent` file directly (via aria2c) |
| **Others** | Direct files (`.exe`, `.zip`, images…) and videos from 1,000+ sites via yt-dlp |
| **All Downloads** | Unified queue with live search, type/status filters, and real-time progress |

### YouTube Playlists — Downloaded in Parallel

Playlists no longer download one video at a time. Up to 4 videos download concurrently, each tracked independently:

- Click a playlist's name in the queue to open a live per-video progress view (index, title, percentage, speed, status)
- Aggregate progress and combined speed shown on the main queue item
- Skip individual videos before starting; completed videos are clickable to open the file directly
- A failed video no longer silently reports the whole playlist as "completed" — genuine errors surface as errors, with per-video retry context preserved

### Speed Test

A Cloudflare-powered network speed test, built into the app (**Speed Test** button in the header) — starts testing immediately when opened, no extra click needed:

- Ping + jitter, download, and upload — measured in sequence on an animated golden gauge with a non-linear 0–1000 Mbps scale, matching how real-world connection speeds actually cluster at the low end
- Everything updates live while the test runs — the gauge, the numbers, and the charts all animate in real time and simply stop moving when the test finishes, instead of being swapped out for a separate results screen
- **Detailed Result** — a Network Signal indicator (combines ping *and* measured throughput, so a fast-but-throttled connection can't misleadingly show "Strong"), plus live sparkline charts for download and upload with peak values labeled
- **History** — every result is saved (date, download, upload, ping) in a table, capped at the last 30 runs
- Your ISP name/IP and the Cloudflare edge server location used are shown, each loading independently the moment it resolves rather than waiting on the other
- Automatic connection quality rating (Poor → Blazing Fast)
- Live "Network Usage" panel showing your currently active Afriway downloads and their speeds
- No external tools or accounts required — runs entirely over HTTPS from the app itself

### Live Speed Indicator

The header always shows a lightweight, continuously updating estimate of your current internet speed (refreshed automatically every 30 seconds) — no need to open the full Speed Test just to check.

### Free Space

A live disk usage bar in **Settings → Download Location** shows used/free space on whichever drive your downloads are set to save to, so you know before you start a large download whether you have room.

### Download Location — Any Folder, Not Just a Drive

- Pick a destination with a native OS folder browser (not just a drive-letter dropdown)
- The app creates (or reuses) an `Afriway` folder inside whatever you choose, and remembers it across restarts
- Files are still auto-sorted by type inside that folder:

```
Afriway/
├── Videos/     YouTube videos, audio, and yt-dlp downloads
├── Images/     Direct image downloads (.jpg, .png, .gif, .webp…)
├── App/        Executables and packages (.apk, .exe, .msi, .dmg…)
├── Folder/     YouTube playlists (one sub-folder per playlist)
└── Other/      Everything else (.zip, .pdf, .torrent content…)
```

### Queue Controls

- **Pause / Resume** — per-item and bulk (Select All → Pause All / Resume All)
- **Retry** — resumes from partial `.part` files; direct downloads use HTTP Range requests
- **Re-download** — appears when a completed file has been moved or deleted
- **Remove from list** — removes the entry without touching the file
- **Delete file** — removes the entry and permanently deletes the file from disk
- **Copy link** — copies the original source URL to the clipboard
- **Show in folder** — available at any stage of a download (not just after completion), opens the destination folder or selects the finished file in Explorer
- **Open file** — click a completed download's name (including individual playlist videos) to open it with the OS default app

### Desktop App Behaviour

- **System tray** — closing the window minimizes to the system tray instead of quitting; right-click the tray icon to reopen or fully exit
- **Single-instance protection** — launching the app while it's already running shows a clear message instead of silently doing nothing (or worse, connecting to a stale leftover process)
- **Window memory** — launches centered on screen and remembers your last window size between sessions
- **Native clipboard bridge** — Copy / Cut / Paste (including the URL field's dedicated copy and paste buttons) go through the OS clipboard directly, avoiding the permission-prompt limitations of an embedded webview
- **Bundled FFmpeg** — the packaged `.exe` ships with FFmpeg built in, so video+audio merging works out of the box with no separate install

### UI & Usability

- **Golden theme** — Default (Afro Black), Dark, and Light themes; persists across sessions and exe restarts
- **Custom scrollbars** — every scrollable panel (modals, format lists, playlist/progress views) uses the app's own themed scrollbar, not the browser default
- **Right-click context menu** — custom Cut / Copy / Paste menu on the URL input
- **Themed native dropdowns, SweetAlert2 notifications** — no unstyled browser-native popups anywhere
- **Persistent history** — download sessions survive page refresh and server restart

### YouTube Cookies Support

YouTube may restrict some formats for unauthenticated requests. To work around this:

1. Install the **"Get cookies.txt LOCALLY"** browser extension
2. Visit [youtube.com](https://www.youtube.com) while logged in
3. Export `cookies.txt` using the extension
4. In the app, open **Settings → YouTube Cookies** and upload the file

The cookies file is stored at `%APPDATA%\AfriWayDownloader\youtube_cookies.txt` and used automatically for all YouTube requests.

---

## Requirements

### Python

```
Python >= 3.10
```

```bash
pip install -r requirements.txt
```

### FFmpeg (required for YouTube video+audio merging)

> The pre-built `.exe` bundles FFmpeg — nothing to install. This is only needed when running from source.

| OS | Command |
|---|---|
| Windows | `winget install ffmpeg`, or download from [ffmpeg.org](https://ffmpeg.org/download.html) and place `ffmpeg.exe` anywhere under the project folder |
| macOS | `brew install ffmpeg` |
| Linux | `sudo apt install ffmpeg` |

> Without FFmpeg, YouTube downloads fall back to a single-stream format (no separate video+audio merge).

### aria2c (required for Torrent downloads)

| OS | Command |
|---|---|
| Windows | `winget install aria2`, or place `aria2c.exe` anywhere inside the project folder |
| macOS | `brew install aria2` |
| Linux | `sudo apt install aria2` |

> Torrent downloads are disabled if aria2c is not found. All other tabs work without it.

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/jocysite/AfriwayWeb.git
cd AfriwayWeb

# 2. (Recommended) Create a virtual environment
python -m venv .venv

# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

# 3. Install Python dependencies
pip install -r requirements.txt

# 4. Run the app
python app.py
```

Open **http://localhost:5000** in your browser, or run `python main.py` for the native desktop window (uses port 5050 internally).

---

## How to Use

### URL Bar

A single URL field sits at the top of the page, always visible. Paste any URL there — YouTube, magnet link, direct file, or video site URL — then switch to the appropriate tab.

- **Paste icon** — pastes clipboard contents into the field instantly
- **Copy icon** — copies the field's current contents to the clipboard
- **Right-click** the field for a Cut / Copy / Paste context menu

### YouTube Tab

1. Paste a YouTube video or playlist URL in the URL bar and click **Fetch**.
2. Pick a **video** quality, an **audio** quality, or both — video and audio are independent selections:
   - Both selected → downloads one merged MP4
   - Only video selected → downloads video, merged with the best available audio automatically
   - Only audio selected → downloads a standalone MP3
3. For playlists, uncheck any videos you want to skip — the rest download in parallel (up to 4 at a time).
4. Click **Download** — progress appears in the queue; click a playlist's name to see per-video progress.

> If you see "format not available" errors, upload a cookies file in Settings (see YouTube Cookies above).

### Torrent Tab

1. Paste a magnet link or `.torrent` URL in the URL bar, then **Start Download**.
   — OR —
2. Use the **Upload .torrent file** picker.

### Others Tab

1. Paste any direct file link or yt-dlp-supported URL (Vimeo, Twitter/X, Dailymotion, etc.).
2. Click **Analyze URL** — detects file type and shows name/size.
3. Click **Download** to start.

### Download Location

Every download modal shows the current save location with a **Change** button that opens a native folder picker — pick any folder on any drive, and an `Afriway` subfolder is created there automatically.

### Speed Test

Click the **Speed Test** button in the header — testing starts immediately. Watch ping, download, and upload measure live on the gauge, then check **Detailed Result** for a signal-quality breakdown with charts, and **History** for your last 30 runs. The header's live speed indicator always shows a lightweight estimate, even without opening this modal.

### All Downloads Tab

Shows every download (past and present) in one place.

- **Search bar** — filter by name or URL
- **Type / Status dropdowns** — narrow the list
- **Bulk toolbar** — Select All → Pause All / Resume All
- **Per-item actions** — Pause, Resume, Retry, Copy link, Show in folder, Remove, Delete file

### Theme

Click the **palette icon** in the header to switch between **Default**, **Dark**, and **Light** themes. The choice is saved and restored on the next launch.

---

## Project Structure

```
AfriwayWeb/
├── app.py                  # Flask backend — routes, download threads, session management
├── main.py                 # pywebview entry point — window, system tray, native folder picker
├── rthook_afriway.py       # Runtime hook patching paths inside the frozen exe
├── requirements.txt        # Python dependencies
├── afriway.spec            # PyInstaller spec for building the .exe
├── afriway_installer.spec  # PyInstaller spec used for the NSIS installer build
├── installer.nsi           # NSIS installer script
├── downloads.json          # Auto-generated: persisted download history (git-ignored)
├── prefs.json              # Auto-generated: user preferences — theme, download location (git-ignored)
├── window.json             # Auto-generated: last window size (git-ignored)
├── static/
│   ├── script.js           # Frontend — tabs, queue polling, speed test, all download flows
│   ├── style.css           # Themed UI — gold/green/blue brand colours, custom scrollbars
│   ├── AfriwayLogo.webp    # In-app header logo
│   ├── afriway.ico         # Favicon + exe/installer icon
│   ├── aria2-*/            # Bundled aria2c binary (Windows, git-ignored)
│   └── ffmpeg-win64/       # Bundled ffmpeg binary (Windows, git-ignored)
└── templates/
    └── index.html          # Single-page app shell
```

---

## Building the Desktop App

The app runs as a native desktop window using **pywebview** (wraps the OS WebView).

### Prerequisites

```bash
pip install pyinstaller
```

Place `ffmpeg.exe` under `static/ffmpeg-win64/` and `aria2c.exe` under `static/aria2-*/` before building, so both are bundled into the executable.

### Build

```bash
pyinstaller afriway.spec
```

The output executable is at `dist/AfriWayDownloader.exe`.

- User data (`downloads.json`, `prefs.json`, `window.json`, `youtube_cookies.txt`) is stored in `%APPDATA%\AfriWayDownloader\`
- No Python, FFmpeg, or aria2c installation required on the target machine
- The desktop icon uses `static/afriway.ico`

An NSIS installer can be built from `installer.nsi` for a traditional Windows setup experience.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| YouTube "Requested format is not available" | Upload a `cookies.txt` file in **Settings → YouTube Cookies** |
| "aria2c not found" on Torrent tab | Download `aria2c.exe` from [GitHub Releases](https://github.com/aria2/aria2/releases) and place it anywhere in the project folder |
| YouTube video has no audio | Install FFmpeg — without it yt-dlp cannot merge separate video+audio streams (the packaged `.exe` already bundles it) |
| Port 5000 already in use | `set FLASK_PORT=5001 && python app.py` (Windows) or `FLASK_PORT=5001 python app.py` (macOS/Linux) |
| File shows "File moved?" after completion | The file was moved or deleted after download. Click **↩ Re-download** to fetch it again |
| Paused download won't resume after restart | The app restarts from the last saved position using the original URL and folder |
| Theme or download location resets on every launch | Make sure `prefs.json` is writable in the app directory (or `%APPDATA%\AfriWayDownloader\` in exe mode) |
| Folder picker button does nothing | Native folder browsing is only available in the desktop app (`python main.py` or the `.exe`), not when accessed as a plain web page |
| "Afriway Downloader appears to already be running" | A previous instance is still open — check your system tray for the app icon (right-click → Exit), then launch again |

---

## Credits

Developed by **Yosef Mulatu**

[![LinkedIn](https://img.shields.io/badge/LinkedIn-Yosef%20Mulatu-0A66C2?logo=linkedin)](https://www.linkedin.com/in/yosefmulatu/)
[![Telegram](https://img.shields.io/badge/Telegram-@jocyJ-2CA5E0?logo=telegram)](https://t.me/jocyJ)
[![Email](https://img.shields.io/badge/Email-josephmulatu1%40gmail.com-C9A227)](mailto:josephmulatu1@gmail.com)

If this app saves you time, [buy me a coffee ☕](https://buymeacoffee.com/yosefmulatu)

---

## License

MIT — free to use, modify, and distribute.
