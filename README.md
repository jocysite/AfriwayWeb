# Afriway Downloader

A multi-type download manager built with Python and Flask, inspired by the spirit of Africa. Download YouTube videos and playlists, torrent files, direct files, and videos from 1 000+ sites — all from one clean, dark-themed web interface.

![Afriway Downloader](static/AfriwayLogo.webp)

---

## Features

| Tab | What you can download |
|---|---|
| **YouTube** | Videos & playlists — pick exact video/audio quality, download as MP4 or MP3 |
| **Torrent** | Magnet links, `.torrent` URLs, or upload a `.torrent` file directly |
| **Others** | Direct files (`.exe`, `.zip`, images…) and videos from 1 000+ sites via yt-dlp |
| **All Downloads** | Unified queue with live search, type/status filters, and real-time progress |

### Download Queue

- **Pause / Resume** — per-item and bulk (Select All → Pause/Resume All)
- **Retry** — resumes from partial `.part` files; direct downloads use HTTP Range requests
- **Re-download** — appears when a completed file has been moved or deleted
- **Remove from list** — removes the session without touching the file
- **Delete file** — removes from list and permanently deletes the file from disk
- **Copy link** — copies the original source URL to the clipboard
- **Show in folder** — opens Explorer/Finder at the file's location after completion

### Afriway Folder Organisation

Files are automatically sorted by type into a shared `Afriway` folder, similar to how Xender organises downloads:

```
Afriway/
├── Videos/     YouTube videos, audio, and video-site downloads
├── Images/     Direct image downloads (.jpg, .png, .gif, .webp…)
├── App/        Executables and packages (.apk, .exe, .msi, .dmg…)
├── Folder/     YouTube playlists (one sub-folder per playlist)
└── Other/      Everything else (.zip, .pdf, .torrent content…)
```

Choose which drive to save to from the **Drive** dropdown:
- **System drive (C:)** → `C:\Users\<You>\Downloads\Afriway`
- **Any other drive** → `X:\Afriway`

### Notifications

All alerts, confirmations, and toasts use **SweetAlert2** styled to match the dark gold theme — no browser-native popups.

### Other Highlights

- **Persistent history** — download sessions survive page refresh and server restart
- **Responsive** — works on desktop and mobile browsers
- **African-inspired dark UI** — gold, green, and deep-black brand colours
- Real-time progress bars with speed display
- Missing file detection — completed files that were moved show a clear warning + Re-download button

---

## Requirements

### Python

```
Python >= 3.10
```

Install all Python dependencies:

```bash
pip install -r requirements.txt
```

### FFmpeg (required for YouTube video+audio merging)

