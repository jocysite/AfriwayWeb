"""
Flask backend for YouTube Downloader
"""
import json
import logging
import os
import re
import subprocess
import sys
import threading
import uuid
from pathlib import Path

import yt_dlp
import qrcode
from flask import Flask, render_template, request, jsonify

try:
    import requests as http_req
    HTTP_REQ_AVAILABLE = True
except ImportError:
    HTTP_REQ_AVAILABLE = False

import shutil

def _find_aria2c():
    """Return the full path to aria2c, or None if not found.
    Checks PATH, the bundled static folder, project directory, then common installs.
    """
    # 1. Already on PATH
    on_path = shutil.which('aria2c')
    if on_path:
        return on_path

    # 2. Resolve the base directory (handles PyInstaller frozen, Electron spawn, and dev)
    if getattr(sys, 'frozen', False):
        project_dir = os.path.dirname(sys.executable)
    else:
        try:
            project_dir = os.path.dirname(os.path.abspath(__file__))
        except Exception:
            project_dir = os.getcwd()

    # Also consider the current working directory (Electron sets cwd to the app folder)
    dirs_to_search = list(dict.fromkeys([project_dir, os.getcwd()]))

    for base in dirs_to_search:
        # 2a. Known bundled location (static/aria2-*/aria2c.exe)
        static_dir = os.path.join(base, 'static')
        if os.path.isdir(static_dir):
            for entry in os.listdir(static_dir):
                candidate = os.path.join(static_dir, entry, 'aria2c.exe')
                if os.path.isfile(candidate):
                    return candidate
        # 2b. Next to app.py
        here = os.path.join(base, 'aria2c.exe')
        if os.path.isfile(here):
            return here

    # 3. Common Windows install locations
    candidates = [
        os.path.join(os.environ.get('LOCALAPPDATA', ''), 'aria2', 'aria2c.exe'),
        os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Microsoft', 'WinGet', 'Links', 'aria2c.exe'),
        r'C:\aria2\aria2c.exe',
        r'C:\tools\aria2\aria2c.exe',
        r'C:\ProgramData\chocolatey\bin\aria2c.exe',
        r'C:\Program Files\aria2\aria2c.exe',
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path

    return None

_ARIA2C_PATH = _find_aria2c()
ARIA2C_AVAILABLE = bool(_ARIA2C_PATH)

_base_dir = sys._MEIPASS if getattr(sys, 'frozen', False) else os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__,
            template_folder=os.path.join(_base_dir, 'templates'),
            static_folder=os.path.join(_base_dir, 'static'))

# Disable Flask request logging for cleaner console
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)

# Store download sessions
download_sessions = {}

# In-memory handles for pause/resume — NOT persisted (rebuilt when threads start)
_pause_events = {}   # session_id -> threading.Event (set=running, clear=paused)
_running_procs = {}  # session_id -> subprocess.Popen (aria2c handles)

# Selected partition for Afriway folder (None = auto-detect system drive)
_selected_partition = None

# Afriway folder structure — mirrors Xender-style auto-organised downloads
AFRIWAY_SUBFOLDERS = ['Images', 'App', 'Folder', 'Videos', 'Other']
_IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.tif'}
_APP_EXTS   = {'.apk', '.exe', '.msi', '.dmg', '.deb', '.rpm', '.pkg', '.appimage'}
_VIDEO_EXTS = {'.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v',
               '.mpg', '.mpeg', '.mp3', '.m4a', '.flac', '.wav', '.aac', '.ogg', '.opus', '.wma'}


def _get_app_data_dir():
    """Writable data directory — points to AppData when packaged as a .exe, project dir otherwise."""
    if getattr(sys, 'frozen', False):
        return os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'AfriWayDownloader')
    return os.path.dirname(os.path.abspath(__file__))


_sessions_file = os.path.join(_get_app_data_dir(), 'downloads.json')


def _save_sessions():
    """Persist download_sessions to disk so they survive a page refresh or server restart."""
    try:
        os.makedirs(os.path.dirname(_sessions_file), exist_ok=True)
        with open(_sessions_file, 'w', encoding='utf-8') as f:
            json.dump(dict(download_sessions), f, ensure_ascii=False, indent=2)
    except Exception as exc:
        print(f'⚠️  Could not save sessions: {exc}')


def _load_sessions():
    """Restore previous sessions from disk on startup. Active downloads become 'interrupted'."""
    if not os.path.exists(_sessions_file):
        return
    try:
        with open(_sessions_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        for s in data.values():
            if s.get('status') == 'downloading':
                s['status'] = 'interrupted'
                s['message'] = 'Interrupted — app was restarted'
        download_sessions.update(data)
        print(f'📂 Restored {len(data)} previous download session(s)')
    except Exception as exc:
        print(f'⚠️  Could not restore sessions: {exc}')


def _get_available_drives():
    """Return available drive letters on Windows, or ['/'] on Unix."""
    if os.name == 'nt':
        import ctypes
        drives = []
        bitmask = ctypes.windll.kernel32.GetLogicalDrives()
        for letter in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ':
            if bitmask & 1:
                drives.append(f'{letter}:')
            bitmask >>= 1
        return drives
    return ['/']


def _get_afriway_base():
    """Return the Afriway root folder path for the selected partition."""
    partition = _selected_partition
    if not partition:
        if os.name == 'nt':
            partition = os.environ.get('SystemDrive', 'C:').rstrip('\\')
        else:
            return str(Path.home() / 'Afriway')
    if os.name == 'nt':
        sys_drive = os.environ.get('SystemDrive', 'C:').upper().rstrip('\\')
        if partition.upper().rstrip('\\') == sys_drive:
            # Use the user's actual Downloads folder (e.g. C:\Users\YosefM\Downloads\Afriway)
            return os.path.join(get_downloads_folder(), 'Afriway')
        root = partition.rstrip('\\') + '\\'
        return os.path.join(root, 'Afriway')
    return os.path.join(partition, 'Afriway')


def _ensure_afriway_dirs():
    """Create Afriway folder + all subfolders if missing. Returns the base path."""
    base = _get_afriway_base()
    for sub in AFRIWAY_SUBFOLDERS:
        os.makedirs(os.path.join(base, sub), exist_ok=True)
    return base


def _get_type_folder(filename):
    """Map a filename's extension to the correct Afriway subfolder name."""
    ext = os.path.splitext(filename)[1].lower()
    if ext in _IMAGE_EXTS:
        return 'Images'
    if ext in _APP_EXTS:
        return 'App'
    if ext in _VIDEO_EXTS:
        return 'Videos'
    return 'Other'


def detect_url_type(url):
    """Return 'torrent', 'direct', or 'video' based on URL shape."""
    if url.startswith('magnet:') or url.lower().endswith('.torrent'):
        return 'torrent'
    direct_exts = {
        '.exe', '.msi', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
        '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.pptx', '.csv',
        '.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a',
        '.iso', '.dmg', '.deb', '.rpm', '.apk', '.pkg',
    }
    path = url.split('?')[0].lower()
    ext = os.path.splitext(path)[1]
    if ext in direct_exts:
        return 'direct'
    return 'video'


def _human_size(size_bytes):
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size_bytes < 1024:
            return f'{size_bytes:.1f} {unit}'
        size_bytes /= 1024
    return f'{size_bytes:.1f} PB'


def get_downloads_folder():
    """Get the user's Downloads folder path"""
    if os.name == 'nt':  # Windows
        import winreg
        sub_key = r'SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders'
        downloads_guid = '{374DE290-123F-4565-9164-39C4925E467B}'
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, sub_key) as key:
            location = winreg.QueryValueEx(key, downloads_guid)[0]
        return location
    else:  # macOS and Linux
        return str(Path.home() / "Downloads")


