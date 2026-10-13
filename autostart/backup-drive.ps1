# Copia o banco do Rotinas-Escritorio para o Google Drive, tirado NA HORA.
#
# Antes levava o server\backups\database.<data>.sqlite que o servidor grava ao
# subir -- uma foto da manha, sem nada do que foi lancado no dia. Agora o
# server\copia-banco.js tira a copia no momento em que esta tarefa roda, com a
# API de backup do SQLite (consistente mesmo em modo WAL -- copiar o
# database.sqlite direto daria um arquivo quase vazio) e confere antes de
# entregar. O nome no Drive segue database.<data>.sqlite: a rodada mais recente
# do dia substitui a anterior, e guardamos $Manter dias.
#
# Roda pela tarefa 'RotinasEscritorio-Backup-Drive' (instalar-backup-drive.ps1).
# Log: autostart\backup-drive.log

param(
  [string] $Destino = 'J:\Meu Drive\Backup Rotinas-Escritorio',
  [int]    $Manter  = 30
)

$ErrorActionPreference = 'Stop'
$aqui   = Split-Path -Parent $MyInvocation.MyCommand.Path
$origem = Join-Path $aqui '..\server\backups'
$log    = Join-Path $aqui 'backup-drive.log'
function Anotar($t) { Add-Content -Path $log -Value ("[{0:yyyy-MM-dd HH:mm}] {1}" -f (Get-Date), $t) -Encoding UTF8 }

try {
  # O Drive so existe como J: com a sessao aberta. Sem ele, gravar criaria a
  # pasta no disco local e daria a falsa impressao de backup na nuvem.
  $raiz = [System.IO.Path]::GetPathRoot($Destino)
  if ($raiz -and -not (Test-Path $raiz)) { Anotar "FALHA: unidade $raiz indisponivel (Google Drive fora do ar?). Nada gravado."; exit 1 }

  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
  $nome  = 'database.{0:yyyy-MM-dd}.sqlite' -f (Get-Date)
  $copia = Join-Path $origem $nome
  $saida = & $node (Join-Path $aqui '..\server\copia-banco.js') $copia 2>&1
  if ($LASTEXITCODE -ne 0) { Anotar "FALHA: copia do banco nao saiu: $saida"; exit 1 }
  $ultimo = Get-Item $copia

  if (-not (Test-Path $Destino)) { New-Item -ItemType Directory -Path $Destino | Out-Null }
  Copy-Item $ultimo.FullName (Join-Path $Destino $ultimo.Name) -Force
  Anotar ("ok  {0} ({1:N0} KB, tirado na hora: {2}) -> {3}" -f $ultimo.Name, ($ultimo.Length / 1KB), $saida, $Destino)

  $antigos = Get-ChildItem $Destino -Filter 'database.????-??-??.sqlite' | Sort-Object Name
  if ($antigos.Count -gt $Manter) {
    $antigos | Select-Object -First ($antigos.Count - $Manter) | ForEach-Object { Remove-Item $_.FullName; Anotar "apagado (mais de $Manter): $($_.Name)" }
  }
} catch {
  Anotar "FALHA: $($_.Exception.Message)"
  exit 1
}
