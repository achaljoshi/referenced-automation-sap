/**
 * The PowerShell bridge that talks to a running SAP GUI over its COM
 * Scripting API. Kept as a string here (not a separate .ps1) so it ships in
 * dist with no build-copy step and the exact text that runs is visible in one
 * reviewable place - `npx sap-gui-doctor --print-bridge` prints it, for
 * whoever has to approve a script before it runs on a managed desktop.
 *
 * What it does and doesn't do: it reads one JSON command per line on stdin
 * and writes one JSON reply per line on stdout. It attaches to (or opens) a
 * SAP Logon connection the user already has, then performs exactly the
 * property reads/writes and method calls it is asked to - the same calls a
 * recorded VBScript makes. No network access, nothing installed, nothing
 * persisted, no registry or file changes (apart from a screenshot when asked). The one
 * program it can start is SAP Logon, from the path you configure, and only when
 * connecting to a connection by name while SAP Logon is not already running.
 *
 * ASCII only on purpose: Windows PowerShell 5.1 reads a script without a
 * byte-order mark using the system code page, which would corrupt anything else.
 */
export const BRIDGE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$script:session = $null

function Send-Reply($rid, $ok, $value, $message, $code) {
    $reply = [ordered]@{ rid = $rid; ok = $ok }
    if ($ok) { $reply['value'] = $value } else { $reply['error'] = $message; $reply['code'] = $code }
    [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Flush()
}

function Invoke-Com($target, $name, $comArgs) {
    return [System.__ComObject].InvokeMember($name, [System.Reflection.BindingFlags]::InvokeMethod, $null, $target, $comArgs)
}

function Get-ComProperty($target, $name, $comArgs) {
    return [System.__ComObject].InvokeMember($name, [System.Reflection.BindingFlags]::GetProperty, $null, $target, $comArgs)
}

function Set-ComProperty($target, $name, $value) {
    [System.__ComObject].InvokeMember($name, [System.Reflection.BindingFlags]::SetProperty, $null, $target, [object[]]@($value)) | Out-Null
}

function Convert-Out($value) {
    if ($null -eq $value) { return $null }
    if ($value -is [string] -or $value -is [bool] -or $value -is [int] -or $value -is [long] -or $value -is [double] -or $value -is [single] -or $value -is [int16] -or $value -is [decimal]) { return $value }
    return [string]$value
}

function Try-GetScriptingEngine {
    try {
        $rot = New-Object -ComObject 'SapROTWr.SapROTWrapper'
        $entry = Invoke-Com $rot 'GetROTEntry' ([object[]]@('SAPGUI'))
        if ($null -ne $entry) { return ,(Invoke-Com $entry 'GetScriptingEngine' $null) }
    } catch { }
    try {
        Add-Type -AssemblyName Microsoft.VisualBasic
        $auto = [Microsoft.VisualBasic.Interaction]::GetObject('SAPGUI')
        return ,(Invoke-Com $auto 'GetScriptingEngine' $null)
    } catch { }
    return $null
}

# $logonPath is only used when SAP Logon is not running yet: it is started
# (the same as double-clicking its icon) and we wait for its scripting engine.
function Get-ScriptingEngine($logonPath) {
    $engine = Try-GetScriptingEngine
    if ($null -ne $engine) { return ,$engine }
    if ([string]::IsNullOrEmpty($logonPath)) {
        throw 'SAP Logon is not running, so there is no SAP GUI scripting engine to attach to. Start SAP Logon, or set SAP_GUI_LOGON_PATH so it can be started for you.'
    }
    if (-not (Test-Path -LiteralPath $logonPath)) {
        throw ('SAP Logon is not running and SAP_GUI_LOGON_PATH does not exist: ' + $logonPath)
    }
    Start-Process -FilePath $logonPath | Out-Null
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $engine = Try-GetScriptingEngine
        if ($null -ne $engine) { return ,$engine }
    }
    throw 'Started SAP Logon but its scripting engine did not appear within 60 seconds. Is scripting enabled (SAP GUI Options > Accessibility and Scripting > Scripting)?'
}

function Find-Element($id) {
    if ([string]::IsNullOrEmpty($id)) { return ,$script:session }
    return ,(Invoke-Com $script:session 'FindById' ([object[]]@($id)))
}