@app.errorhandler(Exception)
def handle_unhandled_exception(e):
    """Ensure all unhandled exceptions return JSON instead of Flask's HTML error page."""
    print(f'❌ Unhandled exception: {e}')
    return jsonify({'error': str(e)}), 500


@app.route('/')
def index():
    """Serve the main page"""
    return render_template('index.html')


def _extract_formats(formats):
    """Parse a yt_dlp formats list into separate video/audio lists."""
    video_formats = []
    audio_formats = []
    for f in formats:
        if f.get('vcodec') != 'none' and f.get('acodec') == 'none':
            video_formats.append({
                'id': f['format_id'],
                'ext': f['ext'],
                'res': f.get('resolution', 'N/A'),
                'note': f.get('format_note', ''),
                'height': f.get('height', 0)
            })
        elif f.get('acodec') != 'none' and f.get('vcodec') == 'none':
            audio_formats.append({
                'id': f['format_id'],
                'ext': f['ext'],
                'abr': f.get('abr', 0),
                'note': f.get('format_note', '')
            })
    video_formats.sort(key=lambda x: x['height'], reverse=True)
    audio_formats.sort(key=lambda x: x['abr'], reverse=True)
    return video_formats, audio_formats


@app.route('/api/fetch-info', methods=['POST'])
def fetch_info():
    """Phase 1 — fast metadata fetch (title + video list for playlists)."""
    try:
        data = request.json
        url = data.get('url')

        if not url:
            return jsonify({'error': 'URL is required'}), 400

        print(f"\n🔍 Fetching info for: {url}")

        ydl_opts = {'quiet': True, 'no_warnings': True, 'extract_flat': 'in_playlist'}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            is_playlist = info.get('_type') == 'playlist'

        if is_playlist:
            playlist_title = info.get('title', 'Unknown Playlist')
            entries = info.get('entries', [])

            videos = []
            for idx, entry in enumerate(entries):
                if entry:
                    videos.append({
                        'index': idx + 1,
                        'id': entry.get('id', ''),
                        'title': entry.get('title', f'Video {idx + 1}'),
                        'duration': entry.get('duration', 0),
                        'url': entry.get('url', '') or f"https://www.youtube.com/watch?v={entry.get('id', '')}"
                    })

            print(f"📁 Playlist: {playlist_title} ({len(videos)} videos)")

            return jsonify({
                'success': True,
                'title': playlist_title,
                'is_playlist': True,
                'video_count': len(videos),
                'videos': videos,
                'formats_ready': False,
                'video_formats': [],
                'audio_formats': []
            })

        else:
            # For single videos extract_flat='in_playlist' performs a full extraction,
            # so formats are already present — no second round-trip needed.
            title = info.get('title', 'Unknown')
            raw_formats = info.get('formats', [])
            print(f"🎥 Video: {title}")

            video_formats, audio_formats = _extract_formats(raw_formats)

            if video_formats or audio_formats:
                print(f"✅ Found {len(video_formats)} video formats and {len(audio_formats)} audio formats\n")
                return jsonify({
                    'success': True,
                    'title': title,
                    'is_playlist': False,
                    'video_count': 1,
                    'videos': [],
                    'formats_ready': True,
                    'video_formats': video_formats,
                    'audio_formats': audio_formats
                })
            else:
                # Formats not available from flat extract; Phase 2 will fetch them.
                return jsonify({
                    'success': True,
                    'title': title,
                    'is_playlist': False,
                    'video_count': 1,
                    'videos': [],
                    'formats_ready': False,
                    'video_formats': [],
                    'audio_formats': []
                })

    except yt_dlp.utils.DownloadError as e:
        print(f"❌ Error: {str(e)}\n")
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        print(f"❌ Unexpected error in fetch-info: {str(e)}\n")
        return jsonify({'error': str(e)}), 500


