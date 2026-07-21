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

function Assert-ThrowsContaining([scriptblock]$Action, [string]$Expected, [string]$Message) {
  try { & $Action; throw "Expected failure: $Message" }
  catch {
    if ($_.Exception.Message -eq "Expected failure: $Message") { throw }
    if ($_.Exception.ToString().IndexOf($Expected, [StringComparison]::Ordinal) -lt 0) { throw "$Message returned an unexpected failure: $($_.Exception.Message)" }
    $_.Exception
  }
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

function Format-ExceptionChain([Exception]$Exception, [int]$Depth = 0) {
  $lines = [Collections.Generic.List[string]]::new()
  [void]$lines.Add("depth=$Depth;type=$($Exception.GetType().FullName);hresult=0x$($Exception.HResult.ToString('X8'));message=$($Exception.Message)")
  if ($Exception.StackTrace) { [void]$lines.Add(($Exception.StackTrace -replace '[\r\n]+', ' | ')) }
  if ($Exception -is [AggregateException]) {
    $index = 0
    foreach ($inner in $Exception.InnerExceptions) {
      [void]$lines.Add("aggregate_index=$index")
      foreach ($line in (Format-ExceptionChain -Exception $inner -Depth ($Depth + 1))) { [void]$lines.Add($line) }
      $index += 1
    }
  }
  elseif ($Exception.InnerException) {
    foreach ($line in (Format-ExceptionChain -Exception $Exception.InnerException -Depth ($Depth + 1))) { [void]$lines.Add($line) }
  }
  $lines.ToArray()
}

function Write-PathIdentityDiagnostic([string]$Label, [string]$Path) {
  try {
    if (-not (Test-PreliminaryEntryNoFollow -Path $Path)) {
      Write-Output "preliminary_controller_path_diagnostic=$Label;state=absent;path=$Path"
      return
    }
    $item = Get-Item -LiteralPath $Path -Force
    $fileId = (& fsutil.exe file queryfileid $Path 2>&1) -join ' '
    Write-Output "preliminary_controller_path_diagnostic=$Label;state=present;path=$Path;attributes=$($item.Attributes);link_type=$($item.LinkType);target=$([string]::Join(',', @($item.Target)));file_id=$fileId"
  }
  catch { Write-Output "preliminary_controller_path_diagnostic=$Label;state=error;path=$Path;error=$($_.Exception.Message)" }
}

function Write-AfterHarnessStageDiagnostics([string]$RunnerTemp, [string]$RunId, [string]$RunAttempt, [Exception]$Exception) {
  Write-Output "preliminary_controller_after_harness_stage_diagnostics=controller_pid:$PID;run_id:$RunId;run_attempt:$RunAttempt"
  foreach ($line in (Format-ExceptionChain -Exception $Exception)) { Write-Output "preliminary_controller_exception_chain=$line" }
  $prefix = "bharatcode-preliminary-unsigned-$RunId-$RunAttempt-"
  $parentEntries = @([IO.Directory]::EnumerateFileSystemEntries($RunnerTemp) | Sort-Object)
  Write-Output "preliminary_controller_parent_enumeration=count:$($parentEntries.Count);entries:$([string]::Join(',', @($parentEntries | ForEach-Object { [IO.Path]::GetFileName($_) })))"
  foreach ($entry in @($parentEntries | Where-Object { [IO.Path]::GetFileName($_).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })) {
    Write-PathIdentityDiagnostic -Label "lease-root" -Path $entry
    foreach ($child in @([IO.Directory]::EnumerateFileSystemEntries($entry) | Sort-Object)) {
      Write-PathIdentityDiagnostic -Label "lease-child" -Path $child
    }
  }
}

function ConvertTo-PsSingleQuotedLiteral([string]$Value) {
  "'$($Value.Replace("'", "''"))'"
}

function New-ProductionControllerFixture([string]$Directory) {
  $source = Join-Path $Directory "production-controller-fixture.cs"
  $output = Join-Path $Directory "production-controller-fixture.exe"
  $code = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;

[assembly: AssemblyTitle("BharatCode Preliminary Controller Fixture")]
[assembly: AssemblyProduct("BharatCode Preliminary Controller Fixture")]
[assembly: AssemblyVersion("1.2.3.4")]
[assembly: AssemblyFileVersion("1.2.3.4")]

internal static class Program {
  private static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "--sleep") { Thread.Sleep(Timeout.Infinite); return 0; }
    if (args.Length == 1 && args[0] == "--harness") return Harness();
    if (String.Equals(Environment.GetEnvironmentVariable("BHARATCODE_PRELIMINARY_FIXTURE_MODE"), "installer-failure", StringComparison.Ordinal)) return 41;
    var command = Environment.CommandLine;
    var marker = " /S /D=";
    var markerIndex = command.IndexOf(marker, StringComparison.Ordinal);
    if (markerIndex < 0 || command.IndexOf(marker, markerIndex + 1, StringComparison.Ordinal) >= 0) return 42;
    var root = command.Substring(markerIndex + marker.Length).TrimEnd();
    if (root.Length == 0 || root.IndexOf('"') >= 0) return 43;
    Directory.CreateDirectory(root);
    File.Copy(Process.GetCurrentProcess().MainModule.FileName, Path.Combine(root, "BharatCode Beta.exe"), false);
    if (String.Equals(Environment.GetEnvironmentVariable("BHARATCODE_PRELIMINARY_FIXTURE_MODE"), "contracts-junction", StringComparison.Ordinal)) {
      var target = Environment.GetEnvironmentVariable("BHARATCODE_PRELIMINARY_FIXTURE_EXTERNAL_TARGET");
      var link = Path.Combine(root, "contracts");
      var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec"), "/d /c mklink /J \"" + link + "\" \"" + target + "\"");
      start.UseShellExecute = false;
      start.CreateNoWindow = true;
      start.WorkingDirectory = Path.GetPathRoot(root);
      start.RedirectStandardOutput = true;
      start.RedirectStandardError = true;
      using (var process = Process.Start(start)) {
        var standardOutput = process.StandardOutput.ReadToEnd();
        var standardError = process.StandardError.ReadToEnd();
        process.WaitForExit();
        if (process.ExitCode != 0) {
          File.WriteAllText(Environment.GetEnvironmentVariable("BHARATCODE_PRELIMINARY_FIXTURE_JUNCTION_READY"), "exit=" + process.ExitCode + ";link=" + link + ";target=" + target + ";working_directory=" + start.WorkingDirectory + ";stdout=" + standardOutput + ";stderr=" + standardError);
          return 44;
        }
      }
      File.WriteAllText(Environment.GetEnvironmentVariable("BHARATCODE_PRELIMINARY_FIXTURE_JUNCTION_READY"), link);
    }
    if (String.Equals(Environment.GetEnvironmentVariable("BHARATCODE_PRELIMINARY_FIXTURE_MODE"), "evidence-collision", StringComparison.Ordinal)) File.WriteAllText(Path.Combine(root, "evidence.mjs"), "foreign-evidence");
    return 0;
  }

  private static int Harness() {
    var mode = Environment.GetEnvironmentVariable("BHARATCODE_PRELIMINARY_FIXTURE_MODE") ?? "success";
    if (mode == "harness-failure") return 51;
    if (mode == "no-candidate") return 0;
    if (mode == "candidate-directory") {
      Directory.CreateDirectory(Environment.GetEnvironmentVariable("PRELIMINARY_RECEIPT_CANDIDATE"));
      return 0;
    }
    if (mode == "candidate-junction" || mode == "candidate-hardlink") {
      var candidate = Environment.GetEnvironmentVariable("PRELIMINARY_RECEIPT_CANDIDATE");
      var target = Environment.GetEnvironmentVariable(mode == "candidate-junction" ? "BHARATCODE_PRELIMINARY_FIXTURE_EXTERNAL_TARGET" : "BHARATCODE_PRELIMINARY_FIXTURE_EXTERNAL_FILE");
      var kind = mode == "candidate-junction" ? "/J" : "/H";
      var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec"), "/d /c mklink " + kind + " \"" + candidate + "\" \"" + target + "\"");
      start.UseShellExecute = false;
      start.CreateNoWindow = true;
      using (var process = Process.Start(start)) { process.WaitForExit(); return process.ExitCode == 0 ? 0 : 53; }
    }
    if (mode == "assert-pins") {
      foreach (var name in new[] { "INSTALLED_DESKTOP_EXE", "UNSIGNED_INSTALLER_PATH", "PRELIMINARY_EVIDENCE_SCRIPT", "PRELIMINARY_ADAPTER", "PRELIMINARY_VALIDATOR", "PRELIMINARY_FROZEN_HARNESS", "PRELIMINARY_RUNTIME_MANIFEST", "PRELIMINARY_RUNTIME" }) {
        try { File.WriteAllText(Environment.GetEnvironmentVariable(name), "substitution"); return 52; }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
      }
    }
    File.WriteAllText(Environment.GetEnvironmentVariable("PRELIMINARY_RECEIPT_CANDIDATE"), "{\"cleanup_complete\":true}\n", new UTF8Encoding(false));
    Process.Start(Process.GetCurrentProcess().MainModule.FileName, "--sleep");
    return 0;
  }
}
'@
  [IO.File]::WriteAllText($source, $code, [Text.UTF8Encoding]::new($false))
  $csc = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) "csc.exe"
  if (-not [IO.File]::Exists($csc)) { $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe" }
  if (-not [IO.File]::Exists($csc)) { throw "Windows fixture compiler is unavailable" }
  $compilerOutput = Join-Path $Directory "compiler.stdout"
  $compilerError = Join-Path $Directory "compiler.stderr"
  $compile = Start-Process -FilePath $csc -ArgumentList @(
    "/nologo", "/target:exe", "/optimize+", "/out:`"$output`"", "`"$source`""
  ) -RedirectStandardOutput $compilerOutput -RedirectStandardError $compilerError -Wait -PassThru
  if ($compile.ExitCode -ne 0 -or -not [IO.File]::Exists($output)) {
    throw "Windows production-controller fixture compilation failed: $([IO.File]::ReadAllText($compilerOutput)) $([IO.File]::ReadAllText($compilerError))"
  }
  $output
}

