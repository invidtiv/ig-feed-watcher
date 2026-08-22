; ═══════════════════════════════════════════════════════════════════════════
;  IG Feed Watcher — Inno Setup installer script (DRAFT — adapt before use)
;
;  Requires: Inno Setup 6 (free, https://jrsoftware.org/isinfo.php)
;  Build:    right-click → Compile, or:  ISCC.exe ig-feed-watcher.iss
;
;  Staging layout (put the clean distribution folder + portable Node here):
;    stage\
;      node.exe  npm.cmd  node_modules\...   <- portable Node v22.x from the
;                                                 official win-x64 .zip, with
;                                                 `npm install` already run so
;                                                 Chromium is bundled
;      watcher.js  server.js  ...            <- clean dist folder (HANDOFF §6)
;      hooks\on-new-post.js  windows\*.bat|*.ps1  api\  skills\
;      .env.example  sources.example.json  COOKIES-GUIDE.md  README.md
;
;  Notes:
;   • Bundled node.exe is NOT on PATH — the installer calls it by full path
;     ({app}\node.exe). windows\install-scheduled-task.ps1 already prefers a
;     bundled node.exe (falls back to PATH).
;   • {localappdata} install = NO admin/UAC, safe default for non-IT users.
;   • Never ship sources.json / cookies.json / .env.config / posts.db /
;     state.json / screenshots / logs — recipients paste their own cookies in
;     the web UI (🔑 Sources) and follow COOKIES-GUIDE.md.
; ═══════════════════════════════════════════════════════════════════════════

#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif
#define MyAppName "IG Feed Watcher"
#define MyAppPublisher "IG Feed Watcher"
#define Stage "stage"

[Setup]
; ⚠️ Replace with a freshly generated GUID (e.g. from an online GUID tool).
AppId={{8F4E0A32-9B1E-4E3A-8A5F-1C2D3E4F5A6B}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\IG Feed Watcher
DefaultGroupName=IG Feed Watcher
DisableProgramGroupPage=yes
OutputDir=..\..\dist
OutputBaseFilename=IG-Feed-Watcher-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\node.exe

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "schedtask"; Description: "Check Instagram for new posts every 5 minutes automatically"; GroupDescription: "Automatic checking:"; Flags: unchecked
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\node.exe"; Parameters: "server.js"; WorkingDir: "{app}"; Comment: "Open the IG Feed Watcher web app (http://localhost:4180)"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\node.exe"; Parameters: "server.js"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; Register the 5-minute scheduled task (only if the checkbox was ticked).
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\windows\install-scheduled-task.ps1"""; Flags: runhidden; Tasks: schedtask
; Open the web app when the wizard finishes.
Filename: "http://localhost:4180"; Description: "Open the IG Feed Watcher app"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Remove the scheduled task on uninstall (ignore errors if it never existed).
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\windows\uninstall-scheduled-task.ps1"""; Flags: runhidden
