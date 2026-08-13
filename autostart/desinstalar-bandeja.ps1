# Remove a tarefa do Agendador que inicia o assistente de bandeja no logon
# e encerra a instancia que estiver rodando agora.
$taskName = 'RotinasEscritorio-Bandeja'

try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    Write-Host "Tarefa '$taskName' removida."
} catch {
    Write-Host "Tarefa '$taskName' nao estava registrada (nada a remover)."
}

# Encerra o processo do assistente (powershell rodando tray-helper.ps1).
$mortos = 0
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | ForEach-Object {
    if ($_.CommandLine -and $_.CommandLine -like '*tray-helper.ps1*') {
        try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $mortos++ } catch {}
    }
}

if ($mortos -gt 0) { Write-Host "Assistente encerrado ($mortos processo(s))." }
else { Write-Host "Nenhum assistente em execucao." }
