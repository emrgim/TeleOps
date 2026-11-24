; TeleOps setup for Windows (Inno Setup 6). Built by packaging/build.mjs on GitHub Actions:
;   ISCC.exe /DAppVer=<version> /DSrc=<folder with TeleOps.vbs, runtime\, icon> /DOutDir=<dir> /DOutName=<file name> TeleOps.iss
; Installs for the current user only (no administrator rights), in %LOCALAPPDATA%\Programs\TeleOps.
; At the end TeleOps.vbs starts the background service, adds it to the sign-in programs and opens the page.

[Setup]
AppId={{6F2B1C8E-3D47-4B8A-9E51-2A7D0C94F3B6}
AppName=TeleOps
AppVersion={#AppVer}
AppVerName=TeleOps {#AppVer}
AppPublisher=TeleOps
AppPublisherURL=https://github.com/emrgim/TeleOps
AppSupportURL=https://github.com/emrgim/TeleOps/issues
AppUpdatesURL=https://github.com/emrgim/TeleOps/releases
DefaultDirName={localappdata}\Programs\TeleOps
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename={#OutName}
SetupIconFile={#Src}\TeleOps.ico
UninstallDisplayIcon={app}\TeleOps.ico
UninstallDisplayName=TeleOps
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=no
ShowLanguageDialog=auto

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "it"; MessagesFile: "compiler:Languages\Italian.isl"

[CustomMessages]
en.DeleteData=Also delete your TeleOps data (bot tokens, messages, settings)?
it.DeleteData=Eliminare anche i tuoi dati di TeleOps (token dei bot, messaggi, impostazioni)?

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#Src}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\TeleOps"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\TeleOps.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\TeleOps.ico"; Comment: "TeleOps"
Name: "{userdesktop}\TeleOps"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\TeleOps.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\TeleOps.ico"; Tasks: desktopicon

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\TeleOps.vbs"""; Description: "{cm:LaunchProgram,TeleOps}"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\uninstall.vbs"""; Flags: runhidden waituntilterminated; RunOnceId: "StopTeleOps"

[Code]
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Data: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    Data := ExpandConstant('{localappdata}\teleops');
    // the copy of the program TeleOps runs from (and updates itself in)
    DelTree(Data + '\runtime', True, True, True);
    if (not UninstallSilent) and (MsgBox(CustomMessage('DeleteData'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES) then
      DelTree(Data, True, True, True);
  end;
end;
