$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. "$PSScriptRoot/wsl-windows-preliminary-controller.ps1"

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Assert-Throws([scriptblock]$Action, [string]$Message) {
  try { & $Action; throw "Expected failure: $Message" }
  catch { if ($_.Exception.Message -eq "Expected failure: $Message") { throw } }
}

function Wait-Until([scriptblock]$Condition, [string]$Message) {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 100
  }
  throw $Message
}

function Remove-TestTree([string]$Path) {
  if (-not [IO.Directory]::Exists($Path) -and -not [IO.File]::Exists($Path)) { return }
  $attributes = [IO.File]::GetAttributes($Path)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { [IO.Directory]::Delete($Path, $false) }
    else { [IO.File]::Delete($Path) }
    return
  }
  if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
    foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($Path)) { Remove-TestTree $child }
    try { [IO.Directory]::Delete($Path, $false) }
    catch [IO.IOException] {
      Start-Sleep -Milliseconds 250
      if ([IO.Directory]::Exists($Path)) { [IO.Directory]::Delete($Path, $false) }
    }
    return
  }
  [IO.File]::Delete($Path)
}

function Private-Field([object]$Value, [string]$Name) {
  $field = $Value.GetType().GetField($Name, [Reflection.BindingFlags]"Instance,NonPublic")
  if (-not $field) { throw "Missing private test field $Name" }
  $field
}

$env:BHARATCODE_PRELIMINARY_CONTROLLER_TEST = "1"
$root = Join-Path ([IO.Path]::GetTempPath()) "bharatcode-preliminary-controller-tests-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($root) | Out-Null

