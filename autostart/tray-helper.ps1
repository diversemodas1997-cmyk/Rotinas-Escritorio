# Assistente de bandeja do Rotina Escritorio.
#
# Fica ao lado do relogio do Windows e escuta em 127.0.0.1:35010. Quando a
# pagina do quadro detecta uma alteracao com a janela minimizada / em segundo
# plano, ela chama http://127.0.0.1:35010/attention e este script restaura a
# janela do app e a traz para a frente - coisa que o navegador, sozinho, nao
# tem permissao para fazer.
#
# Nao requer Administrador. Escuta apenas em loopback (nada exposto na rede).

param(
    [int]$Port = 35010,
    [string]$WindowMatch = 'Rotina Escrit'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ─── API do Windows para achar e levantar a janela ──────────────────────────
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class TrayWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO fw);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);

    [StructLayout(LayoutKind.Sequential)]
    public struct FLASHWINFO {
        public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    // Janelas visiveis cujo titulo contem o texto procurado, maior area
    // primeiro: o Chrome mantem janelas auxiliares de 0px com o mesmo titulo.
    public static List<IntPtr> Find(string needle) {
        List<IntPtr> hits = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLength(h);
            if (len < 1) return true;
            StringBuilder sb = new StringBuilder(len + 1);
            GetWindowText(h, sb, sb.Capacity);
            if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) hits.Add(h);
            return true;
        }, IntPtr.Zero);
        hits.Sort(delegate(IntPtr a, IntPtr b) { return Area(b).CompareTo(Area(a)); });
        return hits;
    }

    static long Area(IntPtr h) {
        RECT r;
        if (!GetWindowRect(h, out r)) return 0;
        long w = r.Right - r.Left, t = r.Bottom - r.Top;
        if (w < 0 || t < 0) return 0;
        return w * t;
    }

    // Restaurar e trazer para a frente. O Windows so concede primeiro plano a
    // quem ja esta em primeiro plano, entao vamos do mais educado ao mais
    // insistente e paramos assim que a janela assumir o foco.
    public static bool Raise(IntPtr hWnd) {
        if (IsIconic(hWnd)) ShowWindow(hWnd, 9);   // SW_RESTORE (desminimiza)
        else ShowWindow(hWnd, 5);                  // SW_SHOW

        // 1) Sobe na pilha de janelas. Nao depende de direito de foreground:
        //    vira topmost por um instante e volta ao normal, ficando na frente.
        const uint NOSIZE = 0x0001, NOMOVE = 0x0002, NOACTIVATE = 0x0010, SHOWWINDOW = 0x0040;
        IntPtr TOPMOST = new IntPtr(-1), NOTOPMOST = new IntPtr(-2);
        SetWindowPos(hWnd, TOPMOST, 0, 0, 0, 0, NOSIZE | NOMOVE | NOACTIVATE | SHOWWINDOW);
        SetWindowPos(hWnd, NOTOPMOST, 0, 0, 0, 0, NOSIZE | NOMOVE | NOACTIVATE | SHOWWINDOW);
        BringWindowToTop(hWnd);

        // 2) Foco pela fila de entrada do thread que esta na frente.
        IntPtr fg = GetForegroundWindow();
        uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
        uint myThread = GetCurrentThreadId();
        bool attached = false;
        if (fgThread != 0 && fgThread != myThread) attached = AttachThreadInput(fgThread, myThread, true);
        SetForegroundWindow(hWnd);
        SwitchToThisWindow(hWnd, true);
        if (attached) AttachThreadInput(fgThread, myThread, false);

        // 3) Ainda recusado: um toque em ALT registra atividade de teclado e
        //    libera o direito de foreground por um instante.
        if (GetForegroundWindow() != hWnd) {
            const byte VK_MENU = 0x12; const uint KEYUP = 0x0002;
            keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
            keybd_event(VK_MENU, 0, KEYUP, UIntPtr.Zero);
            SetForegroundWindow(hWnd);
        }

        bool won = GetForegroundWindow() == hWnd;

        // 4) Ultimo recurso: piscar o botao na barra de tarefas.
        if (!won) {
            FLASHWINFO fw = new FLASHWINFO();
            fw.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO));
            fw.hwnd = hWnd;
            fw.dwFlags = 3;   // FLASHW_ALL
            fw.uCount = 5;
            fw.dwTimeout = 0;
            FlashWindowEx(ref fw);
        }
        return won;
    }
}
"@

# ─── Estado ────────────────────────────────────────────────────────────────
$script:Paused    = $false
$script:LastRaise = [DateTime]::MinValue
$script:Count     = 0

function Invoke-Raise {
    $wins = [TrayWin32]::Find($WindowMatch)
    if ($wins.Count -eq 0) { return $false }
    [TrayWin32]::Raise($wins[0])
    return $true
}

