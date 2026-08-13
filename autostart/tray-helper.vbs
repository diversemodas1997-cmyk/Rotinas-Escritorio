' Lancador silencioso do assistente de bandeja do Rotina Escritorio.
' Sobe o tray-helper.ps1 sem piscar janela de console.

Option Explicit
Dim fs, sh, scriptDir, ps1Path

Set fs = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

scriptDir = fs.GetParentFolderName(WScript.ScriptFullName)
ps1Path = fs.BuildPath(scriptDir, "tray-helper.ps1")
If Not fs.FileExists(ps1Path) Then WScript.Quit 1

sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1Path & """", 0, False
