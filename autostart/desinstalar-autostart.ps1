# Remove a tarefa do Agendador que inicia o servidor no logon.
$taskName = 'RotinasEscritorio-AutoStart'

try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    Write-Host "Tarefa '$taskName' removida."
} catch {
    Write-Host "Tarefa '$taskName' nao estava registrada (nada a remover)."
}
