# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all, collect_submodules, collect_data_files

# Collect yt-dlp (has hundreds of extractors that must be bundled)
ytdlp_datas, ytdlp_binaries, ytdlp_hidden = collect_all('yt_dlp')

# Collect pywebview
webview_datas, webview_binaries, webview_hidden = collect_all('webview')

# Collect certifi CA bundle (needed for SSL connections to YouTube etc.)
try:
    certifi_datas = collect_data_files('certifi')
except Exception:
    certifi_datas = []

block_cipher = None

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=ytdlp_binaries + webview_binaries,
    datas=[
        ('templates', 'templates'),
        ('static',    'static'),
    ] + ytdlp_datas + webview_datas + certifi_datas,
    hiddenimports=(
        ytdlp_hidden
        + webview_hidden
        + collect_submodules('yt_dlp')
        + [
            'flask', 'werkzeug', 'werkzeug.serving', 'werkzeug.debug',
            'jinja2', 'jinja2.ext',
            'qrcode', 'qrcode.image.pil',
            'PIL', 'PIL.Image',
            'requests',
            'clr_loader',
            'pythonnet',
            'pystray',
        ]
    ),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=['rthook_afriway.py'],
    excludes=['tkinter', 'matplotlib', 'numpy', 'pandas', 'scipy'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='AfriWayDownloader',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,          # no console window
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='static/afriway.ico',
)
