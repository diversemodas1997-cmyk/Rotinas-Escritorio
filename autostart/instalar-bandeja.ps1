# Registra o assistente de bandeja para subir no logon do usuario atual e ja
# o inicia agora. Nao requer privilegio de Administrador.
#
# Este script roda em CADA maquina que abre o quadro - inclusive nas que so
# acessam o servidor pela rede.

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbsPath   = Join-Path $scriptDir 'tray-helper.vbs'
$taskName  = 'RotinasEscritorio-Bandeja'

if (-not (Test-Path $vbsPath)) {
    Write-Error "Arquivo tray-helper.vbs nao encontrado em $scriptDir"
    exit 1
}

Write-Host "Registrando tarefa '$taskName' para o usuario $env:USERNAME..."

$action    = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}"' -f $vbsPath)
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings  = New-ScheduledTaskSettingsSet `
                -StartWhenAvailable `
                -AllowStartIfOnBatteries `
                -DontStopIfGoingOnBatteries `
                -ExecutionTimeLimit ([TimeSpan]::Zero) `
                -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal `
                -UserId "$env:USERDOMAIN\$env:USERNAME" `
                -LogonType Interactive `
                -RunLevel Limited

Register-ScheduledTask `
    -TaskName  $taskName `
    -Action    $action `
    -Trigger   $trigger `
    -Settings  $settings `
    -Principal $principal `
    -Description 'Assistente de bandeja: traz a janela do quadro para a frente quando ha alteracao.' `
    -Force | Out-Null

Write-Host "OK! Tarefa criada - o assistente sobe sozinho no proximo logon."
Write-Host ""

# Ja liga agora, se ainda nao estiver rodando.
$emUso = $false
try {
    $t = New-Object System.Net.Sockets.TcpClient
    $t.Connect('127.0.0.1', 35010)
    $emUso = $true
    $t.Close()
} catch { }

if ($emUso) {
    Write-Host "O assistente ja estava rodando (icone roxo 'R' ao lado do relogio)." -ForegroundColor Yellow
} else {
    Write-Host "Iniciando agora..."
    & wscript.exe $vbsPath
    Start-Sleep -Seconds 3
    Write-Host "Pronto. Procure o icone roxo 'R' ao lado do relogio." -ForegroundColor Green
}

Write-Host ""
Write-Host "Teste: clique com o botao direito no icone -> 'Testar agora'."
Write-Host "A janela do quadro deve pular para a frente."
Write-Host ""
Write-Host "Para desativar: duplo-clique em DESINSTALAR-BANDEJA.bat"
