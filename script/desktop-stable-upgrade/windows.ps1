# One-time packaging check, only on the disposable first-stable candidate runner.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:BHARATCODE_VERSION -ne '1.15.51') {
    throw 'Requires the hosted first-stable candidate runner'
}
$asset = 'bharatcode-desktop-win-x64.exe'
$old = Join-Path $env:RUNNER_TEMP 'public-11546.exe'
$new = Join-Path $env:RUNNER_TEMP "candidate/windows-x64/$asset"
Invoke-WebRequest "https://github.com/BharatCode-ai/bharatcode-desktop/releases/download/desktop-beta-1.15.46/$asset" -OutFile $old
if ((Get-FileHash -LiteralPath $old -Algorithm SHA256).Hash -ne 'ce1554bd2530fba5ec27a09cecd7c1a84f62d4e2e8efd9cd666842905af794e0') { throw 'Baseline digest mismatch' }
function Install-Candidate([string] $file) {
    $p = Start-Process -FilePath $file -ArgumentList '/S','/currentuser' -PassThru -WindowStyle Hidden
    if (-not $p.WaitForExit(180000) -or $p.ExitCode -ne 0) { throw 'Installer did not finish successfully' }
}
function Read-Install {
    $rows = @(Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -match '^BharatCode(?: Beta)?(?: [0-9]+\.[0-9]+\.[0-9]+)?$' })
    if ($rows.Count -ne 1) { throw "Expected one per-user BharatCode installation; found $($rows.Count)" }
    return $rows[0]
}
Install-Candidate $old
$before = Read-Install
if ($before.DisplayVersion -ne '1.15.46') { throw 'Wrong baseline installed' }
$profile = Join-Path $env:APPDATA 'ai.bharatcode.desktop.beta'
[void][IO.Directory]::CreateDirectory($profile)
$marker = Join-Path $profile 'upgrade-test-only.txt'
[IO.File]::WriteAllText($marker, 'synthetic-settings-marker')
Install-Candidate $new
$after = Read-Install
if ($after.PSChildName -ne $before.PSChildName -or $after.DisplayVersion -ne $env:BHARATCODE_VERSION -or
    $after.DisplayName -notin @('BharatCode',"BharatCode $env:BHARATCODE_VERSION") -or
    [IO.File]::ReadAllText($marker) -ne 'synthetic-settings-marker') {
    throw 'Stable did not replace beta in place with the original profile intact'
}
Write-Host 'PASS: installed public 1.15.46 then stable; same uninstall ID, one install, preserved profile marker.'
