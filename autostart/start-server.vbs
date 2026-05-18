' Lancador silencioso do servidor Rotinas-Escritorio.
' 1. Executa start-server.bat sem janela visivel.
' 2. Aguarda a porta 3001 responder (ate 60s).
' 3. Abre o atalho do PWA "Rotina Escritorio" se encontrado.

Option Explicit
Dim fs, sh, scriptDir, batPath, appData, chromeAppsDir
Dim folder, file, lnkPath, lcName
Dim http, i, ready

Set fs = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

scriptDir = fs.GetParentFolderName(WScript.ScriptFullName)
batPath = fs.BuildPath(scriptDir, "start-server.bat")
If Not fs.FileExists(batPath) Then WScript.Quit 1

' 1) Lanca o servidor em background (janela oculta, sem aguardar termino)
sh.Run """" & batPath & """", 0, False

' 2) Aguarda a porta 3001 responder
ready = False
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.setTimeouts 1500, 1500, 1500, 1500
For i = 1 To 60
    On Error Resume Next
    http.open "GET", "http://localhost:3001/", False
    http.send
    If Err.Number = 0 Then
        If http.Status >= 200 And http.Status < 500 Then
            ready = True
            Exit For
        End If
    End If
    Err.Clear
    On Error GoTo 0
    WScript.Sleep 1000
Next

If Not ready Then WScript.Quit 0

' 3) Localiza o atalho do PWA por substring (portatil entre usuarios; evita acentos no codigo)
appData = sh.ExpandEnvironmentStrings("%APPDATA%")
chromeAppsDir = appData & "\Microsoft\Windows\Start Menu\Programs\Apps do Chrome"
If Not fs.FolderExists(chromeAppsDir) Then WScript.Quit 0

lnkPath = ""
Set folder = fs.GetFolder(chromeAppsDir)
For Each file In folder.Files
    lcName = LCase(file.Name)
    If InStr(lcName, "rotina") > 0 And InStr(lcName, "escrit") > 0 _
       And LCase(fs.GetExtensionName(file.Name)) = "lnk" Then
        lnkPath = file.Path
        Exit For
    End If
Next

If lnkPath <> "" Then
    sh.Run """" & lnkPath & """", 1, False
End If
