"""
Flask backend for YouTube Downloader
"""
import logging
import os
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
ARIA2C_AVAILABLE = bool(shutil.which('aria2c'))

app = Flask(__name__)

# Disable Flask request logging for cleaner console
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)

# Store download sessions
download_sessions = {}

# Configurable download path (None = use system Downloads folder)
_download_path = None


def _get_download_path():
    global _download_path
    if _download_path and os.path.isdir(_download_path):
        return _download_path
    return get_downloads_folder()


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
    except (KeyError, ValueError) as e:
        print(f"❌ Data extraction error: {str(e)}\n")
        return jsonify({'error': f'Data extraction error: {str(e)}'}), 500


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
    except (KeyError, ValueError, IndexError) as e:
        print(f"❌ Data extraction error: {str(e)}\n")
        return jsonify({'error': f'Data extraction error: {str(e)}'}), 500


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
        # NEW: List of indices to skip
        skip_indices = data.get('skip_indices', [])

        if not url or not audio_format_id:
            return jsonify({'error': 'Missing required parameters'}), 400

        # Create session ID
        session_id = str(uuid.uuid4())
        download_sessions[session_id] = {
            'status': 'downloading',
            'progress': 0,
            'message': 'Starting download...',
            'type': 'youtube',
            'name': url,
            'url': url,
        }

        print(f"\n🚀 Starting download...")
        print(f"📥 Type: {download_type.upper()}")
        print(f"🔗 URL: {url}")
        if skip_indices:
            print(f"⏭️  Skipping videos: {skip_indices}")
        print()

        # Start download in background thread
        thread = threading.Thread(
            target=_download_thread,
            args=(session_id, url, download_type, video_format_id,
                  audio_format_id, is_playlist, skip_indices)
        )
        thread.daemon = True
        thread.start()

        return jsonify({
            'success': True,
            'session_id': session_id
        })

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


def _download_thread(session_id, url, download_type, video_format_id, audio_format_id, is_playlist, skip_indices):
    """Background thread for downloading with smart quality fallback"""
    try:
        # Use configured or system Downloads folder
        download_path = _get_download_path()

        # Create YouTube Downloads subfolder
        youtube_folder = os.path.join(download_path, 'YouTube Downloads')
        os.makedirs(youtube_folder, exist_ok=True)

        if is_playlist:
            output_template = os.path.join(
                youtube_folder,
                '%(playlist)s',
                '%(playlist_index)s - %(title)s.%(ext)s'
            )
        else:
            output_template = os.path.join(youtube_folder, '%(title)s.%(ext)s')

        last_video_percent = -1
        last_audio_percent = -1
        current_stage = None
        current_playlist_index = 0

        def progress_hook(d):
            """Handle download progress with clean console output"""
            nonlocal last_video_percent, last_audio_percent, current_stage, current_playlist_index

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
                'match_filter': match_filter,
                'noplaylist': not is_playlist,
                'quiet': False,
                'no_warnings': False,
            }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        print(f"\n✅ Download completed!")
        print(f"📁 Saved to: {youtube_folder}\n")

        download_sessions[session_id]['status'] = 'completed'
        download_sessions[session_id]['progress'] = 100
        download_sessions[session_id][
            'message'] = f'Download completed! Saved to: {youtube_folder}'

    except yt_dlp.utils.DownloadError as e:
        print(f"\n❌ Download error: {str(e)}\n")
        download_sessions[session_id]['status'] = 'error'
        download_sessions[session_id]['message'] = f'Download error: {str(e)}'
    except (OSError, KeyError) as e:
        print(f"\n❌ Error: {str(e)}\n")
        download_sessions[session_id]['status'] = 'error'
        download_sessions[session_id]['message'] = f'Error: {str(e)}'


@app.route('/api/get-download-path', methods=['GET'])
def api_get_download_path():
    return jsonify({'path': _get_download_path()})


@app.route('/api/set-download-path', methods=['POST'])
def api_set_download_path():
    global _download_path
    data = request.json
    path = (data.get('path') or '').strip()
    if not path:
        return jsonify({'error': 'Path is required'}), 400
    try:
        os.makedirs(path, exist_ok=True)
        _download_path = path
        return jsonify({'success': True, 'path': path})
    except OSError as e:
        return jsonify({'error': str(e)}), 400


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
        filename = url.split('/')[-1].split('?')[0] or 'file'
        session_id = str(uuid.uuid4())
        download_sessions[session_id] = {
            'status': 'downloading',
            'progress': 0,
            'message': 'Starting download...',
            'type': 'direct',
            'name': filename,
            'url': url,
        }
        thread = threading.Thread(
            target=_download_direct_thread,
            args=(session_id, url, filename)
        )
        thread.daemon = True
        thread.start()
        return jsonify({'success': True, 'session_id': session_id})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _download_direct_thread(session_id, url, filename):
    try:
        dest = os.path.join(_get_download_path(), filename)
        r = http_req.get(url, stream=True, timeout=30)
        r.raise_for_status()
        total = int(r.headers.get('Content-Length', 0))
        downloaded = 0
        with open(dest, 'wb') as f:
            for chunk in r.iter_content(chunk_size=65536):
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        pct = (downloaded / total) * 100
                        download_sessions[session_id]['progress'] = pct
                        download_sessions[session_id]['message'] = f'Downloading... {pct:.1f}%'
        download_sessions[session_id]['status'] = 'completed'
        download_sessions[session_id]['progress'] = 100
        download_sessions[session_id]['message'] = f'Saved to: {dest}'
        print(f'✅ Direct download complete: {dest}')
    except Exception as e:
        download_sessions[session_id]['status'] = 'error'
        download_sessions[session_id]['message'] = str(e)
        print(f'❌ Direct download error: {e}')