@app.route('/api/fetch-formats', methods=['POST'])
def fetch_formats():
    """Phase 2 — full format extraction (called when Phase 1 returns formats_ready=False)."""
    try:
        data = request.json
        url = data.get('url')
        is_playlist = data.get('is_playlist', False)
        # First video URL passed from Phase 1 — lets us skip re-fetching the playlist page
        first_video_url = data.get('first_video_url')

        if not url:
            return jsonify({'error': 'URL is required'}), 400

        # Shared fast opts: skip HLS manifests (not needed for downloads, saves 1-3s)
        fast_opts = {
            'quiet': True,
            'no_warnings': True,
            'extractor_args': {'youtube': {'skip': ['hls']}},
        }

        print(f"🎬 Fetching formats {'(playlist first video)' if is_playlist else '(single video)'}...")

        if is_playlist and first_video_url:
            # Fast path: extract formats directly from the first video URL already
            # known from Phase 1 — avoids re-fetching the entire playlist page
            with yt_dlp.YoutubeDL(fast_opts) as ydl:
                info = ydl.extract_info(first_video_url, download=False)
            raw_formats = info.get('formats', [])
        elif is_playlist:
            # Fallback when first video URL isn't available
            ydl_opts = {**fast_opts, 'extract_flat': False, 'playlistend': 1}
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                first_video = info['entries'][0] if 'entries' in info else info
            raw_formats = first_video.get('formats', [])
        else:
            with yt_dlp.YoutubeDL(fast_opts) as ydl:
                info = ydl.extract_info(url, download=False)
            raw_formats = info.get('formats', [])

        video_formats, audio_formats = _extract_formats(raw_formats)

        print(f"✅ Found {len(video_formats)} video formats and {len(audio_formats)} audio formats\n")

        return jsonify({
            'success': True,
            'video_formats': video_formats,
            'audio_formats': audio_formats
        })

    except yt_dlp.utils.DownloadError as e:
        print(f"❌ Error: {str(e)}\n")
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        print(f"❌ Unexpected error in fetch-formats: {str(e)}\n")
        return jsonify({'error': str(e)}), 500


@app.route('/api/download', methods=['POST'])
def download():
    """Start download process"""
    try:
        data = request.json
        url = data.get('url')
        download_type = data.get('download_type')
        video_format_id = data.get('video_format_id')
        audio_format_id = data.get('audio_format_id')
        is_playlist = data.get('is_playlist', False)
        skip_indices = data.get('skip_indices', [])
        rename_mode = data.get('rename_mode', False)  # True = add unique suffix instead of overwriting

        if not url or not audio_format_id:
            return jsonify({'error': 'Missing required parameters'}), 400

        session_id = str(uuid.uuid4())
        download_sessions[session_id] = {
            'status': 'downloading',
            'progress': 0,
            'message': 'Starting download...',
            'type': 'youtube',
            'name': url,
            'url': url,
            'filepath': '',
            'save_dir': '',
            '_meta': {
                'type': 'youtube',
                'url': url,
                'download_type': download_type,
                'video_format_id': video_format_id,
                'audio_format_id': audio_format_id,
                'is_playlist': is_playlist,
                'skip_indices': skip_indices,
            },
        }
        _save_sessions()

        print(f"\n🚀 Starting download...")
        print(f"📥 Type: {download_type.upper()}")
        print(f"🔗 URL: {url}")
        if skip_indices:
            print(f"⏭️  Skipping videos: {skip_indices}")
        print()

        thread = threading.Thread(
            target=_download_thread,
            args=(session_id, url, download_type, video_format_id,
                  audio_format_id, is_playlist, skip_indices, None, rename_mode)
        )
        thread.daemon = True
        thread.start()

        return jsonify({'success': True, 'session_id': session_id})

    except (ValueError, KeyError) as e:
        print(f"❌ Error: {str(e)}\n")
        return jsonify({'error': str(e)}), 500


@app.route('/api/download-status/<session_id>', methods=['GET'])
def download_status(session_id):
    """Get download status"""
    session = download_sessions.get(session_id)
    if not session:
        return jsonify({'error': 'Session not found'}), 404

    return jsonify(session)


