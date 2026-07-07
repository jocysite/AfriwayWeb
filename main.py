"""
Afriway Downloader — desktop entry point.
Starts Flask in a background thread, waits for it to be ready,
then opens a native pywebview window.
"""
import json
import os
import socket
import sys
import threading
import time


def _resource(rel):
    """Resolve a path relative to the bundle root (works both frozen and dev)."""
    if getattr(sys, 'frozen', False):
        base = sys._MEIPASS
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, rel)


PORT = 5050

_DEFAULT_WIDTH  = 1000
_DEFAULT_HEIGHT = 700
_MIN_WIDTH      = 860
_MIN_HEIGHT     = 600


def _get_size_file():
    if getattr(sys, 'frozen', False):
        data_dir = os.path.join(
            os.environ.get('APPDATA', os.path.expanduser('~')), 'AfriWayDownloader')
    else:
        data_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(data_dir, 'window.json')


def _load_window_size():
    try:
        with open(_get_size_file(), 'r') as f:
            d = json.load(f)
        w = max(_MIN_WIDTH,  int(d.get('width',  _DEFAULT_WIDTH)))
        h = max(_MIN_HEIGHT, int(d.get('height', _DEFAULT_HEIGHT)))
        return w, h
    except Exception:
        return _DEFAULT_WIDTH, _DEFAULT_HEIGHT


def _save_window_size(w, h):
    try:
        path = _get_size_file()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            json.dump({'width': w, 'height': h}, f)
    except Exception:
        pass


def _wait_for_flask(port, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            s = socket.create_connection(('127.0.0.1', port), timeout=0.5)
            s.close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


def _start_flask():
    from app import app, _load_sessions, _ensure_qr_code
    _load_sessions()
    _ensure_qr_code()
    # Bind to 0.0.0.0 so the Afriway mobile companion can reach this server over LAN
    app.run(host='0.0.0.0', port=PORT, debug=False, use_reloader=False, threaded=True)


def _compute_centered_xy(width, height):
    """Centre on the primary screen. Returns (None, None) if screen info is unavailable,
    which makes create_window fall back to its own default centring."""
    try:
        import webview
        scr = webview.screens[0]
        x = scr.x + max(0, (scr.width - width) // 2)
        y = scr.y + max(0, (scr.height - height) // 2)
        return x, y
    except Exception:
        return None, None


class Api:
    """JS-callable bridge (window.pywebview.api.*) for things the web page
    can't do on its own, like showing a native folder-picker dialog."""

    def __init__(self):
        self.window = None

    def pick_folder(self):
        if not self.window:
            return None
        import webview
        result = self.window.create_file_dialog(webview.FOLDER_DIALOG)
        return result[0] if result else None


def _build_tray_icon(window, quit_event):
    """System tray icon shown while the main window is hidden. Right-click gives
    'Open' (show the window again) and 'Exit' (actually quit the app)."""
    import pystray
    from PIL import Image

    icon_image = Image.open(_resource('static/afriway.ico'))

    def on_open(icon, item):
        window.show()

    def on_exit(icon, item):
        quit_event.set()
        icon.stop()
        window.destroy()

    menu = pystray.Menu(
        pystray.MenuItem('Open Afriway Downloader', on_open, default=True),
        pystray.MenuItem('Exit', on_exit),
    )
    return pystray.Icon('AfriwayDownloader', icon_image, 'Afriway Downloader', menu)


if __name__ == '__main__':
    # Start Flask server
    t = threading.Thread(target=_start_flask, daemon=True)
    t.start()

    if not _wait_for_flask(PORT):
        print("ERROR: Flask server did not start in time.", file=sys.stderr)
        sys.exit(1)

    import webview
    width, height = _load_window_size()
    x, y = _compute_centered_xy(width, height)
    api = Api()
    window = webview.create_window(
        'Afriway Downloader',
        f'http://127.0.0.1:{PORT}',
        width=width,
        height=height,
        x=x,
        y=y,
        min_size=(_MIN_WIDTH, _MIN_HEIGHT),
        js_api=api,
    )
    api.window = window

    quit_event = threading.Event()
    tray_icon = _build_tray_icon(window, quit_event)

    def on_closing():
        try:
            _save_window_size(window.width, window.height)
        except Exception:
            pass
        if quit_event.is_set():
            return None  # real quit (triggered from the tray's Exit item) — let it close
        window.hide()
        return False  # cancel the close — keep running in the system tray

    window.events.closing += on_closing

    tray_thread = threading.Thread(target=tray_icon.run, daemon=True)
    tray_thread.start()

    webview.start()

    try:
        tray_icon.stop()
    except Exception:
        pass
