; ═══════════════════════════════════════════════════════════════════════════
;  IG Feed Watcher — Inno Setup installer script (Solution C)
;
;  Requires: Inno Setup 6 (free, https://jrsoftware.org/isinfo.php)
;  Build:    right-click → Compile, or:  ISCC.exe ig-feed-watcher.iss
;
;  Staging layout (windows\installer\stage\):
;    stage\
;      node.exe  npm.cmd  node_modules\...   <- portable Node v22.x (official
;                                                 win-x64 .zip) + `npm install`
;                                                 already run (Chromium bundled
;                                                 in stage\.puppeteer-cache)
;      watcher.js  server.js  ...            <- clean dist folder (HANDOFF §6)
;      hooks\on-new-post.js  windows\*.bat|*.ps1  api\  skills\
;      .env.example  sources.example.json  COOKIES-GUIDE.md  README.md
;      .puppeteer-cache\chrome\...\chrome.exe <- bundled Chromium (M2 model)
;
;  Notes:
;   • Bundled node.exe is NOT on PATH — the installer calls it by full path
;     ({app}\node.exe). windows\install-scheduled-task.ps1 already prefers a
;     bundled node.exe (falls back to PATH).
;   • {localappdata} install = NO admin/UAC, safe default for non-IT users.
;   • Never ship sources.json / cookies.json / .env.config / posts.db /
;     state.json / screenshots / logs — recipients paste their own cookies in
;     the web UI (🔑 Sources) and follow COOKIES-GUIDE.md.
;   • Before compiling, run windows\installer\prepare-stage.ps1 — it refreshes
;     the stage from the repo and strips the personal "Photos" group from
;     stage\groups.json (recipients get a clean group seed).
;   • The "Create a desktop icon" wizard task is checked by default.
; ═══════════════════════════════════════════════════════════════════════════

#ifndef MyAppVersion
  #define MyAppVersion "1.5.0"
#endif
#define MyAppName "IG Feed Watcher"
#define MyAppPublisher "IG Feed Watcher"
#define Stage "stage"

[Setup]
AppId={{6361D9A1-7EE6-45A8-BEAB-700DDD38C519}
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
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\node.exe"; Parameters: "server.js"; WorkingDir: "{app}"; Comment: "Open the IG Feed Watcher web app (http://localhost:4180)"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\node.exe"; Parameters: "server.js"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; Create .env.config from the template on first install (never ship real secrets).
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\windows\create-env-config.ps1"""; Flags: runhidden; StatusMsg: "Creating configuration..."
; Register the 5-minute scheduled task (only if the checkbox was ticked).
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\windows\install-scheduled-task.ps1"""; Flags: runhidden; Tasks: schedtask
; Open the web app when the wizard finishes.
Filename: "http://localhost:4180"; Description: "Open the IG Feed Watcher app"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Remove the scheduled task on uninstall (ignore errors if it never existed).
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\windows\uninstall-scheduled-task.ps1"""; Flags: runhidden