def _download_thread(session_id, url, download_type, video_format_id, audio_format_id, is_playlist, skip_indices, save_dir=None, rename_mode=False):
    """Background thread for downloading with smart quality fallback"""
    evt = threading.Event()
    evt.set()
    _pause_events[session_id] = evt
    try:
        # Reuse the previous save_dir if valid (so yt-dlp resumes from .part files)
        if save_dir and os.path.isdir(save_dir):
            dest_folder = save_dir
            if is_playlist:
                output_template = os.path.join(dest_folder, '%(playlist)s', '%(playlist_index)s - %(title)s.%(ext)s')
            else:
                output_template = os.path.join(dest_folder, '%(title)s.%(ext)s')
        else:
            afriway_base = _ensure_afriway_dirs()
            if is_playlist:
                dest_folder = os.path.join(afriway_base, 'Folder')
                output_template = os.path.join(
                    dest_folder,
                    '%(playlist)s',
                    '%(playlist_index)s - %(title)s.%(ext)s'
                )
            else:
                dest_folder = os.path.join(afriway_base, 'Videos')
                output_template = os.path.join(dest_folder, '%(title)s.%(ext)s')

        # Rename mode: append unique ID so the file never collides with existing ones
        if rename_mode and not save_dir:
            short_id = session_id[:8]
            if output_template.endswith('.%(ext)s'):
                output_template = output_template[:-len('.%(ext)s')] + f' ({short_id}).%(ext)s'

        last_video_percent = -1
        last_audio_percent = -1
        current_stage = None
        current_playlist_index = 0

        def progress_hook(d):
            """Handle download progress with clean console output"""
            nonlocal last_video_percent, last_audio_percent, current_stage, current_playlist_index
            if not evt.is_set():
                raise Exception('paused')  # aborts yt-dlp; .part file preserved for resume

            if d['status'] == 'downloading':
                try:
                    # Get percentage
                    percent_str = d.get(
                        '_percent_str', '0%').strip().replace('%', '')
                    try:
                        percent = float(percent_str)
                    except ValueError:
                        percent = 0

                    # Get playlist info if available
                    info_dict = d.get('info_dict', {})
                    playlist_index = info_dict.get('playlist_index')

                    if playlist_index and playlist_index != current_playlist_index:
                        current_playlist_index = playlist_index
                        if current_playlist_index in skip_indices:
                            print(
                                f"\n⏭️  Skipping video {current_playlist_index}")
                            return
                        print(
                            f"\n📥 Downloading video {current_playlist_index}...")
                        # Reset percentages for new video
                        last_video_percent = -1
                        last_audio_percent = -1

                    # Determine stage
                    filename = d.get('filename', '')

                    if 'f' + str(video_format_id) in filename or (download_type == 'video' and current_stage != 'audio'):
                        stage = 'video'
                    else:
                        stage = 'audio'

                    # Only print if percentage increased
                    if stage == 'video' and download_type == 'video':
                        if int(percent) > int(last_video_percent):
                            last_video_percent = percent
                            current_stage = 'video'
                            sys.stdout.write(f"\r🎬 Video: {percent:.1f}% ")
                            sys.stdout.flush()
                    elif stage == 'audio' or download_type == 'audio':
                        if int(percent) > int(last_audio_percent):
                            last_audio_percent = percent
                            current_stage = 'audio'
                            if download_type == 'video' and last_video_percent > 0:
                                print()
                            sys.stdout.write(f"\r🎵 Audio: {percent:.1f}% ")
                            sys.stdout.flush()

                    # Update session
                    download_sessions[session_id]['progress'] = percent
                    download_sessions[session_id]['message'] = f"Downloading... {percent:.1f}%"

                except (ValueError, KeyError):
                    pass

            elif d['status'] == 'finished':
                if last_video_percent > 0 or last_audio_percent > 0:
                    print()
                print("⚙️  Processing and merging...")
                download_sessions[session_id]['message'] = 'Processing and merging...'

        captured_filepath = []

        def postprocessor_hook(d):
            if d.get('status') == 'finished':
                fp = d.get('filepath', '')
                if fp and not fp.endswith('.ytdl') and not fp.endswith('.part'):
                    captured_filepath.append(fp)

        # Create match filter for skipping videos
        def match_filter(info_dict, incomplete):
            """Filter to skip specific playlist items"""
            if is_playlist and skip_indices:
                playlist_index = info_dict.get('playlist_index')
                if playlist_index in skip_indices:
                    print(
                        f"⏭️  Skipping video {playlist_index}: {info_dict.get('title', 'Unknown')}")
                    return "Skipped by user"
            return None

        # Build comprehensive format string with multiple fallbacks
        if download_type == 'video':
            format_string = (
                f'{video_format_id}+{audio_format_id}/'  # Try exact formats
                # Selected video + best audio
                f'{video_format_id}+bestaudio/'
                # Best video + selected audio
                f'bestvideo+{audio_format_id}/'
                # Quality limits
                f'bestvideo[height<=1080]+bestaudio[abr>=96]/'
                f'bestvideo+bestaudio/'                   # Best of both
                f'best'                                    # Final fallback
            )

            print(
                f"🎯 Targeting: Video format {video_format_id} + Audio format {audio_format_id}")
            print(f"📋 Smart quality fallback enabled\n")

            ydl_opts = {
                'format': format_string,
                'merge_output_format': 'mp4',
                'outtmpl': output_template,
                'ignoreerrors': True,  # Continue on errors
                'progress_hooks': [progress_hook],
                'postprocessor_hooks': [postprocessor_hook],
                'match_filter': match_filter,
                'noplaylist': not is_playlist,
                'quiet': False,
                'no_warnings': False,
            }
        else:  # audio only
            format_string = (
                f'{audio_format_id}/'      # Try selected
                f'bestaudio[abr>=128]/'    # Best audio >= 128kbps
                f'bestaudio/'               # Any best audio
                f'best'                     # Final fallback
            )

            print(f"🎯 Targeting: Audio format {audio_format_id}")
            print(f"📋 Smart quality fallback enabled\n")

            ydl_opts = {
                'format': format_string,
                'outtmpl': output_template,
                'postprocessors': [{
                    'key': 'FFmpegExtractAudio',
                    'preferredcodec': 'mp3',
                    'preferredquality': '192',
                }],
                'ignoreerrors': True,  # Continue on errors
                'progress_hooks': [progress_hook],
                'postprocessor_hooks': [postprocessor_hook],
                'match_filter': match_filter,
                'noplaylist': not is_playlist,
                'quiet': False,
                'no_warnings': False,
            }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        print(f"\n✅ Download completed!")
        print(f"📁 Saved to: {dest_folder}\n")

        download_sessions[session_id]['save_dir'] = dest_folder
        if captured_filepath and not is_playlist:
            download_sessions[session_id]['filepath'] = captured_filepath[-1]
        else:
            download_sessions[session_id]['filepath'] = dest_folder
        download_sessions[session_id]['status'] = 'completed'
        download_sessions[session_id]['progress'] = 100
        download_sessions[session_id]['message'] = f'Download completed! Saved to: {dest_folder}'
        _save_sessions()

    except yt_dlp.utils.DownloadError as e:
        if download_sessions.get(session_id, {}).get('status') != 'paused':
            print(f"\n❌ Download error: {str(e)}\n")
            download_sessions[session_id]['status'] = 'error'
            download_sessions[session_id]['message'] = f'Download error: {str(e)}'
            _save_sessions()
    except (OSError, KeyError) as e:
        if download_sessions.get(session_id, {}).get('status') != 'paused':
            print(f"\n❌ Error: {str(e)}\n")
            download_sessions[session_id]['status'] = 'error'
            download_sessions[session_id]['message'] = f'Error: {str(e)}'
            _save_sessions()
    except Exception:
        # Catches the 'paused' exception raised in progress_hook; real errors go to DownloadError/OSError above
        if download_sessions.get(session_id, {}).get('status') != 'paused':
            download_sessions[session_id]['status'] = 'error'
            download_sessions[session_id]['message'] = 'Unexpected error'
            _save_sessions()
    finally:
        _pause_events.pop(session_id, None)


@app.route('/api/drives', methods=['GET'])
def api_get_drives():
    """Return available drive letters with their Afriway paths."""
    drives = _get_available_drives()
    sys_drive = (os.environ.get('SystemDrive', 'C:') if os.name == 'nt' else '/').upper().rstrip('\\')
    result = []
    for d in drives:
        is_sys = d.upper().rstrip('\\') == sys_drive
        if os.name == 'nt':
            path = os.path.join(get_downloads_folder(), 'Afriway') if is_sys else f'{d}\\Afriway'
        else:
            path = f'{d}/Afriway'
        result.append({'partition': d, 'is_system': is_sys, 'afriway_path': path})
    return jsonify({'drives': result})


@app.route('/api/get-partition', methods=['GET'])
def api_get_partition():
    partition = _selected_partition
    if not partition and os.name == 'nt':
        partition = os.environ.get('SystemDrive', 'C:').rstrip('\\')
    return jsonify({'partition': partition, 'path': _get_afriway_base()})