try {
  $nonce = "ab" * 32
  $foreignLeaf = Get-PreliminaryNamespaceLeaf -RunId "720001" -RunAttempt "1" -Nonce $nonce
  $foreign = Join-Path $root $foreignLeaf
  [IO.Directory]::CreateDirectory($foreign) | Out-Null
  [IO.File]::WriteAllText((Join-Path $foreign "plausible-owner.json"), '{"run_id":"720001","run_attempt":"1"}')
  Assert-Throws {
    New-PreliminaryControllerLease -RunnerTemp $root -RunId "720001" -RunAttempt "1" -TestNonce $nonce
  } "nonce collision"
  Assert-True (Test-PreliminaryEntryNoFollow -Path $foreign) "foreign nonce collision was deleted"
  Assert-Throws { Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720001" -RunAttempt "1" } "foreign prefix observation"
  Assert-True ([IO.File]::Exists((Join-Path $foreign "plausible-owner.json"))) "foreign collision contents changed"
  Remove-TestTree $foreign

  foreach ($fault in @("after-create", "after-dacl", "after-file-id")) {
    Assert-Throws {
      New-PreliminaryControllerLease -RunnerTemp $root -RunId "720002" -RunAttempt "1" -TestFailpoint $fault
    } "reserve failpoint $fault"
    Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720002" -RunAttempt "1"
  }

  $ancestorTarget = Join-Path $root "ancestor-target"
  $ancestorJunction = Join-Path $root "ancestor-junction"
  [IO.Directory]::CreateDirectory($ancestorTarget) | Out-Null
  New-Item -ItemType Junction -Path $ancestorJunction -Target $ancestorTarget | Out-Null
  Assert-Throws {
    New-PreliminaryControllerLease -RunnerTemp $ancestorJunction -RunId "720003" -RunAttempt "1"
  } "ancestor junction"
  Remove-Item -LiteralPath $ancestorJunction -Force
  Remove-TestTree $ancestorTarget

  $leafNonce = "ef" * 32
  $leafTarget = Join-Path $root "leaf-junction-target"
  $leafJunction = Join-Path $root (Get-PreliminaryNamespaceLeaf -RunId "720003" -RunAttempt "2" -Nonce $leafNonce)
  [IO.Directory]::CreateDirectory($leafTarget) | Out-Null
  [IO.File]::WriteAllText((Join-Path $leafTarget "survive.txt"), "survive")
  New-Item -ItemType Junction -Path $leafJunction -Target $leafTarget | Out-Null
  Assert-Throws {
    New-PreliminaryControllerLease -RunnerTemp $root -RunId "720003" -RunAttempt "2" -TestNonce $leafNonce
  } "leaf junction collision"
  Assert-True ([IO.File]::Exists((Join-Path $leafTarget "survive.txt"))) "foreign leaf junction target changed"
  Remove-TestTree $leafJunction
  Remove-TestTree $leafTarget

  $held = New-PreliminaryControllerLease -RunnerTemp $root -RunId "720004" -RunAttempt "1" -TestNonce ("cd" * 32)
  try {
    Assert-Throws { Rename-Item -LiteralPath $held.RootPath -NewName "replacement" } "held root rename"
    Assert-Throws { Remove-Item -LiteralPath $held.RootPath -Force } "held root delete"
    Assert-Throws { [IO.Directory]::Move($held.RootPath, "$($held.RootPath)-replacement") } "held root replacement"

    $fileId = Private-Field $held "expectedFileId"
    $originalFileId = $fileId.GetValue($held)
    $fileId.SetValue($held, [byte[]](0..15))
    Assert-Throws { $held.Validate() } "stale file ID"
    $fileId.SetValue($held, $originalFileId)

    $finalPath = Private-Field $held "expectedFinalPath"
    $originalFinalPath = $finalPath.GetValue($held)
    $finalPath.SetValue($held, "$originalFinalPath-stale")
    Assert-Throws { $held.Validate() } "stale final path"
    $finalPath.SetValue($held, $originalFinalPath)

    $securitySections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access
    $originalSecurity = [Security.AccessControl.DirectorySecurity]::new($held.RootPath, $securitySections)
    $originalSecurityBytes = $originalSecurity.GetSecurityDescriptorBinaryForm()
    $mutated = [Security.AccessControl.DirectorySecurity]::new($held.RootPath, [Security.AccessControl.AccessControlSections]::Access)
    $foreignRule = [Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new("S-1-1-0"),
      [Security.AccessControl.FileSystemRights]::Read,
      [Security.AccessControl.AccessControlType]::Allow
    )
    $mutated.AddAccessRule($foreignRule)
    ([IO.DirectoryInfo]::new($held.RootPath)).SetAccessControl($mutated)
    Assert-Throws { $held.Validate() } "DACL drift"
    $restore = [Security.AccessControl.DirectorySecurity]::new()
    $restore.SetSecurityDescriptorBinaryForm($originalSecurityBytes, [Security.AccessControl.AccessControlSections]::Access)
    ([IO.DirectoryInfo]::new($held.RootPath)).SetAccessControl($restore)
    $held.Validate()
  }
  finally { Remove-PreliminaryControllerLease -Lease $held }
  Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720004" -RunAttempt "1"

  $jobLease = New-PreliminaryControllerLease -RunnerTemp $root -RunId "720005" -RunAttempt "1"
  $lookalikeRoot = "$($jobLease.RootPath)-lookalike"
  [IO.Directory]::CreateDirectory($lookalikeRoot) | Out-Null
  $lookalikeExe = Join-Path $lookalikeRoot "powershell.exe"
  [IO.File]::Copy((Get-Process -Id $PID).Path, $lookalikeExe)
  $lookalike = Start-Process -FilePath $lookalikeExe -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 120') -PassThru
  Wait-Until { -not $lookalike.HasExited } "prefix-lookalike foreign process did not start"
  try {
    $pinnedHarness = Join-Path $jobLease.RootPath "pinned-harness.exe"
    $descendantScript = Join-Path $jobLease.RootPath "descendants.ps1"
    [IO.File]::Copy((Get-Process -Id $PID).Path, $pinnedHarness)
    [IO.File]::WriteAllText(
      $descendantScript,
      '$child = Start-Process -FilePath $env:ComSpec -ArgumentList @(''/d'', ''/s'', ''/c'', ''ping -t 127.0.0.1 >nul'') -PassThru' + "`r`n" +
        'while (-not $child.HasExited) { Start-Sleep -Seconds 1 }' + "`r`n",
      [Text.UTF8Encoding]::new($false)
    )
    $pinnedDigest = (Get-FileHash -LiteralPath $pinnedHarness -Algorithm SHA256).Hash
    $jobLease.PinInstalledDesktop($pinnedHarness)
    $owned = $jobLease.StartOwnedProcess($pinnedHarness, "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$descendantScript`"")
    Wait-Until { $jobLease.JobProcessIds.Count -ge 3 } "owned harness child/grandchild did not enter the job"
    $ownedPids = @($jobLease.JobProcessIds)
    Assert-True ($ownedPids -contains $owned.ProcessId) "pinned harness root is absent from the job identity list"
    Assert-True ((Get-FileHash -LiteralPath $pinnedHarness -Algorithm SHA256).Hash -ceq $pinnedDigest) "pinned harness file identity changed"
    Assert-Throws { [IO.File]::WriteAllText($pinnedHarness, "replacement") } "pinned harness overwrite"
    Assert-Throws { [IO.File]::Delete($pinnedHarness) } "pinned harness delete"
    $jobLease.CloseJob()
    foreach ($ownedPid in $ownedPids) {
      Wait-Until { -not (Get-Process -Id $ownedPid -ErrorAction SilentlyContinue) } "job descendant survived close"
    }
    Assert-True (-not $lookalike.HasExited) "prefix-lookalike foreign process was killed"
    Assert-True ($jobLease.JobProcessCount -eq 0) "job membership survived close"
    Assert-True ($jobLease.JobProcessIds.Count -eq 0) "job process identity list survived close"
  }
  finally {
    try {
      if (-not $lookalike.HasExited) { Stop-Process -Id $lookalike.Id -Force }
      $lookalike.WaitForExit()
      Remove-TestTree $lookalikeRoot
    }
    finally { Remove-PreliminaryControllerLease -Lease $jobLease }
  }

  $links = New-PreliminaryControllerLease -RunnerTemp $root -RunId "720006" -RunAttempt "1"
  $externalDirectory = Join-Path $root "external-directory"
  $externalFile = Join-Path $root "external-file.txt"
  $uninstallerSignal = Join-Path $root "uninstaller-executed.txt"
  [IO.Directory]::CreateDirectory($externalDirectory) | Out-Null
  [IO.File]::WriteAllText((Join-Path $externalDirectory "survive.txt"), "survive")
  [IO.File]::WriteAllText($externalFile, "survive")
  New-Item -ItemType Junction -Path (Join-Path $links.RootPath "junction") -Target $externalDirectory | Out-Null
  $danglingTarget = Join-Path $root "dangling-target"
  $danglingJunction = Join-Path $links.RootPath "dangling-junction"
  [IO.Directory]::CreateDirectory($danglingTarget) | Out-Null
  New-Item -ItemType Junction -Path $danglingJunction -Target $danglingTarget | Out-Null
  Remove-TestTree $danglingTarget
  Assert-True (Test-PreliminaryEntryNoFollow -Path $danglingJunction) "dangling reparse was hidden from no-follow observation"
  try { New-Item -ItemType SymbolicLink -Path (Join-Path $links.RootPath "symlink.txt") -Target $externalFile | Out-Null }
  catch {
    if ($env:GITHUB_ACTIONS -eq "true") { throw }
    Write-Output "preliminary_controller_symlink_test=skipped_without_local_privilege"
  }
  New-Item -ItemType HardLink -Path (Join-Path $links.RootPath "hardlink.txt") -Target $externalFile | Out-Null
  [IO.File]::WriteAllText((Join-Path $links.RootPath "Uninstall BharatCode Beta.cmd"), "@echo executed>$uninstallerSignal")
  Remove-PreliminaryControllerLease -Lease $links
  Assert-True ([IO.File]::Exists((Join-Path $externalDirectory "survive.txt"))) "junction target was traversed"
  Assert-True ([IO.File]::ReadAllText($externalFile) -eq "survive") "link target was changed"
  Assert-True (-not [IO.File]::Exists($uninstallerSignal)) "malicious uninstaller was executed"
  Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720006" -RunAttempt "1"
  Remove-TestTree $externalDirectory
  Remove-TestTree $externalFile

  $attempt = 10
  foreach ($fault in @("after-install", "after-app-open", "after-harness", "after-receipt-construction")) {
    $receipt = Join-Path $root "receipt-$attempt.json"
    Assert-Throws {
      Invoke-PreliminaryControllerTestScenario -RunnerTemp $root -RunId "720007" -RunAttempt ([string]$attempt) -ReceiptPath $receipt -Failpoint $fault
    } "controlled $fault"
    Assert-True (-not [IO.File]::Exists($receipt)) "controlled failure published a receipt"
    Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720007" -RunAttempt ([string]$attempt)
    $attempt += 1
  }

  $successReceipt = Join-Path $root "receipt-success.json"
  Invoke-PreliminaryControllerTestScenario -RunnerTemp $root -RunId "720008" -RunAttempt "1" -ReceiptPath $successReceipt
  $receiptValue = Get-Content -LiteralPath $successReceipt -Raw | ConvertFrom-Json
  Assert-True ($receiptValue.cleanup_complete -eq $true) "successful receipt did not bind cleanup"
  Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720008" -RunAttempt "1"
  Remove-TestTree $successReceipt

  $ready = Join-Path $root "crash-ready.txt"
  $crashReceipt = Join-Path $root "crash-receipt.json"
  $controller = Join-Path $PSScriptRoot "wsl-windows-preliminary-controller.ps1"
  $crash = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @(
    "-NoProfile", "-File", "`"$controller`"", "-Mode", "CrashProbe", "-RunnerTemp", "`"$root`"",
    "-RunId", "720009", "-RunAttempt", "1", "-ReadyPath", "`"$ready`"", "-ReceiptPath", "`"$crashReceipt`""
  ) -PassThru
  Wait-Until {
    try { [IO.File]::Exists($ready) -and ([IO.FileInfo]::new($ready)).Length -gt 0 }
    catch { $false }
  } "crash probe did not acquire authority"
  Stop-Process -Id $crash.Id -Force
  $crash.WaitForExit()
  Assert-True (-not [IO.File]::Exists($crashReceipt)) "terminated controller published a receipt"
  Assert-Throws { Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720009" -RunAttempt "1" } "crash orphan observation"
  $crashRoot = [IO.File]::ReadAllText($ready)
  Assert-True (Test-PreliminaryEntryNoFollow -Path $crashRoot) "controller crash did not leave the documented orphan"
  Remove-TestTree $crashRoot
  Remove-TestTree $ready

  Write-Output "preliminary_controller_windows_tests=passed"
}
finally {
  Remove-TestTree $root
  Remove-Item Env:BHARATCODE_PRELIMINARY_CONTROLLER_TEST -ErrorAction SilentlyContinue
}