| OS | Command |
|---|---|
| Windows | `winget install ffmpeg` or download from [ffmpeg.org](https://ffmpeg.org/download.html) |
| macOS | `brew install ffmpeg` |
| Linux | `sudo apt install ffmpeg` |

> Without FFmpeg, YouTube downloads fall back to a single-stream format (no merging).

### aria2c (required for Torrent downloads)

| OS | Command |
|---|---|
| Windows | `winget install aria2` or download `aria2c.exe` from [GitHub Releases](https://github.com/aria2/aria2/releases) and place it anywhere inside the project folder |
| macOS | `brew install aria2` |
| Linux | `sudo apt install aria2` |

> The app searches the project folder recursively, so placing the aria2 binary anywhere under the project directory is enough.
> Torrent downloads are disabled if aria2c is not found. All other tabs work without it.

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/jocysite/Afriway-Downloader.git
cd Afriway-Downloader

# 2. (Recommended) Create a virtual environment
python -m venv .venv

# Windows:
.venv\Scripts\activate
# macOS / Linux:
source .venv/bin/activate

# 3. Install Python dependencies
pip install -r requirements.txt

# 4. Run the app
python app.py
```

Open **http://localhost:5000** in your browser.

---

## How to Use

### URL Bar

A single URL field sits at the top of the page, always visible regardless of which tab you are on. Paste any URL there — YouTube, magnet link, direct file, or video site — then switch to the appropriate tab and click its action button.

### YouTube Tab

1. Paste a YouTube URL in the URL bar at the top.
2. Switch to the **YouTube** tab and click **Fetch URL** — loads the title and available formats.
3. Choose **Video + Audio** (MP4) or **Audio Only** (MP3).
4. Select your preferred video and audio quality.
5. For playlists, uncheck any videos you want to skip.
6. Click **Download Now** — progress appears in the queue.

### Torrent Tab

1. Paste a magnet link or `.torrent` URL in the URL bar.
2. Switch to the **Torrent** tab and click **Start Download**.
   — OR —
3. **Upload a `.torrent` file** directly using the file picker.

> Requires aria2c.

### Others Tab

1. Paste any direct file link or yt-dlp-supported URL (Vimeo, Twitter, Dailymotion…) in the URL bar.
2. Switch to the **Others** tab and click **Analyze URL** — detects file type and shows name/size.
3. Click **Download** to start.

### Changing the Download Drive

The **Drive** selector at the top of the page lets you pick which drive the `Afriway` folder lives on. The full resolved path is shown as a preview. Click **Apply** to confirm.

### All Downloads Tab

Shows every download (past and present) in one place.

- **Search bar** — filter by name or URL.
- **Type / Status dropdowns** — narrow the list.
- **Bulk toolbar** — Select All → Pause All / Resume All.
- **Per-item actions** — Pause, Resume, Retry, Copy link, Show in folder, Remove, Delete file.

---

## Project Structure

```
Afriway-Downloader/
├── app.py                  # Flask backend — routes, download threads, session management
├── requirements.txt        # Python dependencies
├── downloads.json          # Auto-generated: persisted download history (git-ignored)
├── static/
│   ├── script.js           # Frontend — tabs, queue polling, all download flows
│   ├── style.css           # Responsive dark theme with brand colours
│   ├── AfriwayLogo.webp    # Sidebar logo
│   └── AfriwayLogo.ico     # Browser tab favicon
└── templates/
    └── index.html          # Single-page app shell
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "aria2c not found" on Torrent tab | Download `aria2c.exe` from [GitHub Releases](https://github.com/aria2/aria2/releases) and place it anywhere inside the project folder, then restart the app. |
| YouTube video has no audio or low quality | Install FFmpeg — without it yt-dlp cannot merge separate video and audio streams. |
| Port 5000 already in use | `set FLASK_PORT=5001 && python app.py` (Windows) or `FLASK_PORT=5001 python app.py` (macOS/Linux). |
| "Copy link" button doesn't work | The Clipboard API requires a secure context. Access the app via `http://localhost` (not a raw IP). |
| File shows "File moved?" after completion | The file was moved or deleted after download. Click **↩ Re-download** to fetch it again. |
| Paused download won't resume after restart | The app restarts the download from the last saved position using the original URL and folder. |

---

## Desktop App (planned)

The project is designed to be packaged as a standalone `.exe` using **PyInstaller**:

```bash
pip install pyinstaller
pyinstaller --onefile --windowed \
  --add-data "templates;templates" \
  --add-data "static;static" \
  app.py
```

User data (`downloads.json`, settings) will be stored in `%APPDATA%\AfriWayDownloader\` automatically when running as an exe.

---

## Credits

Developed by **Yosef Mulatu**

- [LinkedIn](https://www.linkedin.com/in/yosefmulatu/)
- [Facebook](https://web.facebook.com/yosefmulatufb)
- [Telegram](https://t.me/jocyJ)
- [Email](mailto:josephmulatu1@gmail.com)

If this app saves you time, [buy me a coffee](https://buymeacoffee.com/yosefmulatu) ☕

---

## License

MIT — free to use, modify, and distribute.