@app.route('/api/set-partition', methods=['POST'])
def api_set_partition():
    global _selected_partition
    data = request.json
    partition = (data.get('partition') or '').strip()
    if not partition:
        return jsonify({'error': 'Partition required'}), 400
    _selected_partition = partition
    base = _ensure_afriway_dirs()
    return jsonify({'success': True, 'path': base})


@app.route('/api/analyze-url', methods=['POST'])
def api_analyze_url():
    try:
        data = request.json
        url = (data.get('url') or '').strip()
        if not url:
            return jsonify({'error': 'URL is required'}), 400

        url_type = detect_url_type(url)
        result = {'type': url_type, 'url': url}

        if url_type == 'direct':
            filename = url.split('/')[-1].split('?')[0] or 'file'
            size_str = 'Unknown'
            if HTTP_REQ_AVAILABLE:
                try:
                    r = http_req.head(url, timeout=8, allow_redirects=True)
                    cd = r.headers.get('Content-Disposition', '')
                    if 'filename=' in cd:
                        filename = cd.split('filename=')[-1].strip('"').strip("'")
                    size_bytes = int(r.headers.get('Content-Length', 0))
                    if size_bytes:
                        size_str = _human_size(size_bytes)
                except Exception:
                    pass
            result.update({'filename': filename, 'size': size_str})

        elif url_type == 'video':
            try:
                opts = {'quiet': True, 'no_warnings': True, 'extract_flat': True}
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=False)
                title = info.get('title', url.split('/')[-1])
                result.update({'title': title, 'filename': title})
            except Exception:
                title = url.split('/')[-1] or 'video'
                result.update({'title': title, 'filename': title})

        elif url_type == 'torrent':
            fname = url.split('/')[-1].split('?')[0] or 'torrent'
            result.update({'filename': fname, 'title': 'Torrent'})

        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/download-direct', methods=['POST'])
def api_download_direct():
    if not HTTP_REQ_AVAILABLE:
        return jsonify({'error': 'requests library not installed. Run: pip install requests'}), 503
    try:
        data = request.json
        url = (data.get('url') or '').strip()
        if not url:
            return jsonify({'error': 'URL is required'}), 400
        rename_mode = data.get('rename_mode', False)
        filename = url.split('/')[-1].split('?')[0] or 'file'
        session_id = str(uuid.uuid4())
        download_sessions[session_id] = {
            'status': 'downloading',
            'progress': 0,
            'message': 'Starting download...',
            'type': 'direct',
            'name': filename,
            'url': url,
            'filepath': '',
            'save_dir': '',
            '_meta': {'type': 'direct', 'url': url, 'filename': filename},
        }
        _save_sessions()
        thread = threading.Thread(
            target=_download_direct_thread,
            args=(session_id, url, filename, None, rename_mode)
        )
        thread.daemon = True
        thread.start()
        return jsonify({'success': True, 'session_id': session_id})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _download_direct_thread(session_id, url, filename, resume_dir=None, rename_mode=False):
    evt = threading.Event()
    evt.set()
    _pause_events[session_id] = evt
    try:
        if resume_dir and os.path.isdir(resume_dir):
            save_dir = resume_dir
        else:
            afriway_base = _ensure_afriway_dirs()
            save_dir = os.path.join(afriway_base, _get_type_folder(filename))
        dest = os.path.join(save_dir, filename)

        # Rename mode: find next available filename (file.txt → file (1).txt → file (2).txt …)
        if rename_mode and not resume_dir and os.path.exists(dest):
            base, ext = os.path.splitext(dest)
            i = 1
            while os.path.exists(dest):
                dest = f"{base} ({i}){ext}"
                i += 1
            filename = os.path.basename(dest)
            download_sessions[session_id]['name'] = filename

        # Resume from partial file via HTTP Range if the server supports it
        resume_pos = os.path.getsize(dest) if os.path.exists(dest) else 0
        req_headers = {'Range': f'bytes={resume_pos}-'} if resume_pos > 0 else {}
        r = http_req.get(url, stream=True, timeout=30, headers=req_headers)

        if resume_pos > 0 and r.status_code == 206:
            write_mode = 'ab'
            downloaded = resume_pos
            content_len = int(r.headers.get('Content-Length', 0))
            total = resume_pos + content_len if content_len else 0
        else:
            r.raise_for_status()
            write_mode = 'wb'
            downloaded = 0
            total = int(r.headers.get('Content-Length', 0))

        with open(dest, write_mode) as f:
            for chunk in r.iter_content(chunk_size=65536):
                if chunk:
                    _pause_events.get(session_id, evt).wait()
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        pct = (downloaded / total) * 100
                        download_sessions[session_id]['progress'] = pct
                        download_sessions[session_id]['message'] = f'Downloading... {pct:.1f}%'
        download_sessions[session_id]['filepath'] = dest
        download_sessions[session_id]['save_dir'] = save_dir
        download_sessions[session_id]['status'] = 'completed'
        download_sessions[session_id]['progress'] = 100
        download_sessions[session_id]['message'] = f'Saved to: {dest}'
        _save_sessions()
        print(f'✅ Direct download complete: {dest}')
    except Exception as e:
        if download_sessions.get(session_id, {}).get('status') != 'paused':
            download_sessions[session_id]['status'] = 'error'
            download_sessions[session_id]['message'] = str(e)
            _save_sessions()
        print(f'❌ Direct download error: {e}')
    finally:
        _pause_events.pop(session_id, None)


_ARIA2C_INSTALL_HINT = (
    'aria2c not found. Quick fix: download aria2c.exe from '
    'https://github.com/aria2/aria2/releases and place it in the app folder next to app.py, then restart.\n\n'
    'Or install system-wide:\n'
    '  Windows:  winget install aria2  or  choco install aria2\n'
    '  macOS:    brew install aria2\n'
    '  Linux:    sudo apt install aria2'
)


