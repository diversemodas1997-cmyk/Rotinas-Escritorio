# Registra uma tarefa no Agendador de Tarefas do Windows para iniciar o
# servidor Rotinas-Escritorio automaticamente no logon do usuario atual.
# Nao requer privilegio de Administrador.

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbsPath   = Join-Path $scriptDir 'start-server.vbs'
$taskName  = 'RotinasEscritorio-AutoStart'

if (-not (Test-Path $vbsPath)) {
    Write-Error "Arquivo start-server.vbs nao encontrado em $scriptDir"
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
    -Description 'Inicia o servidor Node do Quadro Rotinas-Escritorio no logon.' `
    -Force | Out-Null

Write-Host ""
Write-Host "OK! Tarefa criada. Sera executada automaticamente no proximo logon do Windows."
Write-Host ""
Write-Host "Para iniciar o servidor AGORA (sem reiniciar o Windows), execute:" -ForegroundColor Yellow
Write-Host "  Start-ScheduledTask -TaskName '$taskName'" -ForegroundColor Yellow
Write-Host ""
Write-Host "Para verificar se esta funcionando, abra: http://localhost:3001"
Write-Host "Log de execucao: $scriptDir\server.log"
