; Afriway Downloader — NSIS Installer Script
; Requires NSIS 3.x  (https://nsis.sourceforge.io)
; Build: makensis installer.nsi
;        (or run build_installer.bat)

!define APP_NAME      "Afriway Downloader"
!define APP_EXE       "AfriWayDownloader.exe"
!define APP_VERSION   "1.0"
!define PUBLISHER     "Yosef Mulatu"
!define INSTALL_DIR   "$PROGRAMFILES64\Afriway Downloader"
!define REG_KEY       "Software\Microsoft\Windows\CurrentVersion\Uninstall\AfriWayDownloader"
!define SRC_DIR       "dist\AfriWayDownloader_dir"

Name            "${APP_NAME}"
OutFile         "dist\AfriWayDownloader-Setup-${APP_VERSION}.exe"
InstallDir      "${INSTALL_DIR}"
InstallDirRegKey HKLM "${REG_KEY}" "InstallLocation"
RequestExecutionLevel admin
SetCompressor   /SOLID lzma
Icon            "static\afriway.ico"
UninstallIcon   "static\afriway.ico"

;----- Pages ---------------------------------------------------------------
!include "MUI2.nsh"

!define MUI_ICON   "static\afriway.ico"
!define MUI_UNICON "static\afriway.ico"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN         "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT    "Launch Afriway Downloader"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

;----- Install -------------------------------------------------------------
Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${SRC_DIR}\*.*"

  ; Desktop shortcut
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"

  ; Start menu
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut  "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortCut  "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk"   "$INSTDIR\Uninstall.exe"

  ; Registry (for Add/Remove Programs)
  WriteRegStr   HKLM "${REG_KEY}" "DisplayName"      "${APP_NAME}"
  WriteRegStr   HKLM "${REG_KEY}" "DisplayVersion"   "${APP_VERSION}"
  WriteRegStr   HKLM "${REG_KEY}" "Publisher"        "${PUBLISHER}"
  WriteRegStr   HKLM "${REG_KEY}" "InstallLocation"  "$INSTDIR"
  WriteRegStr   HKLM "${REG_KEY}" "UninstallString"  "$INSTDIR\Uninstall.exe"
  WriteRegDWORD HKLM "${REG_KEY}" "NoModify"         1
  WriteRegDWORD HKLM "${REG_KEY}" "NoRepair"         1

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

;----- Uninstall -----------------------------------------------------------
Section "Uninstall"
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  DeleteRegKey HKLM "${REG_KEY}"
SectionEnd