def _run_aria2c(session_id, args):
    """Run aria2c with the given extra args, updating session progress from stdout."""
    afriway_base = _ensure_afriway_dirs()
    cmd = [
        _ARIA2C_PATH,
        f'--dir={os.path.join(afriway_base, "Other")}',
        '--seed-time=0',        # stop seeding immediately after completion
        '--summary-interval=1', # print summary every second
        '--console-log-level=notice',
    ] + args
    print(f'🔗 aria2c: {" ".join(cmd)}\n')
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        _running_procs[session_id] = proc
        for raw in proc.stdout:
            line = raw.strip()
            if not line:
                continue
            # Progress lines: [...(XX%)...]
            m = re.search(r'\((\d+)%\)', line)
            if m:
                pct = float(m.group(1))
                download_sessions[session_id]['progress'] = pct
                # Also extract DL speed if present: DL:X.XMiB or DL:XXKB
                speed_m = re.search(r'DL:([\d.]+\w+)', line)
                speed_str = f'  ↓{speed_m.group(1)}/s' if speed_m else ''
                download_sessions[session_id]['message'] = f'{pct:.0f}%{speed_str}'
            else:
                # Use non-progress lines as status text (truncated)
                download_sessions[session_id]['message'] = line[:120]
        proc.wait()
        if proc.returncode == 0:
            save_dir = os.path.join(_get_afriway_base(), 'Other')
            download_sessions[session_id]['filepath'] = save_dir
            download_sessions[session_id]['save_dir'] = save_dir
            download_sessions[session_id]['status'] = 'completed'
            download_sessions[session_id]['progress'] = 100
            download_sessions[session_id]['message'] = 'Download complete!'
            _save_sessions()
            print(f'✅ aria2c complete for session {session_id}')
        elif download_sessions.get(session_id, {}).get('status') == 'paused':
            pass  # process was terminated intentionally; keep paused status
        else:
            download_sessions[session_id]['status'] = 'error'
            download_sessions[session_id]['message'] = f'aria2c exited with code {proc.returncode}'
            _save_sessions()
            print(f'❌ aria2c error (code {proc.returncode}) for session {session_id}')
    except Exception as e:
        if download_sessions.get(session_id, {}).get('status') != 'paused':
            download_sessions[session_id]['status'] = 'error'
            download_sessions[session_id]['message'] = str(e)
            _save_sessions()
        print(f'❌ Torrent error: {e}')
    finally:
        _running_procs.pop(session_id, None)


@app.route('/api/download-torrent', methods=['POST'])
def api_download_torrent():
    if not ARIA2C_AVAILABLE:
        return jsonify({'error': _ARIA2C_INSTALL_HINT}), 503
    try:
        data = request.json
        url = (data.get('url') or '').strip()
        if not url:
            return jsonify({'error': 'URL is required'}), 400
        name = url.split('/')[-1].split('?')[0] or 'torrent'
        session_id = str(uuid.uuid4())
        download_sessions[session_id] = {
            'status': 'downloading',
            'progress': 0,
            'message': 'Starting torrent...',
            'type': 'torrent',
            'name': name,
            'url': url,
            'filepath': '',
            'save_dir': '',
            '_meta': {'type': 'aria2c', 'args': [url]},
        }
        _save_sessions()
        thread = threading.Thread(target=_run_aria2c, args=(session_id, [url]))
        thread.daemon = True
        thread.start()
        return jsonify({'success': True, 'session_id': session_id})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/download-video-best', methods=['POST'])