_ARIA2C_INSTALL_HINT = (
    'aria2c not found. Install it:\n'
    '  Windows:  winget install aria2  or  choco install aria2\n'
    '  macOS:    brew install aria2\n'
    '  Linux:    sudo apt install aria2\n'
    'Then restart the app.'
)


def _run_aria2c(session_id, args):
    """Run aria2c with the given extra args, updating session progress from stdout."""
    import re
    cmd = [
        'aria2c',
        f'--dir={_get_download_path()}',
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
            download_sessions[session_id]['status'] = 'completed'
            download_sessions[session_id]['progress'] = 100
            download_sessions[session_id]['message'] = 'Download complete!'
            print(f'✅ aria2c complete for session {session_id}')
        else:
            download_sessions[session_id]['status'] = 'error'
            download_sessions[session_id]['message'] = f'aria2c exited with code {proc.returncode}'
            print(f'❌ aria2c error (code {proc.returncode}) for session {session_id}')
    except Exception as e:
        download_sessions[session_id]['status'] = 'error'
        download_sessions[session_id]['message'] = str(e)
        print(f'❌ Torrent error: {e}')


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
        }
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
        }
        thread = threading.Thread(
            target=_download_video_best_thread,
            args=(session_id, url)
        )
        thread.daemon = True
        thread.start()
        return jsonify({'success': True, 'session_id': session_id})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _download_video_best_thread(session_id, url):
    def progress_hook(d):
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
        save_path = _get_download_path()
        ydl_opts = {
            'format': 'bestvideo+bestaudio/best',
            'merge_output_format': 'mp4',
            'outtmpl': os.path.join(save_path, '%(title)s.%(ext)s'),
            'progress_hooks': [progress_hook],
            'quiet': True,
            'no_warnings': True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get('title', url)
            download_sessions[session_id]['name'] = title
        download_sessions[session_id]['status'] = 'completed'
        download_sessions[session_id]['progress'] = 100
        download_sessions[session_id]['message'] = f'Saved: {title}'
        print(f'✅ Video download complete: {title}')
    except Exception as e:
        download_sessions[session_id]['status'] = 'error'
        download_sessions[session_id]['message'] = str(e)
        print(f'❌ Video download error: {e}')


@app.route('/api/downloads', methods=['GET'])
def api_downloads():
    """Return all download sessions as a list, newest first."""
    sessions = []
    for sid, s in download_sessions.items():
        sessions.append({
            'session_id': sid,
            'type':       s.get('type', 'youtube'),
            'name':       s.get('name', s.get('title', '')),
            'url':        s.get('url', ''),
            'status':     s.get('status', 'unknown'),
            'progress':   s.get('progress', 0),
            'message':    s.get('message', ''),
        })
    sessions.reverse()
    return jsonify(sessions)


@app.route('/api/browse-folder', methods=['GET'])
def api_browse_folder():
    """Open a native OS folder-picker dialog via tkinter in a subprocess and return the chosen path."""
    script = (
        "import tkinter as tk; from tkinter import filedialog; "
        "root = tk.Tk(); root.withdraw(); root.wm_attributes('-topmost', 1); "
        "path = filedialog.askdirectory(title='Select Download Folder'); "
        "print(path or '', end='')"
    )
    try:
        result = subprocess.run(
            [sys.executable, '-c', script],
            capture_output=True, text=True, timeout=120
        )
        path = result.stdout.strip()
        if path:
            return jsonify({'path': path})
        return jsonify({'cancelled': True})
    except subprocess.TimeoutExpired:
        return jsonify({'cancelled': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
        }
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
    """Save .torrent bytes to a temp file then hand off to aria2c."""
    import tempfile
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.torrent', delete=False) as tmp:
            tmp.write(torrent_data)
            tmp_path = tmp.name
        _run_aria2c(session_id, [tmp_path])
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _ensure_qr_code():
    """Generate Buy Me a Coffee QR code on first run if the file is missing."""
    qr_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static', 'qr-coffee.png')
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

    _ensure_qr_code()

    print("\n" + "="*50)
    print("Afriway Downloader Server")
    print("="*50)
    print(f"Server running at: http://localhost:{port}")
    print("Downloads will be saved to:", get_downloads_folder())
    print("Proudly African - Inspired by Ethiopia")
    print("="*50 + "\n")

    app.run(debug=debug_mode, port=port, host='127.0.0.1')
