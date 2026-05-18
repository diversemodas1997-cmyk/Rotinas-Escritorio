# Encerra o processo node.exe que esta servindo na porta 3001.
$port = 3001

$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
    Write-Host "Nenhum servidor escutando na porta $port."
    exit 0
}

$pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($processId in $pids) {
    try {
        $p = Get-Process -Id $processId -ErrorAction Stop
        Write-Host ("Encerrando PID {0} ({1})..." -f $processId, $p.ProcessName)
        Stop-Process -Id $processId -Force
    } catch {
        Write-Host ("Falha ao encerrar PID {0}: {1}" -f $processId, $_.Exception.Message)
    }
}
Write-Host "Concluido."