def api_download_video_best():
    """Download from any yt-dlp-supported site at best quality (no format picker)."""
    try:
        data = request.json
        url = (data.get('url') or '').strip()
        if not url:
            return jsonify({'error': 'URL is required'}), 400
        session_id = str(uuid.uuid4())
        download_sessions[session_id] = {
            'status': 'downloading',
            'progress': 0,
            'message': 'Starting video download...',
            'type': 'video',
            'name': url.split('/')[-1] or url,
            'url': url,
            'filepath': '',
            'save_dir': '',
            '_meta': {'type': 'video', 'url': url},
        }
        _save_sessions()
        thread = threading.Thread(
            target=_download_video_best_thread,
            args=(session_id, url)
        )
        thread.daemon = True
        thread.start()
        return jsonify({'success': True, 'session_id': session_id})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _download_video_best_thread(session_id, url, save_dir=None):
    evt = threading.Event()
    evt.set()
    _pause_events[session_id] = evt

    captured_filepath = []

    def postprocessor_hook(d):
        if d.get('status') == 'finished':
            fp = d.get('filepath', '')
            if fp and not fp.endswith('.ytdl') and not fp.endswith('.part'):
                captured_filepath.append(fp)

    def progress_hook(d):
        if not evt.is_set():
            raise Exception('paused')  # aborts yt-dlp; .part file preserved for resume
        if d['status'] == 'downloading':
            try:
                pct = float(d.get('_percent_str', '0%').strip().replace('%', ''))
            except ValueError:
                pct = 0
            download_sessions[session_id]['progress'] = pct
            download_sessions[session_id]['message'] = f'Downloading... {pct:.1f}%'
            title = (d.get('info_dict') or {}).get('title', '')
            if title:
                download_sessions[session_id]['name'] = title
        elif d['status'] == 'finished':
            download_sessions[session_id]['message'] = 'Processing...'

    try:
        if save_dir and os.path.isdir(save_dir):
            save_path = save_dir
        else:
            afriway_base = _ensure_afriway_dirs()
            save_path = os.path.join(afriway_base, 'Videos')
        ydl_opts = {
            'format': 'bestvideo+bestaudio/best',
            'merge_output_format': 'mp4',
            'outtmpl': os.path.join(save_path, '%(title)s.%(ext)s'),
            'progress_hooks': [progress_hook],
            'postprocessor_hooks': [postprocessor_hook],
            'quiet': True,
            'no_warnings': True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get('title', url)
            download_sessions[session_id]['name'] = title
        if captured_filepath:
            download_sessions[session_id]['filepath'] = captured_filepath[-1]
        else:
            download_sessions[session_id]['filepath'] = save_path
        download_sessions[session_id]['save_dir'] = save_path
        download_sessions[session_id]['status'] = 'completed'
        download_sessions[session_id]['progress'] = 100
        download_sessions[session_id]['message'] = f'Saved: {title}'
        _save_sessions()
        print(f'✅ Video download complete: {title}')
    except Exception as e:
        if download_sessions.get(session_id, {}).get('status') != 'paused':
            download_sessions[session_id]['status'] = 'error'
            download_sessions[session_id]['message'] = str(e)
            _save_sessions()
            print(f'❌ Video download error: {e}')
    finally:
        _pause_events.pop(session_id, None)


@app.route('/api/downloads', methods=['GET'])
def api_downloads():
    """Return all download sessions as a list, newest first."""
    sessions = []
    for sid, s in download_sessions.items():
        filepath = s.get('filepath', '')
        file_exists = os.path.exists(filepath) if filepath else None
        sessions.append({
            'session_id':  sid,
            'type':        s.get('type', 'youtube'),
            'name':        s.get('name', s.get('title', '')),
            'url':         s.get('url', ''),
            'status':      s.get('status', 'unknown'),
            'progress':    s.get('progress', 0),
            'message':     s.get('message', ''),
            'filepath':    filepath,
            'file_exists': file_exists,
        })
    sessions.reverse()
    return jsonify(sessions)



@app.route('/api/show-in-folder', methods=['POST'])
def api_show_in_folder():
    """Open OS file explorer at the downloaded file's location."""
    data = request.json
    filepath = (data.get('filepath') or '').strip()
    if not filepath:
        return jsonify({'error': 'No filepath provided'}), 400
    try:
        norm = os.path.normpath(filepath)
        if os.path.isfile(norm):
            if os.name == 'nt':
                subprocess.Popen(['explorer', '/select,', norm])
            elif sys.platform == 'darwin':
                subprocess.Popen(['open', '-R', norm])
            else:
                subprocess.Popen(['xdg-open', os.path.dirname(norm)])
            return jsonify({'success': True})
        elif os.path.isdir(norm):
            if os.name == 'nt':
                subprocess.Popen(['explorer', norm])
            elif sys.platform == 'darwin':
                subprocess.Popen(['open', norm])
            else:
                subprocess.Popen(['xdg-open', norm])
            return jsonify({'success': True})
        else:
            return jsonify({'error': 'file_not_found', 'filepath': filepath}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/open-file', methods=['POST'])
def api_open_file():
    """Open a downloaded file with the default OS application."""
    data = request.json
    filepath = (data.get('filepath') or '').strip()
    if not filepath:
        return jsonify({'error': 'No filepath provided'}), 400
    norm = os.path.normpath(filepath)
    if not os.path.isfile(norm):
        return jsonify({'error': 'file_not_found', 'filepath': filepath}), 404
    try:
        if os.name == 'nt':
            os.startfile(norm)
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', norm])
        else:
            subprocess.Popen(['xdg-open', norm])
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/pause/<session_id>', methods=['POST'])
def api_pause(session_id):
    """Pause an active download."""
    session = download_sessions.get(session_id)
    if not session:
        return jsonify({'error': 'Session not found'}), 404
    if session.get('status') != 'downloading':
        return jsonify({'success': True, 'status': session.get('status')}), 200

    # Pause yt-dlp / direct downloads (thread blocks on event.wait())
    evt = _pause_events.get(session_id)
    if evt:
        evt.clear()

    # Terminate aria2c process (it writes a .aria2 control file for later resume)
    proc = _running_procs.get(session_id)
    if proc and proc.poll() is None:
        try:
            proc.terminate()
        except Exception:
            pass

    session['status'] = 'paused'
    session['message'] = 'Paused'
    _save_sessions()
    return jsonify({'success': True})


@app.route('/api/resume/<session_id>', methods=['POST'])
def api_resume(session_id):
    """Resume a paused download."""
    session = download_sessions.get(session_id)
    if not session:
        return jsonify({'error': 'Session not found'}), 404
    if session.get('status') != 'paused':
        return jsonify({'success': True, 'status': session.get('status')}), 200

    session['status'] = 'downloading'
    session['message'] = 'Resuming...'

    evt = _pause_events.get(session_id)
    if evt:
        # Thread is still alive (yt-dlp or direct); just unblock it
        evt.set()
    else:
        # Thread exited (aria2c was terminated, or server restarted); restart download
        meta = session.get('_meta', {})
        dtype = meta.get('type', '')
        t = None
        if dtype == 'youtube':
            t = threading.Thread(target=_download_thread, args=(
                session_id, meta['url'], meta['download_type'],
                meta.get('video_format_id'), meta.get('audio_format_id'),
                meta.get('is_playlist', False), meta.get('skip_indices', []),
                session.get('save_dir')
            ))
        elif dtype == 'direct':
            t = threading.Thread(target=_download_direct_thread, args=(
                session_id, meta['url'], meta['filename'], session.get('save_dir')
            ))
        elif dtype == 'aria2c':
            args = meta.get('args', [])
            if not args:
                session['status'] = 'error'
                session['message'] = 'Cannot resume — original torrent file unavailable. Please re-upload.'
                _save_sessions()
                return jsonify({'error': session['message']}), 400
            t = threading.Thread(target=_run_aria2c, args=(session_id, args))
        elif dtype == 'video':
            t = threading.Thread(target=_download_video_best_thread, args=(session_id, meta['url'], session.get('save_dir')))
        else:
            session['status'] = 'error'
            session['message'] = 'Cannot resume this download type'
            _save_sessions()
            return jsonify({'error': session['message']}), 400
        t.daemon = True
        t.start()

    _save_sessions()
    return jsonify({'success': True})


@app.route('/api/retry/<session_id>', methods=['POST'])
def api_retry(session_id):
    """Resume/restart a failed or interrupted download, continuing from partial progress where possible."""
    session = download_sessions.get(session_id)
    if not session:
        return jsonify({'error': 'Session not found'}), 404
    status = session.get('status')
    if status == 'completed':
        # Allow re-download only when the file has been moved/deleted
        filepath = session.get('filepath', '')
        if filepath and os.path.exists(filepath):
            return jsonify({'error': 'File already exists — nothing to re-download.'}), 400
    elif status not in ('error', 'interrupted', 'paused'):
        return jsonify({'error': 'Can only retry failed or interrupted downloads'}), 400

    meta = session.get('_meta', {})
    dtype = meta.get('type') or session.get('type', '')
    url   = meta.get('url')  or session.get('url', '')

    if not dtype or not url:
        return jsonify({'error': 'Not enough info to restart — please start a new download.'}), 400

    session['status'] = 'downloading'
    session['progress'] = 0
    session['message'] = 'Resuming...'

    # Pass the stored save_dir so threads reuse the same folder and pick up partial files
    saved_dir = session.get('save_dir')

    t = None
    if dtype == 'youtube':
        vfid = meta.get('video_format_id')
        afid = meta.get('audio_format_id')
        if vfid and afid:
            t = threading.Thread(target=_download_thread, args=(
                session_id, url, meta.get('download_type', 'video'),
                vfid, afid,
                meta.get('is_playlist', False), meta.get('skip_indices', []),
                saved_dir
            ))
        else:
            t = threading.Thread(target=_download_video_best_thread, args=(session_id, url, saved_dir))
    elif dtype == 'direct':
        filename = meta.get('filename') or session.get('name') or url.split('/')[-1] or 'file'
        t = threading.Thread(target=_download_direct_thread, args=(session_id, url, filename, saved_dir))
    elif dtype in ('torrent', 'aria2c'):
        args = meta.get('args') or ([url] if url else [])
        if not args or not args[0]:
            return jsonify({'error': 'Torrent file unavailable — please re-upload the .torrent file.'}), 400
        t = threading.Thread(target=_run_aria2c, args=(session_id, args))
    elif dtype == 'video':
        t = threading.Thread(target=_download_video_best_thread, args=(session_id, url, saved_dir))
    else:
        return jsonify({'error': f'Unknown download type: {dtype}'}), 400

    t.daemon = True
    t.start()
    _save_sessions()
    return jsonify({'success': True})


@app.route('/api/remove/<session_id>', methods=['POST'])
def api_remove(session_id):
    """Remove a session from the list; optionally delete the downloaded file from disk."""
    session = download_sessions.pop(session_id, None)
    if not session:
        return jsonify({'error': 'Session not found'}), 404

    # Stop any active thread/process so it doesn't resurrect the removed session
    evt = _pause_events.pop(session_id, None)
    if evt:
        evt.clear()
    proc = _running_procs.pop(session_id, None)
    if proc and proc.poll() is None:
        try:
            proc.terminate()
        except Exception:
            pass

    delete_file = (request.json or {}).get('delete_file', False)
    deleted = False
    if delete_file:
        filepath = (session.get('filepath') or '').strip()
        if filepath and os.path.exists(filepath):
            try:
                if os.path.isfile(filepath):
                    os.unlink(filepath)
                    deleted = True
                elif os.path.isdir(filepath):
                    shutil.rmtree(filepath)
                    deleted = True
            except OSError as e:
                _save_sessions()
                return jsonify({'error': f'Could not delete file: {e}'}), 500

    _save_sessions()
    return jsonify({'success': True, 'deleted': deleted})


@app.route('/api/upload-torrent', methods=['POST'])
def api_upload_torrent():
    """Accept a .torrent file upload and start the download via aria2c."""
    if not ARIA2C_AVAILABLE:
        return jsonify({'error': _ARIA2C_INSTALL_HINT}), 503
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400
        f = request.files['file']
        if not f.filename.lower().endswith('.torrent'):
            return jsonify({'error': 'File must be a .torrent file'}), 400
        torrent_data = f.read()
        name = os.path.splitext(f.filename)[0] or 'torrent'
        session_id = str(uuid.uuid4())
        download_sessions[session_id] = {
            'status': 'downloading',
            'progress': 0,
            'message': 'Starting torrent...',
            'type': 'torrent',
            'name': name,
            'url': f.filename,
            'filepath': '',
            'save_dir': '',
            '_meta': {'type': 'aria2c', 'args': []},  # args filled by _run_aria2c_from_data
        }
        _save_sessions()
        thread = threading.Thread(
            target=_run_aria2c_from_data,
            args=(session_id, torrent_data, name)
        )
        thread.daemon = True
        thread.start()
        return jsonify({'success': True, 'session_id': session_id})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _run_aria2c_from_data(session_id, torrent_data, name):
    """Save .torrent bytes to a persistent file, run aria2c, then clean up."""
    perm_path = os.path.join(_get_app_data_dir(), f'torrent_{session_id}.torrent')
    try:
        os.makedirs(os.path.dirname(perm_path), exist_ok=True)
        with open(perm_path, 'wb') as f:
            f.write(torrent_data)
        # Update _meta so the resume endpoint can restart with this file
        if session_id in download_sessions:
            download_sessions[session_id].setdefault('_meta', {})['args'] = [perm_path]
        _run_aria2c(session_id, [perm_path])
    finally:
        # Keep the file if paused (needed for resume); delete otherwise
        status = download_sessions.get(session_id, {}).get('status', '')
        if os.path.exists(perm_path) and status != 'paused':
            try:
                os.unlink(perm_path)
            except OSError:
                pass


def _ensure_qr_code():
    """Generate Buy Me a Coffee QR code on first run if the file is missing."""
    qr_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static', 'qr-coffee.webp')
    if not os.path.exists(qr_path):
        try:
            qr = qrcode.QRCode(
                version=1,
                error_correction=qrcode.constants.ERROR_CORRECT_H,
                box_size=14,
                border=4,
            )
            qr.add_data('https://buymeacoffee.com/yosefmulatu')
            qr.make(fit=True)
            img = qr.make_image(fill_color='black', back_color='white')
            img.save(qr_path)
            print('☕ Support QR code generated')
        except Exception as e:
            print(f'⚠️  QR code generation skipped: {e}')


if __name__ == '__main__':
    # Use port from environment (set by Electron) or default to 5000
    port = int(os.environ.get('FLASK_PORT', 5000))
    debug_mode = os.environ.get('FLASK_DEBUG', '1') == '1'

    _load_sessions()
    _ensure_qr_code()

    print("\n" + "="*50)
    print("Afriway Downloader Server")
    print("="*50)
    print(f"Server running at: http://localhost:{port}")
    print("Downloads will be saved to:", _get_afriway_base())
    print("Proudly African - Inspired by Ethiopia")
    print("="*50 + "\n")

    app.run(debug=debug_mode, port=port, host='127.0.0.1')