# ─── Icone (o "R" roxo do app, desenhado na hora) ──────────────────────────
function New-AppIcon {
    param([bool]$Alert = $false)
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $back = if ($Alert) { [System.Drawing.Color]::FromArgb(253, 171, 61) } else { [System.Drawing.Color]::FromArgb(108, 92, 231) }
    $brush = New-Object System.Drawing.SolidBrush $back
    $g.FillEllipse($brush, 0, 0, 31, 31)
    $font = New-Object System.Drawing.Font 'Segoe UI', 17, ([System.Drawing.FontStyle]::Bold)
    $fmt  = New-Object System.Drawing.StringFormat
    $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
    $g.DrawString('R', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 0, 32, 33), $fmt)
    $g.Dispose(); $brush.Dispose(); $font.Dispose()
    $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    return $icon
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon    = New-AppIcon
$notify.Text    = "Rotina Escritorio - assistente"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miStatus = $menu.Items.Add("Escutando na porta $Port")
$miStatus.Enabled = $false
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miPause = $menu.Items.Add("Pausar")
$miPause.add_Click({
    $script:Paused = -not $script:Paused
    $miPause.Text  = if ($script:Paused) { "Retomar" } else { "Pausar" }
    $notify.Icon   = New-AppIcon -Alert:$script:Paused
    $notify.Text   = if ($script:Paused) { "Rotina Escritorio - pausado" } else { "Rotina Escritorio - assistente" }
})

$miTest = $menu.Items.Add("Testar agora")
$miTest.add_Click({
    if (Invoke-Raise) {
        $notify.BalloonTipTitle = "Rotina Escritorio"
        $notify.BalloonTipText  = "Janela do quadro trazida para a frente."
    } else {
        $notify.BalloonTipTitle = "Rotina Escritorio"
        $notify.BalloonTipText  = "Nenhuma janela com '$WindowMatch' no titulo. Abra o quadro no navegador."
    }
    $notify.ShowBalloonTip(4000)
})

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$miQuit = $menu.Items.Add("Sair")
$miQuit.add_Click({
    $notify.Visible = $false
    try { $script:listener.Stop() } catch {}
    [System.Windows.Forms.Application]::ExitThread()
})

$notify.ContextMenuStrip = $menu
$notify.add_DoubleClick({ Invoke-Raise | Out-Null })

# ─── Servidor local ────────────────────────────────────────────────────────
# HttpListener exigiria reserva de URL (admin), entao falamos HTTP no braco
# sobre um TcpListener em loopback - sem privilegio nenhum.
try {
    $script:listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), $Port
    $script:listener.Start()
} catch {
    [System.Windows.Forms.MessageBox]::Show(
        "Nao foi possivel escutar na porta $Port.`n`nProvavelmente o assistente ja esta rodando (veja o icone roxo ao lado do relogio).`n`nDetalhe: $($_.Exception.Message)",
        "Rotina Escritorio", 'OK', 'Warning') | Out-Null
    $notify.Visible = $false
    exit 1
}

$CORS = "Access-Control-Allow-Origin: *`r`nAccess-Control-Allow-Methods: GET, POST, OPTIONS`r`nAccess-Control-Allow-Headers: *`r`nAccess-Control-Allow-Private-Network: true`r`nAccess-Control-Max-Age: 86400"

function Send-Response {
    param($Stream, [string]$Body)
    $bytes  = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $header = "HTTP/1.1 200 OK`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n$CORS`r`n`r`n"
    $hb = [System.Text.Encoding]::ASCII.GetBytes($header)
    $Stream.Write($hb, 0, $hb.Length)
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush()
}

# Timer da UI faz o accept sem bloquear a bandeja.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$timer.add_Tick({
    while ($script:listener.Pending()) {
        $client = $null
        try {
            $client = $script:listener.AcceptTcpClient()
            $client.ReceiveTimeout = 500
            $stream = $client.GetStream()

            $buf = New-Object byte[] 2048
            $read = 0
            try { $read = $stream.Read($buf, 0, $buf.Length) } catch {}
            $req = if ($read -gt 0) { [System.Text.Encoding]::ASCII.GetString($buf, 0, $read) } else { "" }
            $line = ($req -split "`r`n")[0]

            if ($line -match '^OPTIONS') {
                Send-Response $stream '{"ok":true}'
            }
            elseif ($line -match '/attention') {
                if (-not $script:Paused) {
                    $now = Get-Date
                    # Anti-repeticao: no maximo um salto a cada 3 segundos.
                    if (($now - $script:LastRaise).TotalSeconds -ge 3) {
                        $script:LastRaise = $now
                        $script:Count++
                        Invoke-Raise | Out-Null
                        $miStatus.Text = "Chamadas atendidas: $script:Count"
                    }
                }
                Send-Response $stream ('{"ok":true,"paused":' + $script:Paused.ToString().ToLower() + '}')
            }
            elseif ($line -match '/ping') {
                Send-Response $stream '{"ok":true,"app":"rotina-tray"}'
            }
            else {
                Send-Response $stream '{"ok":false}'
            }
        } catch {
        } finally {
            if ($client) { try { $client.Close() } catch {} }
        }
    }
})
$timer.Start()

$notify.BalloonTipTitle = "Rotina Escritorio"
$notify.BalloonTipText  = "Assistente ativo. A janela do quadro sera trazida para a frente quando houver alteracao."
$notify.ShowBalloonTip(3000)

[System.Windows.Forms.Application]::Run()

$timer.Stop()
try { $listener.Stop() } catch {}
$notify.Dispose()
