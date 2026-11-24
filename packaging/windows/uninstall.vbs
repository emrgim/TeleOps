' Run by the TeleOps uninstaller: stops TeleOps and removes it from the programs started at sign-in.
' The data (%LOCALAPPDATA%\teleops) is deleted by the uninstaller only if you say so.
Option Explicit
Dim sh, fso, data, rt, pid, f
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
data = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\teleops"
rt = data & "\runtime"
On Error Resume Next
' run.vbs (the background supervisor) stops restarting TeleOps when this file exists
If fso.FolderExists(rt) Then fso.CreateTextFile(rt & "\stop", True).Close
sh.RegDelete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run\TeleOps"
pid = ""
If fso.FileExists(data & "\service.lock") Then
  Set f = fso.OpenTextFile(data & "\service.lock", 1)
  If Not f.AtEndOfStream Then pid = Trim(f.ReadAll)
  f.Close
End If
If pid <> "" Then sh.Run "taskkill /PID " & pid & " /F", 0, True
WScript.Sleep 4000
If fso.FileExists(sh.SpecialFolders("Programs") & "\TeleOps.lnk") Then fso.DeleteFile sh.SpecialFolders("Programs") & "\TeleOps.lnk", True
