# -*- mode: python ; coding: utf-8 -*-
# One-directory build used by the NSIS installer.
# Output: dist/AfriWayDownloader_dir/AfriWayDownloader.exe  (+ sibling files)
from PyInstaller.utils.hooks import collect_all, collect_submodules

ytdlp_datas, ytdlp_binaries, ytdlp_hidden = collect_all('yt_dlp')
webview_datas, webview_binaries, webview_hidden = collect_all('webview')

block_cipher = None

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=ytdlp_binaries + webview_binaries,
    datas=[
        ('templates', 'templates'),
        ('static',    'static'),
    ] + ytdlp_datas + webview_datas,
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
    runtime_hooks=[],
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
    [],
    exclude_binaries=True,   # one-dir: binaries stay separate
    name='AfriWayDownloader',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    console=False,
    icon='static/afriway.ico',
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='AfriWayDownloader_dir',
)
