# Requires Git for Windows, Node.js with built-in SQLite support, and Caddy 2.
[CmdletBinding()]
param(
    [string]$ProjectDirectory = 'I:\IntendedUseStorage\Websites\ArifWebDashboard',
    [ValidatePattern('^([0-9]{1,3}\.){3}[0-9]{1,3}$')]
    [string]$LanAddress = '192.168.100.63',
    [string]$CaddyPath,
    [switch]$ConfigureFirewall
)

$ErrorActionPreference = 'Stop'
$repository = 'https://github.com/ItsOriginalYT/arif_web.dashboard.git'
$branch = 'default'

try {
    if (!(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $LanAddress -ErrorAction SilentlyContinue)) {
        throw "This computer does not have IP address $LanAddress. Run the script on the server and check its address with ipconfig."
    }
    if ($ConfigureFirewall) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'Run -ConfigureFirewall once from Administrator PowerShell.'
        }
        $ruleName = "ArifWebDashboard-LAN-$LanAddress"
        if (!(Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -Name $ruleName -DisplayName 'Arif WebDashboard LAN HTTPS' `
                -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $LanAddress `
                -LocalPort 8765 -RemoteAddress LocalSubnet -Profile Private | Out-Null
        }
        Write-Host 'Firewall rule ready for the local subnet on the Private network profile.'
        Write-Host 'Run this launcher again without -ConfigureFirewall in a normal PowerShell window.'
        return
    }

    if (!$CaddyPath) {
        $nearLauncher = Join-Path $PSScriptRoot 'caddy.exe'
        if (Test-Path -LiteralPath $nearLauncher -PathType Leaf) { $CaddyPath = $nearLauncher }
        else { $CaddyPath = (Get-Command caddy.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
    }
    if (!$CaddyPath -or !(Test-Path -LiteralPath $CaddyPath -PathType Leaf)) {
        throw 'Put the official Windows caddy.exe beside this launcher, or supply -CaddyPath.'
    }
    $CaddyPath = (Resolve-Path -LiteralPath $CaddyPath).Path

    $git = (Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    $node = (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (!$git) { throw 'Install Git for Windows, then reopen PowerShell.' }
    if (!$node) { throw 'Install Node.js, then reopen PowerShell.' }

    $ProjectDirectory = [IO.Path]::GetFullPath($ProjectDirectory)
    $driveRoot = [IO.Path]::GetPathRoot($ProjectDirectory)
    if (!(Test-Path -LiteralPath $driveRoot -PathType Container)) {
        throw "The destination drive $driveRoot is unavailable."
    }
    if (Test-Path -LiteralPath (Join-Path $ProjectDirectory '.git')) {
        $origin = & $git -C $ProjectDirectory config --local --get remote.origin.url
        if ($LASTEXITCODE -ne 0 -or ($origin -replace '\.git/?$|/$', '') -ne ($repository -replace '\.git$', '')) {
            throw 'The destination Git checkout has a different origin. Check the folder before continuing.'
        }
        $currentBranch = & $git -C $ProjectDirectory branch --show-current
        if ($LASTEXITCODE -ne 0 -or $currentBranch -ne $branch) {
            throw "The destination checkout must be on the '$branch' branch."
        }
        Write-Host "Updating Arif WebDashboard from GitHub ($branch)..."
        & $git -C $ProjectDirectory pull --ff-only origin $branch
        if ($LASTEXITCODE -ne 0) { throw 'Git could not update the checkout. Review the Git error above.' }
    }
    else {
        if (Test-Path -LiteralPath $ProjectDirectory) {
            if (!(Test-Path -LiteralPath $ProjectDirectory -PathType Container) -or
                (Get-ChildItem -LiteralPath $ProjectDirectory -Force | Select-Object -First 1)) {
                throw 'The destination already contains files. Use an empty folder for the first Git download.'
            }
        }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($ProjectDirectory)) | Out-Null
        Write-Host "Downloading Arif WebDashboard to $ProjectDirectory ..."
        & $git clone --branch $branch --single-branch -- $repository $ProjectDirectory
        if ($LASTEXITCODE -ne 0) { throw 'Git could not download the dashboard. Review the Git error above.' }
    }

    $origin = "https://$($LanAddress):8765"
    $caddyData = Join-Path $env:LOCALAPPDATA 'ArifWebDashboard'
    $launchSettings = @{
        ADAM_TRANSPORT = 'proxy'
        ADAM_HOST = '127.0.0.1'
        ADAM_PORT = '8766'
        ADAM_PUBLIC_ORIGIN = $origin
        XDG_DATA_HOME = $caddyData
    }
    $previous = @{}
    $proxy = $null
    $configFile = $null
    Push-Location -LiteralPath $ProjectDirectory
    try {
        foreach ($name in $launchSettings.Keys) {
            $previous[$name] = [Environment]::GetEnvironmentVariable($name)
            [Environment]::SetEnvironmentVariable($name, $launchSettings[$name])
        }
        $nodeOptions = @()
        if (Test-Path -LiteralPath '.env' -PathType Leaf) { $nodeOptions += '--env-file=.env' }

        # Use the same database location for the check, bootstrap and server.
        $checkAccounts = @'
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const databasePath = resolve(process.env.ADAM_DATA ?? 'data', 'dashboard.sqlite');
if (!existsSync(databasePath)) {
    console.log('setup');
} else {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
        const usersTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
        console.log(usersTable && database.prepare('SELECT 1 FROM users LIMIT 1').get() ? 'ready' : 'setup');
    } finally {
        database.close();
    }
}
'@
        $state = $checkAccounts | & $node @nodeOptions --disable-warning=ExperimentalWarning -
        if ($LASTEXITCODE -ne 0 -or $state -notin @('ready', 'setup')) {
            throw 'The dashboard database could not be checked. Review the error above.'
        }
        if ($state -eq 'setup') {
            $temporary = Read-Host 'Enter the temporary Administrator password' -AsSecureString
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($temporary)
            $previousEncoding = $OutputEncoding
            try {
                $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
                [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) | & $node @nodeOptions server.mjs bootstrap
                if ($LASTEXITCODE -ne 0) { throw 'Administrator setup failed. Review the error above.' }
            }
            finally {
                $OutputEncoding = $previousEncoding
                [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
                $temporary.Dispose()
            }
        }

        # Use separate Caddy storage so an existing installation keeps its configuration.
        [IO.Directory]::CreateDirectory($caddyData) | Out-Null
        $logFile = Join-Path $caddyData "caddy-$PID.log"
        $configFile = [IO.Path]::GetTempFileName()
        @"
{
    admin off
    persist_config off
    auto_https disable_redirects
    skip_install_trust
    default_sni $LanAddress
    servers {
        protocols h1 h2
    }
}

$origin {
    bind $LanAddress
    tls internal
    reverse_proxy 127.0.0.1:8766
}
"@ | Set-Content -LiteralPath $configFile -Encoding Ascii
        $arguments = @('run', '--config', ('"{0}"' -f $configFile), '--adapter', 'caddyfile')
        $proxy = Start-Process -FilePath $CaddyPath -ArgumentList $arguments -WindowStyle Hidden `
            -RedirectStandardError $logFile -PassThru
        if ($proxy.WaitForExit(1000)) {
            Get-Content -LiteralPath $logFile -Tail 20 | Write-Host
            throw "Caddy stopped during startup. See $logFile"
        }
        $rootCert = Join-Path $caddyData 'caddy\pki\authorities\local\root.crt'
        Write-Host "LAN dashboard: $origin"
        Write-Host "Public root certificate to trust on client devices: $rootCert"
        Write-Host 'Press Ctrl+C to stop the dashboard and its proxy.'
        & $node @nodeOptions server.mjs
        if ($LASTEXITCODE -ne 0) { throw "Arif WebDashboard exited with code $LASTEXITCODE." }
    }
    finally {
        if ($proxy -and !$proxy.HasExited) {
            $proxy.Kill()
            $proxy.WaitForExit(3000) | Out-Null
        }
        foreach ($name in $previous.Keys) {
            [Environment]::SetEnvironmentVariable($name, $previous[$name])
        }
        if ($configFile) { Remove-Item -LiteralPath $configFile -Force -ErrorAction SilentlyContinue }
        Pop-Location
    }
}
catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}