$env:BHARATCODE_PRELIMINARY_CONTROLLER_TEST = "1"
$root = Join-Path ([IO.Path]::GetTempPath()) "bcp-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($root) | Out-Null
$controllerTestFailure = $null
$linkExternalRoot = $null
$links = $null

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
  Assert-Throws {
    New-PreliminaryControllerLease -RunnerTemp $root -RunId "720002" -RunAttempt "2" -TestFailpoint "after-foreign-effect"
  } "closed reservation failpoints"
  Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720002" -RunAttempt "2"

  $retainedParent = New-PreliminaryControllerLease -RunnerTemp $root -RunId "720002" -RunAttempt "9"
  try {
    Assert-Throws { Rename-Item -LiteralPath $root -NewName "runner-temp-replaced" } "retained runner temp rename"
    $ownedPaths = Get-PreliminaryControllerTransactionPaths -Lease $retainedParent
    foreach ($ownedPath in @($ownedPaths.AcceptanceDirectory, $ownedPaths.EvidenceScript, $ownedPaths.ReceiptCandidate)) {
      Assert-True ($ownedPath.StartsWith($retainedParent.RootPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) "owned transaction path escaped the lease"
    }
    [IO.Directory]::CreateDirectory($ownedPaths.AcceptanceDirectory) | Out-Null
    [IO.File]::WriteAllText((Join-Path $ownedPaths.AcceptanceDirectory "desktop-state.json"), "state")
    [IO.File]::WriteAllText($ownedPaths.EvidenceScript, "evidence")
    [IO.File]::WriteAllText($ownedPaths.ReceiptCandidate, "candidate")
  }
  finally { Remove-PreliminaryControllerLease -Lease $retainedParent }
  Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720002" -RunAttempt "9"
  foreach ($ownedPath in @($ownedPaths.AcceptanceDirectory, $ownedPaths.EvidenceScript, $ownedPaths.ReceiptCandidate)) {
    Assert-True (-not (Test-PreliminaryEntryNoFollow -Path $ownedPath)) "owned acceptance state survived cleanup"
  }

  $mixedCaseLeaf = "BHARATCODE-PRELIMINARY-UNSIGNED-720002-10-$('ac' * 32)"
  $mixedCaseCollision = Join-Path $root $mixedCaseLeaf
  [IO.Directory]::CreateDirectory($mixedCaseCollision) | Out-Null
  Assert-Throws { Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720002" -RunAttempt "10" } "mixed-case prefix observation"
  Remove-TestTree $mixedCaseCollision

  $c2Failures = [Collections.Generic.List[string]]::new()
  $c2Lease = New-PreliminaryControllerLease -RunnerTemp $root -RunId "720002" -RunAttempt "11"
  try {
    $c2Lease.PinExternal("c2-shell", (Get-Process -Id $PID).Path)
    try {
      $c2Lease.BeginStage("installer")
      $owned = $c2Lease.StartOwnedProcess("c2-shell", '-NoLogo -NoProfile -NonInteractive -Command "exit 0"')
      Assert-True ($owned.WaitForExit(20000) -eq 0) "installer stage process failed"
      $c2Lease.CloseStage()
      $c2Lease.AssertNoOwnedProcesses()
      $c2Lease.BeginStage("harness")
      $c2Lease.CloseStage()
      $c2Lease.AssertNoOwnedProcesses()
    }
    catch { [void]$c2Failures.Add("separate-stage-empty-barrier: $($_.Exception.Message)") }

    $externalPinned = Join-Path $root "external-pin-$([Guid]::NewGuid().ToString('N')).txt"
    $ownedPinned = Join-Path $c2Lease.RootPath "owned-pin.txt"
    [IO.File]::WriteAllText($externalPinned, "external")
    [IO.File]::WriteAllText($ownedPinned, "owned")
    try {
      $c2Lease.PinExternal("external-test", $externalPinned)
      $c2Lease.PinOwnedRelative("owned-test", "owned-pin.txt")
      Assert-Throws { [IO.File]::WriteAllText($externalPinned, "replacement") } "external pin replacement"
      Assert-Throws { [IO.File]::WriteAllText($ownedPinned, "replacement") } "owned pin replacement"
    }
    catch { [void]$c2Failures.Add("lifetime-pins: $($_.Exception.Message)") }

    try {
      $c2Lease.BeginStage("assignment-failure")
      Assert-Throws {
        $c2Lease.StartOwnedProcess("c2-shell", '-NoLogo -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 120"', $true)
      } "injected assignment failure"
      $failedPid = [BharatCode.Preliminary.PreliminaryControllerNative]::LastAssignmentFailureProcessId
      Assert-True ($failedPid -gt 0) "assignment failure PID was not recorded"
      Wait-Until { -not (Get-Process -Id $failedPid -ErrorAction SilentlyContinue) } "assignment failure process survived checked termination"
      $c2Lease.CloseStage()
      $c2Lease.AssertNoOwnedProcesses()
    }
    catch { [void]$c2Failures.Add("assignment-failure-termination: $($_.Exception.Message)") }

    try {
      $arguments = Get-PreliminaryNsisArguments -InstallRoot $c2Lease.RootPath
      Assert-True ($arguments -ceq "/S /D=$($c2Lease.RootPath)") "NSIS arguments are not exact"
      Assert-True (-not $arguments.Contains('"')) "NSIS /D contains a quote"
      Assert-True ($arguments.EndsWith("/D=$($c2Lease.RootPath)", [StringComparison]::Ordinal)) "NSIS /D is not final"
    }
    catch { [void]$c2Failures.Add("nsis-arguments: $($_.Exception.Message)") }
  }
  finally {
    try { Remove-PreliminaryControllerLease -Lease $c2Lease }
    catch { [void]$c2Failures.Add("c2-probe-cleanup: $($_.Exception.Message)") }
  }
  if ($externalPinned -and [IO.File]::Exists($externalPinned)) { [IO.File]::Delete($externalPinned) }

  $fixture = Join-Path $PSScriptRoot "..\test\fixtures\preliminary-unsigned-controller.nsi"
  Assert-True ([IO.File]::Exists($fixture)) "real NSIS controller fixture is missing"
  $nsisRoots = @(
    (Join-Path $env:LOCALAPPDATA "electron-builder\Cache\nsis"),
    (Join-Path $env:LOCALAPPDATA "electron-builder\Cache\nsis-3.0.4.1"),
    $env:ELECTRON_BUILDER_CACHE
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique
  $makensis = @($nsisRoots | Where-Object { [IO.Directory]::Exists($_) } | ForEach-Object {
    Get-ChildItem -LiteralPath $_ -Filter makensis.exe -File -Recurse -ErrorAction SilentlyContinue
  } | Where-Object {
    $_.Directory.Parent -and
    $_.Directory.Parent.Name -ceq "nsis" -and
    $_.Directory.Name -ceq "nsis-3.0.4.1-nsis-3.0.4.1"
  } | Sort-Object FullName -Unique)
  if ($makensis.Count -eq 0) {
    if ($env:GITHUB_ACTIONS -eq "true") { [void]$c2Failures.Add("real-nsis-fixture: pinned electron-builder makensis 3.0.4.1 is unavailable") }
    else { Write-Output "preliminary_controller_real_nsis_test=skipped_without_cached_makensis" }
  }
  elseif ($makensis.Count -ne 1) {
    [void]$c2Failures.Add("real-nsis-fixture: pinned makensis resolution is ambiguous")
  }
  else {
    $nsisRoot = Join-Path $root "nsis-fixture"
    [IO.Directory]::CreateDirectory($nsisRoot) | Out-Null
    $installer = Join-Path $nsisRoot "fixture-installer.exe"
    $payload = (Get-Process -Id $PID).Path
    $previousTemp = $env:TEMP
    try {
      $env:TEMP = $nsisRoot
      & $makensis[0].FullName "/DFIXTURE_OUTFILE=$installer" "/DFIXTURE_PAYLOAD=$payload" $fixture | Out-Null
      if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($installer)) { throw "real NSIS fixture compile failed" }
      $legacyRoot = Join-Path $nsisRoot "legacy target with spaces"
      $legacy = Start-Process -FilePath $installer -ArgumentList "/S /D=`"$legacyRoot`"" -Wait -PassThru
      Assert-True ($legacy.ExitCode -eq 0) "legacy quoted NSIS fixture failed unexpectedly"
      Assert-True (-not [IO.File]::Exists((Join-Path $legacyRoot "BharatCode Beta.exe"))) "legacy quoted NSIS /D did not misplace the fixture"

      $realRoot = Join-Path $nsisRoot "real target with spaces"
      $real = Start-Process -FilePath $installer -ArgumentList (Get-PreliminaryNsisArguments -InstallRoot $realRoot) -Wait -PassThru
      Assert-True ($real.ExitCode -eq 0) "real NSIS fixture execution failed"
      Assert-True ([IO.File]::Exists((Join-Path $realRoot "BharatCode Beta.exe"))) "real NSIS fixture escaped the lease root"
      Assert-True ([IO.File]::ReadAllText((Join-Path $realRoot "fixture-install-root.txt")) -ceq $realRoot) "real NSIS fixture root record drift"
    }
    catch { [void]$c2Failures.Add("real-nsis-fixture: $($_.Exception.Message)") }
    finally { $env:TEMP = $previousTemp; Remove-TestTree $nsisRoot }
  }
  if ($c2Failures.Count -ne 0) { throw "C2 RED: $($c2Failures -join '; ')" }

  $authorityAncestor = Join-Path $root "authority-ancestor"
  $authorityParent = Join-Path $authorityAncestor "authority-parent"
  $authorityRunnerTemp = Join-Path $authorityParent "runner-temp"
  [IO.Directory]::CreateDirectory($authorityRunnerTemp) | Out-Null
  $copySourceParent = Join-Path $root "copy-source-parent"
  $processSourceParent = Join-Path $root "process-source-parent"
  [IO.Directory]::CreateDirectory($copySourceParent) | Out-Null
  [IO.Directory]::CreateDirectory($processSourceParent) | Out-Null
  $copySource = Join-Path $copySourceParent "copy-source.txt"
  $processSource = Join-Path $processSourceParent "process-source.exe"
  [IO.File]::WriteAllText($copySource, "copy-source", [Text.UTF8Encoding]::new($false))
  [IO.File]::Copy($env:ComSpec, $processSource)
  $authorityLease = New-PreliminaryControllerLease -RunnerTemp $authorityRunnerTemp -RunId "720012" -RunAttempt "1"
  try {
    $parentAuthority = (Private-Field $authorityLease "parentAuthority").GetValue($authorityLease)
    $chain = (Private-Field $parentAuthority "chain").GetValue($parentAuthority)
    $expectedChain = [Collections.Generic.List[string]]::new()
    $current = [IO.DirectoryInfo]::new([IO.Path]::GetFullPath($authorityRunnerTemp))
    while ($current) { [void]$expectedChain.Insert(0, $current.FullName); $current = $current.Parent }
    Assert-True ($chain.Count -eq $expectedChain.Count) "runner temp ancestor authority chain is incomplete"
    for ($index = 0; $index -lt $chain.Count; $index++) {
      $heldPath = (Private-Field $chain[$index] "FinalPath").GetValue($chain[$index])
      $heldHandle = (Private-Field $chain[$index] "Handle").GetValue($chain[$index])
      Assert-True ($heldPath -ieq $expectedChain[$index]) "runner temp ancestor authority identity drift"
      Assert-True (-not $heldHandle.IsClosed -and -not $heldHandle.IsInvalid) "runner temp ancestor authority handle is unavailable"
    }
    foreach ($ancestor in @($authorityAncestor, $authorityParent, $authorityRunnerTemp)) {
      Assert-Throws { Rename-Item -LiteralPath $ancestor -NewName "$([IO.Path]::GetFileName($ancestor))-substituted" } "runner temp ancestor rename"
    }

    $authorityLease.PinExternal("copy-source", $copySource)
    Assert-Throws { Rename-Item -LiteralPath $copySourceParent -NewName "copy-source-parent-substituted" } "pinned parent substitution"
    Assert-Throws { Rename-Item -LiteralPath $copySource -NewName "copy-source-substituted.txt" } "pinned leaf substitution before copy"
    $authorityLease.CreateOwnedDirectory("copy-destination", "copy-destination")
    $authorityLease.CopyPinnedNew("copy-source", "copied-source", "copy-destination", "copied-source.txt")
    Assert-True ([Text.Encoding]::UTF8.GetString($authorityLease.PinnedBytes("copied-source")) -ceq "copy-source") "handle-to-handle copy bytes drift"

    $authorityLease.PinExternal("process-source", $processSource)
    Assert-Throws { Rename-Item -LiteralPath $processSourceParent -NewName "process-source-parent-substituted" } "pinned parent substitution before CreateProcessW"
    Assert-Throws { Rename-Item -LiteralPath $processSource -NewName "process-source-substituted.exe" } "pinned leaf substitution before CreateProcessW"
    $authorityLease.BeginStage("pin-process")
    $pinProcess = $authorityLease.StartOwnedProcess("process-source", "/d /c exit 0")
    Assert-True ($pinProcess.WaitForExit(20000) -eq 0) "held process pin did not execute"
    $authorityLease.CloseStage()
    $authorityLease.AssertNoOwnedProcesses()
  }
  finally {
    Remove-PreliminaryControllerLease -Lease $authorityLease
    Remove-TestTree $copySourceParent
    Remove-TestTree $processSourceParent
  }
  $movedAuthorityAncestor = "$authorityAncestor-moved"
  [IO.Directory]::Move($authorityAncestor, $movedAuthorityAncestor)
  [IO.Directory]::Move($movedAuthorityAncestor, $authorityAncestor)
  Remove-TestTree $authorityAncestor

  $publicationAncestor = Join-Path $root "publication-ancestor"
  $publicationParent = Join-Path $publicationAncestor "publication-parent"
  [IO.Directory]::CreateDirectory($publicationParent) | Out-Null
  $publicationReceipt = Join-Path $publicationParent "receipt.json"
  $publication = [BharatCode.Preliminary.PreliminaryControllerNative]::AcquirePublicationAuthority($publicationReceipt)
  try {
    $publicationLease = New-PreliminaryControllerLease -RunnerTemp $root -RunId "720013" -RunAttempt "1"
    Remove-PreliminaryControllerLease -Lease $publicationLease
    Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720013" -RunAttempt "1"
    Assert-Throws { Rename-Item -LiteralPath $publicationParent -NewName "publication-parent-substituted" } "receipt parent substitution"
    Assert-Throws { Rename-Item -LiteralPath $publicationAncestor -NewName "publication-ancestor-substituted" } "receipt parent ancestor substitution"
    $publication.PublishCreateNew([Text.UTF8Encoding]::new($false).GetBytes("publication"))
    Assert-True ([IO.File]::ReadAllText($publicationReceipt) -ceq "publication") "retained publication authority bytes drift"
  }
  finally { $publication.Dispose() }
  $lateCollisionReceipt = Join-Path $publicationParent "late-collision.json"
  $lateCollision = [BharatCode.Preliminary.PreliminaryControllerNative]::AcquirePublicationAuthority($lateCollisionReceipt)
  try {
    [IO.File]::WriteAllText($lateCollisionReceipt, "foreign-late-receipt", [Text.UTF8Encoding]::new($false))
    Assert-Throws { $lateCollision.PublishCreateNew([Text.UTF8Encoding]::new($false).GetBytes("replacement")) } "late receipt collision"
    Assert-True ([IO.File]::ReadAllText($lateCollisionReceipt) -ceq "foreign-late-receipt") "late receipt collision did not overwrite"
    Assert-True (@([IO.Directory]::EnumerateFileSystemEntries($publicationParent, ".bharatcode-preliminary-*.tmp")).Count -eq 0) "late receipt collision left a staging entry"
  }
  finally { $lateCollision.Dispose() }
  Remove-TestTree $publicationAncestor

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
  $originalSecurityBytes = $null
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
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($held.RootPath), $mutated)
    Assert-Throws { $held.Validate() } "DACL drift"
    try { Remove-PreliminaryControllerLease -Lease $held }
    catch {
      $daclCleanupFailure = $_.Exception
      $restore = [Security.AccessControl.DirectorySecurity]::new()
      $restore.SetSecurityDescriptorBinaryForm($originalSecurityBytes, [Security.AccessControl.AccessControlSections]::Access)
      [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($held.RootPath), $restore)
      Remove-TestTree $held.RootPath
      $held = $null
      throw "DACL drift cleanup failed: $($daclCleanupFailure.Message)"
    }
    $held = $null
    Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720004" -RunAttempt "1"
  }
  finally {
    if ($held) {
      if ($originalSecurityBytes -and (Test-PreliminaryEntryNoFollow -Path $held.RootPath)) {
        $restore = [Security.AccessControl.DirectorySecurity]::new()
        $restore.SetSecurityDescriptorBinaryForm($originalSecurityBytes, [Security.AccessControl.AccessControlSections]::Access)
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($held.RootPath), $restore)
      }
      Remove-PreliminaryControllerLease -Lease $held
    }
  }
  Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720004" -RunAttempt "1"

  $jobLease = New-PreliminaryControllerLease -RunnerTemp $root -RunId "720005" -RunAttempt "1"
  $jobLeaseRoot = $jobLease.RootPath
  $lookalikeRoot = "$($jobLease.RootPath)-lookalike"
  [IO.Directory]::CreateDirectory($lookalikeRoot) | Out-Null
  $lookalikeExe = Join-Path $lookalikeRoot "lookalike-sleeper.exe"
  [IO.File]::Copy((Join-Path $env:WINDIR "System32\ping.exe"), $lookalikeExe)
  $lookalike = $null
  $jobFailure = $null
  try {
    $lookalike = Start-Process -FilePath $lookalikeExe -ArgumentList @('-t', '127.0.0.1') -PassThru
    Wait-Until { -not $lookalike.HasExited } "prefix-lookalike foreign process did not start"
    $pinnedHarness = Join-Path $jobLease.RootPath "pinned-harness.exe"
    $descendantScript = Join-Path $jobLease.RootPath "descendants.ps1"
    [IO.File]::Copy($env:ComSpec, $pinnedHarness)
    [IO.File]::WriteAllText(
      $descendantScript,
      '$child = Start-Process -FilePath $env:ComSpec -ArgumentList @(''/d'', ''/s'', ''/c'', ''ping -t 127.0.0.1 >nul'') -PassThru' + "`r`n" +
        'while (-not $child.HasExited) { Start-Sleep -Seconds 1 }' + "`r`n",
      [Text.UTF8Encoding]::new($false)
    )
    $pinnedDigest = (Get-FileHash -LiteralPath $pinnedHarness -Algorithm SHA256).Hash
    $jobLease.PinOwnedRelative("pinned-harness", "pinned-harness.exe")
    $jobLease.PinExternal("job-shell", (Get-Process -Id $PID).Path)
    $jobLease.BeginStage("harness")
    $owned = $jobLease.StartOwnedProcess("job-shell", "-NoLogo -NoProfile -NonInteractive -File `"$descendantScript`"")
    Wait-Until { $jobLease.JobProcessIds.Count -ge 3 } "owned harness child/grandchild did not enter the job"
    $ownedPids = @($jobLease.JobProcessIds)
    Assert-True ($ownedPids -contains $owned.ProcessId) "pinned harness root is absent from the job identity list"
    Assert-True ((Get-FileHash -LiteralPath $pinnedHarness -Algorithm SHA256).Hash -ceq $pinnedDigest) "pinned harness file identity changed"
    Assert-Throws { [IO.File]::WriteAllText($pinnedHarness, "replacement") } "pinned harness overwrite"
    Assert-Throws { [IO.File]::Delete($pinnedHarness) } "pinned harness delete"
    [BharatCode.Preliminary.PreliminaryControllerNative]::FailNextJobProcessIdsForTest()
    $jobLease.CloseStage()
    foreach ($ownedPid in $ownedPids) {
      Wait-Until { -not (Get-Process -Id $ownedPid -ErrorAction SilentlyContinue) } "job descendant survived close"
    }
    Assert-True (-not $lookalike.HasExited) "prefix-lookalike foreign process was killed"
    Assert-True ($jobLease.JobProcessCount -eq 0) "job membership survived close"
    Assert-True ($jobLease.JobProcessIds.Count -eq 0) "job process identity list survived close"
    Write-Output "preliminary_controller_job_membership_diagnostic_failure=terminated_and_empty"
    $jobLease.BeginStage("barrier-fallback")
    $fallbackOwned = $jobLease.StartOwnedProcess("job-shell", "-NoLogo -NoProfile -NonInteractive -Command `"Start-Sleep -Seconds 300`"")
    Wait-Until { $jobLease.JobProcessIds.Count -ge 1 } "post-termination control-failure process did not enter the job"
    [BharatCode.Preliminary.PreliminaryControllerNative]::FailNextTerminateJobForTest()
    [BharatCode.Preliminary.PreliminaryControllerNative]::FailNextJobProcessCountForTest()
    $jobLease.CloseStage()
    Wait-Until { -not (Get-Process -Id $fallbackOwned.ProcessId -ErrorAction SilentlyContinue) } "post-termination control-failure process survived fallback"
    Assert-True ($jobLease.JobProcessCount -eq 0) "post-termination control-failure Job count survived close"
    Assert-True ($jobLease.JobProcessIds.Count -eq 0) "post-termination control-failure Job identity survived close"
    Write-Output "preliminary_controller_post_termination_control_failure=fallback_terminated_and_empty"
  }
  catch { $jobFailure = $_.Exception }
  finally {
    $jobCleanupFailures = [Collections.Generic.List[Exception]]::new()
    try {
      if ($lookalike -and -not $lookalike.HasExited) { Stop-Process -Id $lookalike.Id -Force }
      if ($lookalike) { $lookalike.WaitForExit() }
      Remove-TestTree $lookalikeRoot
    }
    catch { [void]$jobCleanupFailures.Add($_.Exception) }
    try { Remove-PreliminaryControllerLease -Lease $jobLease }
    catch { [void]$jobCleanupFailures.Add($_.Exception) }
    if ($jobFailure) { [void]$jobCleanupFailures.Insert(0, $jobFailure) }
    if ($jobCleanupFailures.Count -eq 1) { throw $jobCleanupFailures[0] }
    if ($jobCleanupFailures.Count -gt 1) { throw [AggregateException]::new("Preliminary job test and cleanup failed", [Exception[]]$jobCleanupFailures.ToArray()) }
  }
  Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720005" -RunAttempt "1"
  Assert-True (-not (Test-PreliminaryEntryNoFollow -Path $jobLeaseRoot)) "stage lease root survived cleanup"

  $linkExternalRoot = Join-Path ([IO.Path]::GetTempPath()) "bcp-link-external-$([Guid]::NewGuid().ToString('N'))"
  $externalDirectory = Join-Path $linkExternalRoot "external-directory"
  $externalFile = Join-Path $linkExternalRoot "external-file.txt"
  $uninstallerSignal = Join-Path $linkExternalRoot "uninstaller-executed.txt"
  [IO.Directory]::CreateDirectory($linkExternalRoot) | Out-Null
  [IO.Directory]::CreateDirectory($externalDirectory) | Out-Null
  [IO.File]::WriteAllText((Join-Path $externalDirectory "survive.txt"), "survive")
  [IO.File]::WriteAllText($externalFile, "survive")
  $links = New-PreliminaryControllerLease -RunnerTemp $root -RunId "720006" -RunAttempt "1"
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
  $hardlinkDirectory = Join-Path $links.RootPath "hardlink-container"
  [IO.Directory]::CreateDirectory($hardlinkDirectory) | Out-Null
  New-Item -ItemType HardLink -Path (Join-Path $hardlinkDirectory "hardlink.txt") -Target $externalFile | Out-Null
  [IO.File]::WriteAllText((Join-Path $links.RootPath "Uninstall BharatCode Beta.cmd"), "@echo executed>$uninstallerSignal")
  $linksToRemove = $links
  $links = $null
  Remove-PreliminaryControllerLease -Lease $linksToRemove
  Assert-True ([IO.File]::Exists((Join-Path $externalDirectory "survive.txt"))) "junction target was traversed"
  Assert-True ([IO.File]::ReadAllText($externalFile) -eq "survive") "link target was changed"
  Assert-True (-not [IO.File]::Exists($uninstallerSignal)) "malicious uninstaller was executed"
  Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720006" -RunAttempt "1"
  Remove-TestTree $linkExternalRoot
  $linkExternalRoot = $null

  $productionFixtureRoot = Join-Path $root "production-controller-fixture"
  [IO.Directory]::CreateDirectory($productionFixtureRoot) | Out-Null
  $productionFixture = New-ProductionControllerFixture -Directory $productionFixtureRoot
  $productionVersion = ([IO.FileInfo]::new($productionFixture)).VersionInfo.ProductVersion
  $productionInputs = @{}
  foreach ($name in @("adapter", "validator", "frozen-harness", "runtime-manifest", "runtime")) {
    $path = Join-Path $productionFixtureRoot "$name.bin"
    [IO.File]::WriteAllText($path, "$name-bytes", [Text.UTF8Encoding]::new($false))
    $productionInputs[$name] = $path
  }
  $productionLookalikeExe = Join-Path $productionFixtureRoot "production-prefix-lookalike.exe"
  [IO.File]::Copy((Join-Path $env:WINDIR "System32\ping.exe"), $productionLookalikeExe)
  $foreignLookalike = $null
  $foreignState = Join-Path $root "foreign-production-lookalike.txt"
  [IO.File]::WriteAllText($foreignState, "survive")
  $externalContractsTarget = Join-Path $root "foreign-contracts-target"
  $externalCandidateTarget = Join-Path $root "foreign-candidate-target.json"
  $junctionReady = Join-Path $root "production-junction-ready.txt"
  [IO.Directory]::CreateDirectory($externalContractsTarget) | Out-Null
  [IO.File]::WriteAllText((Join-Path $externalContractsTarget "survive.txt"), "survive")
  [IO.File]::WriteAllText($externalCandidateTarget, '{"foreign":true}', [Text.UTF8Encoding]::new($false))
  $previousAdapterEnvironment = [Environment]::GetEnvironmentVariable("PRELIMINARY_ADAPTER", [EnvironmentVariableTarget]::Process)
  $env:PRELIMINARY_ADAPTER = "foreign-environment"
  $env:BHARATCODE_PRELIMINARY_FIXTURE_EXTERNAL_TARGET = $externalContractsTarget
  $env:BHARATCODE_PRELIMINARY_FIXTURE_EXTERNAL_FILE = $externalCandidateTarget
  $env:BHARATCODE_PRELIMINARY_FIXTURE_JUNCTION_READY = $junctionReady
  $env:BHARATCODE_PRELIMINARY_FIXTURE_MODE = "contracts-junction"
  Write-Output "preliminary_controller_junction_fixture_stage=standalone_start"
  $junctionProbeRoot = Join-Path $root "junction-fixture-probe"
  $junctionProbe = Start-Process -FilePath $productionFixture -ArgumentList (Get-PreliminaryNsisArguments -InstallRoot $junctionProbeRoot) -Wait -PassThru
  Write-Output "preliminary_controller_junction_fixture_installer_exit=$($junctionProbe.ExitCode)"
  if ($junctionProbe.ExitCode -ne 0 -and [IO.File]::Exists($junctionReady)) {
    Write-Output "preliminary_controller_junction_fixture_diagnostic=$([IO.File]::ReadAllText($junctionReady) -replace '[\r\n]+', ' ')"
  }
  Assert-True ($junctionProbe.ExitCode -eq 0) "production directory junction fixture setup failed"
  Assert-True ([IO.File]::Exists($junctionReady)) "production directory junction fixture did not signal completion"
  $junctionProbeLink = Join-Path $junctionProbeRoot "contracts"
  $junctionProbeItem = Get-Item -LiteralPath $junctionProbeLink -Force
  Assert-True (($junctionProbeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) "production directory junction fixture did not create a reparse point"
  Assert-True (@($junctionProbeItem.Target).Count -eq 1) "production directory junction fixture target is ambiguous"
  Assert-True ([IO.Path]::GetFullPath([string]$junctionProbeItem.Target) -ceq [IO.Path]::GetFullPath($externalContractsTarget)) "production directory junction fixture target identity drift"
  Assert-True (@([IO.Directory]::EnumerateFileSystemEntries($externalContractsTarget)).Count -eq 1) "production directory junction fixture mutated its target"
  $oldPathCopy = Join-Path $junctionProbeLink "old-path-copy.bin"
  [IO.File]::Copy($productionInputs["adapter"], $oldPathCopy, $false)
  Assert-True ([IO.File]::Exists((Join-Path $externalContractsTarget "old-path-copy.bin"))) "production junction reached vulnerable copy"
  [IO.File]::Delete($oldPathCopy)
  Write-Output "preliminary_controller_junction_fixture_stage=verified;installer_exit=0;reparse=true;target_identity=exact;external_entries=1"
  Remove-TestTree $junctionProbeRoot
  Remove-TestTree $junctionReady
  $env:BHARATCODE_PRELIMINARY_FIXTURE_MODE = "success"
  try {
    $foreignLookalike = Start-Process -FilePath $productionLookalikeExe -ArgumentList @('-t', '127.0.0.1') -PassThru
    $attempt = 10
    $boundaries = @(
      "after-create", "after-dacl", "after-file-id", "after-reservation", "after-installer-pin",
      "after-installer-launch", "after-installer-exit", "after-installer-stage", "after-installed-pin",
      "after-acceptance-directory", "after-contracts-directory", "after-inputs-directory",
      "after-adapter-copy", "after-adapter-pin", "after-validator-copy", "after-validator-pin",
      "after-frozen-harness-copy", "after-frozen-harness-pin", "after-runtime-manifest-copy",
      "after-runtime-manifest-pin", "after-runtime-copy", "after-runtime-pin", "after-evidence-write",
      "after-evidence-pin", "after-environment-binding", "after-harness-pin", "after-harness-launch",
      "after-harness-exit", "after-harness-stage", "after-receipt-pin", "after-receipt-read",
      "after-cleanup-before-publication"
    )
    foreach ($fault in $boundaries) {
      $receipt = Join-Path $root "receipt-$attempt.json"
      $invoke = @{
        RunnerTemp = $root; RunId = "720007"; RunAttempt = [string]$attempt; Installer = $productionFixture
        ExpectedVersion = $productionVersion; AdapterPath = $productionInputs["adapter"]
        ValidatorPath = $productionInputs["validator"]; FrozenHarnessPath = $productionInputs["frozen-harness"]
        RuntimeManifestPath = $productionInputs["runtime-manifest"]; RuntimePath = $productionInputs["runtime"]
        EvidenceScript = "production-evidence-bytes"; ReceiptPath = $receipt
        TestHooks = @{ Failpoint = $fault; UseInstalledDesktopAsHarness = $true }
      }
      if ($fault -ceq "after-harness-stage") {
        $stageFailure = $null
        try { Invoke-PreliminaryController @invoke; throw "Expected failure: production controlled failure $fault" }
        catch {
          if ($_.Exception.Message -eq "Expected failure: production controlled failure $fault") { throw }
          $stageFailure = $_.Exception
        }
        Write-AfterHarnessStageDiagnostics -RunnerTemp $root -RunId "720007" -RunAttempt ([string]$attempt) -Exception $stageFailure
        Assert-True ($stageFailure.Message -ceq "Injected preliminary controller failure at after-harness-stage") "after-harness-stage diagnostics captured an unexpected exception chain"
      }
      else {
        Assert-Throws { Invoke-PreliminaryController @invoke } "production controlled failure $fault"
      }
      Assert-True (-not [IO.File]::Exists($receipt)) "production failure published a receipt"
      Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720007" -RunAttempt ([string]$attempt)
      Assert-True (-not $foreignLookalike.HasExited) "production failure deleted foreign lookalike"
      Assert-True ([IO.File]::ReadAllText($foreignState) -ceq "survive") "production failure changed foreign state"
      Assert-True ($env:PRELIMINARY_ADAPTER -ceq "foreign-environment") "production failure leaked transaction environment"
      $attempt += 1
    }

    foreach ($repeat in 1..5) {
      $repeatReceipt = Join-Path $root "receipt-attempt-38-repeat-$repeat.json"
      $invoke.RunId = "720038"; $invoke.RunAttempt = [string]$repeat; $invoke.ReceiptPath = $repeatReceipt
      $invoke.TestHooks = @{ Failpoint = "after-harness-stage"; UseInstalledDesktopAsHarness = $true }
      $repeatFailure = $null
      try { Invoke-PreliminaryController @invoke; throw "Expected failure: repeated after-harness-stage" }
      catch {
        if ($_.Exception.Message -eq "Expected failure: repeated after-harness-stage") { throw }
        $repeatFailure = $_.Exception
      }
      Write-AfterHarnessStageDiagnostics -RunnerTemp $root -RunId "720038" -RunAttempt ([string]$repeat) -Exception $repeatFailure
      Assert-True ($repeatFailure.Message -ceq "Injected preliminary controller failure at after-harness-stage") "after-harness-stage diagnostics captured an unexpected repeated exception chain"
      Assert-True (-not [IO.File]::Exists($repeatReceipt)) "after-harness-stage repeat published a receipt"
      Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720038" -RunAttempt ([string]$repeat)
      Assert-True (-not $foreignLookalike.HasExited) "after-harness-stage repeat killed an unrelated process"
      Assert-True ([IO.File]::ReadAllText($foreignState) -ceq "survive") "after-harness-stage repeat changed foreign state"
      Assert-True ($env:PRELIMINARY_ADAPTER -ceq "foreign-environment") "after-harness-stage repeat leaked transaction environment"
    }

    $invoke.RunId = "720011"; $invoke.RunAttempt = "1"; $invoke.ReceiptPath = (Join-Path $root "invalid-hook-receipt.json")
    foreach ($invalidHooks in @(
      @{ Unknown = $true },
      @{ Failpoint = "after-foreign-effect"; UseInstalledDesktopAsHarness = $true },
      @{ PauseAt = "after-installer-stage"; ReadyPath = (Join-Path $root "invalid-ready") ; UseInstalledDesktopAsHarness = $true },
      @{ ReadyPath = (Join-Path $root "unbound-ready"); UseInstalledDesktopAsHarness = $true }
    )) {
      $invoke.TestHooks = $invalidHooks
      Assert-Throws { Invoke-PreliminaryController @invoke } "closed production controller test hooks"
      Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720011" -RunAttempt "1"
    }
    $savedTestAuthority = $env:BHARATCODE_PRELIMINARY_CONTROLLER_TEST
    Remove-Item Env:BHARATCODE_PRELIMINARY_CONTROLLER_TEST
    try {
      $invoke.TestHooks = @{ UseInstalledDesktopAsHarness = $true }
      Assert-Throws { Invoke-PreliminaryController @invoke } "production controller test authority"
    }
    finally { $env:BHARATCODE_PRELIMINARY_CONTROLLER_TEST = $savedTestAuthority }
    Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720011" -RunAttempt "1"

    $successReceipt = Join-Path $root "receipt-success.json"
    $env:BHARATCODE_PRELIMINARY_FIXTURE_MODE = "assert-pins"
    $invoke.RunId = "720008"
    $invoke.RunAttempt = "1"
    $invoke.ReceiptPath = $successReceipt
    $invoke.TestHooks = @{ UseInstalledDesktopAsHarness = $true }
    Invoke-PreliminaryController @invoke
    $receiptValue = Get-Content -LiteralPath $successReceipt -Raw | ConvertFrom-Json
    Assert-True ($receiptValue.cleanup_complete -eq $true) "successful receipt did not bind cleanup"
    Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720008" -RunAttempt "1"
    Remove-TestTree $successReceipt

    foreach ($failure in @(
      @{ Name = "installer failure"; Mode = "installer-failure"; Hooks = @{ UseInstalledDesktopAsHarness = $true } },
      @{ Name = "production installer assignment failure"; Mode = "success"; Hooks = @{ UseInstalledDesktopAsHarness = $true; ForceInstallerAssignmentFailure = $true } },
      @{ Name = "harness failure"; Mode = "harness-failure"; Hooks = @{ UseInstalledDesktopAsHarness = $true } },
      @{ Name = "missing candidate"; Mode = "no-candidate"; Hooks = @{ UseInstalledDesktopAsHarness = $true } },
      @{ Name = "production candidate substitution"; Mode = "candidate-directory"; Hooks = @{ UseInstalledDesktopAsHarness = $true } },
      @{ Name = "production candidate reparse-point substitution"; Mode = "candidate-junction"; Hooks = @{ UseInstalledDesktopAsHarness = $true } },
      @{ Name = "production candidate hardlink substitution"; Mode = "candidate-hardlink"; Hooks = @{ UseInstalledDesktopAsHarness = $true } },
      @{ Name = "production directory junction substitution"; Mode = "contracts-junction"; Hooks = @{ UseInstalledDesktopAsHarness = $true } },
      @{ Name = "production evidence collision"; Mode = "evidence-collision"; Hooks = @{ UseInstalledDesktopAsHarness = $true } },
      @{ Name = "production controller assignment failure"; Mode = "success"; Hooks = @{ UseInstalledDesktopAsHarness = $true; ForceHarnessAssignmentFailure = $true } }
    )) {
      $attempt += 1
      $receipt = Join-Path $root "receipt-failure-$attempt.json"
      $env:BHARATCODE_PRELIMINARY_FIXTURE_MODE = $failure.Mode
      $invoke.RunId = "720010"; $invoke.RunAttempt = [string]$attempt; $invoke.ReceiptPath = $receipt; $invoke.TestHooks = $failure.Hooks
      if ($failure.Name -eq "production directory junction substitution") {
        Write-Output "preliminary_controller_junction_production_stage=invoke"
      }
      if ($failure.Name -eq "production directory junction substitution") {
        $null = Assert-ThrowsContaining { Invoke-PreliminaryController @invoke } "Preliminary relative NtCreateFile failed" "owned directory collision preceded copy"
      }
      else { Assert-Throws { Invoke-PreliminaryController @invoke } $failure.Name }
      Assert-True (-not [IO.File]::Exists($receipt)) "production failure published a receipt"
      Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720010" -RunAttempt ([string]$attempt)
      Assert-True (-not $foreignLookalike.HasExited) "production failure deleted foreign lookalike"
      Assert-True ([IO.File]::ReadAllText($externalCandidateTarget) -ceq '{"foreign":true}') "production candidate substitution changed foreign bytes"
      Assert-True ([IO.File]::ReadAllText($foreignState) -ceq "survive") "production failure changed foreign state"
      Assert-True ($env:PRELIMINARY_ADAPTER -ceq "foreign-environment") "production failure leaked transaction environment"
      if ($failure.Name -eq "production directory junction substitution") {
        $junctionEntries = @([IO.Directory]::EnumerateFileSystemEntries($externalContractsTarget) | Sort-Object)
        $junctionEntryNames = @($junctionEntries | ForEach-Object { [IO.Path]::GetFileName($_) })
        Write-Output "preliminary_controller_junction_external_target=entry_count:$($junctionEntries.Count);mutated:$($junctionEntries.Count -ne 1);entries:$([string]::Join(',', $junctionEntryNames))"
        Assert-True ([IO.File]::Exists($junctionReady)) "production directory junction fixture did not execute"
        Assert-True ([IO.File]::ReadAllText((Join-Path $externalContractsTarget "survive.txt")) -ceq "survive") "production directory junction changed foreign bytes"
        Assert-True ($junctionEntries.Count -eq 1) "production directory junction wrote outside the lease"
        Assert-True (-not [IO.File]::Exists((Join-Path $externalContractsTarget "wsl-windows-preliminary-acceptance.mjs"))) "owned directory collision preceded copy"
      }
    }
    $attempt += 1
    $receipt = Join-Path $root "receipt-failure-$attempt.json"
    [IO.File]::WriteAllText($receipt, "foreign-receipt", [Text.UTF8Encoding]::new($false))
    $env:BHARATCODE_PRELIMINARY_FIXTURE_MODE = "success"
    $invoke.RunId = "720010"; $invoke.RunAttempt = [string]$attempt; $invoke.ReceiptPath = $receipt
    $invoke.TestHooks = @{ UseInstalledDesktopAsHarness = $true }
    Assert-Throws { Invoke-PreliminaryController @invoke } "production final receipt collision"
    Assert-True ([IO.File]::ReadAllText($receipt) -ceq "foreign-receipt") "receipt collision did not overwrite"
    Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720010" -RunAttempt ([string]$attempt)
    Assert-True (-not $foreignLookalike.HasExited) "final receipt collision killed an unrelated process"
    Assert-True ([IO.File]::ReadAllText($foreignState) -ceq "survive") "final receipt collision changed foreign state"
    Assert-True ([IO.File]::ReadAllText($externalCandidateTarget) -ceq '{"foreign":true}') "final receipt collision changed foreign candidate bytes"
    Assert-True ($env:PRELIMINARY_ADAPTER -ceq "foreign-environment") "final receipt collision leaked transaction environment"
    Remove-TestTree $receipt
    $env:BHARATCODE_PRELIMINARY_FIXTURE_MODE = "success"
    Assert-True ([IO.File]::ReadAllText($productionInputs["adapter"]) -ceq "adapter-bytes") "production immutable input substitution succeeded"
  }
  finally {
    Remove-Item Env:BHARATCODE_PRELIMINARY_FIXTURE_MODE -ErrorAction SilentlyContinue
    Remove-Item Env:BHARATCODE_PRELIMINARY_FIXTURE_EXTERNAL_TARGET -ErrorAction SilentlyContinue
    Remove-Item Env:BHARATCODE_PRELIMINARY_FIXTURE_EXTERNAL_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:BHARATCODE_PRELIMINARY_FIXTURE_JUNCTION_READY -ErrorAction SilentlyContinue
    [Environment]::SetEnvironmentVariable("PRELIMINARY_ADAPTER", $previousAdapterEnvironment, [EnvironmentVariableTarget]::Process)
    if ($foreignLookalike -and -not $foreignLookalike.HasExited) { Stop-Process -Id $foreignLookalike.Id -Force }
    if ($foreignLookalike) { $foreignLookalike.WaitForExit() }
    Remove-TestTree $foreignState
  }

  $ready = Join-Path $root "crash-ready.txt"
  $crashReceipt = Join-Path $root "crash-receipt.json"
  $controller = Join-Path $PSScriptRoot "wsl-windows-preliminary-controller.ps1"
  $crashScript = Join-Path $productionFixtureRoot "invoke-production-crash.ps1"
  $crashBody = @"
`$ErrorActionPreference = "Stop"
`$env:BHARATCODE_PRELIMINARY_CONTROLLER_TEST = "1"
`$env:BHARATCODE_PRELIMINARY_FIXTURE_MODE = "success"
. $(ConvertTo-PsSingleQuotedLiteral $controller)
`$invoke = @{
  RunnerTemp = $(ConvertTo-PsSingleQuotedLiteral $root)
  RunId = "720009"
  RunAttempt = "1"
  Installer = $(ConvertTo-PsSingleQuotedLiteral $productionFixture)
  ExpectedVersion = $(ConvertTo-PsSingleQuotedLiteral $productionVersion)
  AdapterPath = $(ConvertTo-PsSingleQuotedLiteral $productionInputs["adapter"])
  ValidatorPath = $(ConvertTo-PsSingleQuotedLiteral $productionInputs["validator"])
  FrozenHarnessPath = $(ConvertTo-PsSingleQuotedLiteral $productionInputs["frozen-harness"])
  RuntimeManifestPath = $(ConvertTo-PsSingleQuotedLiteral $productionInputs["runtime-manifest"])
  RuntimePath = $(ConvertTo-PsSingleQuotedLiteral $productionInputs["runtime"])
  EvidenceScript = "production-evidence-bytes"
  ReceiptPath = $(ConvertTo-PsSingleQuotedLiteral $crashReceipt)
  TestHooks = @{ UseInstalledDesktopAsHarness = `$true; PauseAt = "after-receipt-read"; ReadyPath = $(ConvertTo-PsSingleQuotedLiteral $ready) }
}
Invoke-PreliminaryController @invoke
"@
  [IO.File]::WriteAllText($crashScript, $crashBody, [Text.UTF8Encoding]::new($false))
  $crash = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList "-NoProfile -NonInteractive -File `"$crashScript`"" -PassThru
  Wait-Until {
    try { [IO.File]::Exists($ready) -and ([IO.FileInfo]::new($ready)).Length -gt 0 }
    catch { $false }
  } "crash probe did not acquire authority"
  Stop-Process -Id $crash.Id -Force
  $crash.WaitForExit()
  Assert-True (-not [IO.File]::Exists($crashReceipt)) "terminated production controller published a receipt"
  Assert-Throws { Assert-PreliminaryNamespacePrefixAbsent -RunnerTemp $root -RunId "720009" -RunAttempt "1" } "crash orphan observation"
  $crashRoot = [IO.File]::ReadAllText($ready)
  Assert-True (Test-PreliminaryEntryNoFollow -Path $crashRoot) "controller crash did not leave the documented orphan"
  Assert-True ([IO.File]::Exists((Join-Path $crashRoot "receipt-candidate.json"))) "production crash did not retain the lease-owned candidate"
  Assert-True ([IO.File]::Exists((Join-Path $PSScriptRoot "../../opencode/script/lean-preliminary-jit-lifecycle.mjs"))) "external JIT host controller remains required"
  $workflow = [IO.File]::ReadAllText((Join-Path $PSScriptRoot "../../../.github/workflows/bharatcode-preliminary-unsigned-wsl.yml"))
  Assert-True ([IO.File]::Exists((Join-Path $PSScriptRoot "preliminary-wsl-jit-host-controller.ps1"))) "external JIT host controller remains required"
  Assert-True (-not $workflow.Contains("bharatcode-preliminary-jit-admission.json") -and -not $workflow.Contains("bharatcode-preliminary-jit-destruction.json")) "workflow forged host lifecycle evidence"
  Write-Output "preliminary_controller_crash_retained_state=external_jit_required"

  Write-Output "preliminary_controller_windows_tests=passed"
}
catch {
  $controllerTestFailure = $_.Exception
  $failureFault = if (Get-Variable -Name fault -ErrorAction SilentlyContinue) { $fault } else { "unavailable" }
  $failureAttempt = if (Get-Variable -Name attempt -ErrorAction SilentlyContinue) { $attempt } else { "unavailable" }
  Write-Output "preliminary_controller_failure_context=fault=$failureFault;attempt=$failureAttempt"
  Write-Output "preliminary_controller_failure_stack=$($_.ScriptStackTrace -replace '[\r\n]+', ' | ')"
}
finally {
  $outerCleanupFailures = [Collections.Generic.List[Exception]]::new()
  if ($links) {
    try { Remove-PreliminaryControllerLease -Lease $links }
    catch { [void]$outerCleanupFailures.Add($_.Exception) }
  }
  if ($linkExternalRoot) {
    try { Remove-TestTree $linkExternalRoot }
    catch { [void]$outerCleanupFailures.Add($_.Exception) }
  }
  try { Remove-TestTree $root }
  catch { [void]$outerCleanupFailures.Add($_.Exception) }
  Remove-Item Env:BHARATCODE_PRELIMINARY_CONTROLLER_TEST -ErrorAction SilentlyContinue
  if ($controllerTestFailure -and $outerCleanupFailures.Count -ne 0) {
    $allFailures = [Collections.Generic.List[Exception]]::new()
    [void]$allFailures.Add($controllerTestFailure)
    [void]$allFailures.AddRange($outerCleanupFailures)
    throw [AggregateException]::new("Preliminary controller tests and outer cleanup failed", [Exception[]]$allFailures.ToArray())
  }
  if ($outerCleanupFailures.Count -eq 1) { throw $outerCleanupFailures[0] }
  if ($outerCleanupFailures.Count -gt 1) { throw [AggregateException]::new("Preliminary outer cleanup failed", [Exception[]]$outerCleanupFailures.ToArray()) }
}
if ($controllerTestFailure) { throw $controllerTestFailure }