# SAP's COM layer rejects 64-bit integers; JSON numbers can arrive as Int64.
function Convert-Arg($value) {
    if ($value -is [long] -and $value -ge [int]::MinValue -and $value -le [int]::MaxValue) { return [int]$value }
    return $value
}

function Get-CallArgs($raw) {
    if ($null -eq $raw -or @($raw).Count -eq 0) { return $null }
    return [object[]]@(@($raw) | ForEach-Object { Convert-Arg $_ })
}

# Steps through objects the way a recorded line does: .columns.elementAt(1).width
# reads columns, then elementAt with 1, then acts on the result. VBScript does not
# distinguish property reads from method calls, so neither does this.
function Resolve-Via($target, $via) {
    $current = $target
    $flags = [System.Reflection.BindingFlags]'GetProperty,InvokeMethod'
    foreach ($link in @($via)) {
        if ($null -eq $link) { continue }
        $current = [System.__ComObject].InvokeMember([string]$link.member, $flags, $null, $current, (Get-CallArgs $link.args))
    }
    return ,$current
}

Send-Reply 0 $true 'ready' $null $null

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $cmd = $null
    $rid = 0
    try {
        $cmd = $line | ConvertFrom-Json
        $rid = $cmd.rid
        switch ($cmd.op) {
            'ping' { Send-Reply $rid $true 'pong' $null $null }
            'attach' {
                $engine = Get-ScriptingEngine $null
                $connection = Get-ComProperty $engine 'Children' ([object[]]@([int]$cmd.connectionIndex))
                $script:session = Get-ComProperty $connection 'Children' ([object[]]@([int]$cmd.sessionIndex))
                Send-Reply $rid $true $null $null $null
            }
            'open' {
                $engine = Get-ScriptingEngine ([string]$cmd.logonPath)
                $connection = Invoke-Com $engine 'OpenConnection' ([object[]]@([string]$cmd.connectionName))
                $script:session = Get-ComProperty $connection 'Children' ([object[]]@(0))
                Send-Reply $rid $true $null $null $null
            }
            'busy' { Send-Reply $rid $true ([bool](Get-ComProperty $script:session 'Busy' $null)) $null $null }
            'exists' {
                $found = $false
                try { $found = ($null -ne (Find-Element $cmd.id)) } catch { $found = $false }
                Send-Reply $rid $true $found $null $null
            }
            'get' {
                $target = Resolve-Via (Find-Element $cmd.id) $cmd.via
                Send-Reply $rid $true (Convert-Out (Get-ComProperty $target $cmd.prop $null)) $null $null
            }
            'set' {
                $target = Resolve-Via (Find-Element $cmd.id) $cmd.via
                Set-ComProperty $target $cmd.prop (Convert-Arg $cmd.value)
                Send-Reply $rid $true $null $null $null
            }
            'call' {
                $target = Resolve-Via (Find-Element $cmd.id) $cmd.via
                $result = Invoke-Com $target $cmd.method (Get-CallArgs $cmd.args)
                Send-Reply $rid $true (Convert-Out $result) $null $null
            }
            'children' {
                $parent = Find-Element $cmd.id
                $kids = Get-ComProperty $parent 'Children' $null
                $count = [int](Get-ComProperty $kids 'Count' $null)
                $items = New-Object System.Collections.ArrayList
                for ($i = 0; $i -lt $count; $i++) {
                    $kid = Invoke-Com $kids 'ElementAt' ([object[]]@($i))
                    $text = ''
                    try { $text = [string](Get-ComProperty $kid 'Text' $null) } catch { }
                    [void]$items.Add([ordered]@{
                        id = [string](Get-ComProperty $kid 'Id' $null)
                        type = [string](Get-ComProperty $kid 'Type' $null)
                        name = [string](Get-ComProperty $kid 'Name' $null)
                        text = $text
                    })
                }
                Send-Reply $rid $true $items.ToArray() $null $null
            }
            'quit' { Send-Reply $rid $true $null $null $null; exit 0 }
            default { throw ('Unknown op ' + $cmd.op) }
        }
    } catch {
        $message = $_.Exception.Message
        if ($_.Exception.InnerException) { $message = $_.Exception.InnerException.Message }
        $code = 'ERROR'
        if ($message -match 'could not be found') { $code = 'NOT_FOUND' }
        Send-Reply $rid $false $null $message $code
    }
}
`;
