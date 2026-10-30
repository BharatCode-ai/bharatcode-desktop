param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [string]$AuthUrl = 'https://auth.bharatcode.ai',
    [string]$ApiBaseUrl = 'https://auth.bharatcode.ai',
    [string]$ProfileRoot,
    [switch]$DeliverCallback,
    [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
$exe = (Get-Item -LiteralPath $Executable).FullName
if ((Get-Item -LiteralPath $exe).PSIsContainer) { throw 'Provide the extracted application EXE, not a directory.' }
if (!(Test-Path -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($exe)) 'resources\app.asar'))) {
    throw 'Use the extracted app beside resources\app.asar, never the NSIS installer.'
}
if ([string]::IsNullOrWhiteSpace($AuthUrl) -or [string]::IsNullOrWhiteSpace($ApiBaseUrl)) { throw 'Both endpoint overrides are required.' }
if (([uri]$ApiBaseUrl).Host -in @('bharatcode.ai', 'www.bharatcode.ai')) { throw 'This rehearsal launcher cannot target the production API.' }
if ($DeliverCallback -and !$ProfileRoot) { throw 'Callback delivery requires the original test ProfileRoot.' }
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (!$ProfileRoot) { $ProfileRoot = Join-Path $temp ('bharatcode-auth-test-' + [guid]::NewGuid().ToString('N')) }
$root = [IO.Path]::GetFullPath($ProfileRoot)
if (![IO.Path]::GetDirectoryName($root).Equals($temp.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) -or
    ![IO.Path]::GetFileName($root).StartsWith('bharatcode-auth-test-')) { throw 'Use a fresh test directory directly under TEMP.' }
$marker = Join-Path $root '.native-auth-test'
if (Test-Path -LiteralPath $root) {
    if (((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) -or !(Test-Path -LiteralPath $marker)) {
        throw 'Refusing an existing unrelated or redirected profile.'
    }
} else {
    $null = New-Item -ItemType Directory -Path $root
    $null = New-Item -ItemType File -Path $marker
}
foreach ($dir in @('roaming', 'local', 'temp', 'workspace')) {
    $null = New-Item -ItemType Directory -Path (Join-Path $root $dir) -Force
}
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $exe
$start.WorkingDirectory = Join-Path $root 'workspace'
$start.UseShellExecute = $false
$start.EnvironmentVariables.Clear()
foreach ($name in @('SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'ComSpec', 'USERNAME', 'USERDOMAIN', 'NUMBER_OF_PROCESSORS')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($null -ne $value) { $start.EnvironmentVariables[$name] = $value }
}
$isolated = @{
    HOME = $root; USERPROFILE = $root; OPENCODE_TEST_HOME = $root
    APPDATA = (Join-Path $root 'roaming'); LOCALAPPDATA = (Join-Path $root 'local')
    TEMP = (Join-Path $root 'temp'); TMP = (Join-Path $root 'temp')
    BHARATCODE_TEST_ONBOARDING = '1'; OPENCODE_SIDECAR_V2 = '0'
    BHARATCODE_AUTH_URL = $AuthUrl; BHARATCODE_API_BASE_URL = $ApiBaseUrl
    OPENCODE_DISABLE_MODELS_FETCH = 'true'
    OPENCODE_TEST_MANAGED_CONFIG_DIR = (Join-Path $root 'managed')
}
foreach ($name in $isolated.Keys) { $start.EnvironmentVariables[$name] = $isolated[$name] }
if ($DeliverCallback) {
    # No OS protocol registration, shell-history argument or callback logging.
    $secure = Read-Host 'Paste the owner-only test callback URL' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $callback = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ($callback -notmatch '^bharatcode://auth/callback\?' -or $callback -match '["\r\n]') { throw 'Invalid native callback URL.' }
        $start.Arguments = '"' + $callback + '"'
    } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
if ($PrepareOnly) {
    [pscustomobject]@{ ProfileRoot = $root; AuthUrl = $AuthUrl; ApiBaseUrl = $ApiBaseUrl; Started = $false }
    return
}
$child = [Diagnostics.Process]::Start($start)
[pscustomobject]@{ ProfileRoot = $root; ProcessId = $child.Id; Started = $true }
# Leave the private profile for inspection/relaunch. No installed state or OS
# protocol registry is changed. The caller's environment is not modified.
