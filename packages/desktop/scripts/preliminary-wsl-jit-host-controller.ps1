[CmdletBinding()]
param(
  [ValidateSet("Validate", "Live")] [string] $Mode = "Validate",
  [string] $Repository = "BharatCode-ai/bharatcode-desktop",
  [string] $Workflow = ".github/workflows/bharatcode-preliminary-unsigned-wsl.yml",
  [string] $SourceSha,
  [string] $Ref = "dev",
  [string] $BaseVhdxPath,
  [string] $BaseVhdxSha256,
  [string] $RunnerArchivePath,
  [string] $RunnerArchiveSha256,
  [string] $HostTemporaryRoot,
  [string] $OutputDirectory,
  [string] $VmSwitchName,
  [pscredential] $GuestCredential,
  [int] $RunnerGroupId = 1,
  [int] $VmProcessorCount = 2,
  [long] $VmMemoryBytes = 4GB,
  [long] $VmDiskBytes = 64GB,
  [int] $TimeoutSeconds = 1800
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-PreliminaryWslJitHostController {
  [CmdletBinding()]
  param(
    [ValidateSet("Validate", "Live")] [string] $Mode,
    [string] $Repository,
    [string] $Workflow,
    [string] $SourceSha,
    [string] $Ref,
    [string] $BaseVhdxPath,
    [string] $BaseVhdxSha256,
    [string] $RunnerArchivePath,
    [string] $RunnerArchiveSha256,
    [string] $HostTemporaryRoot,
    [string] $OutputDirectory,
    [string] $VmSwitchName,
    [object] $GuestCredential,
    [int] $RunnerGroupId,
    [int] $VmProcessorCount,
    [long] $VmMemoryBytes,
    [long] $VmDiskBytes,
    [int] $TimeoutSeconds,
    [hashtable] $Operations
  )

  Assert-PreliminaryWslJitInputs @PSBoundParameters
  if ($Mode -ceq "Validate") {
    return [pscustomobject]@{ Status = "VALIDATED"; Repository = $Repository; Workflow = $Workflow; SourceSha = $SourceSha }
  }

  $requiredOperations = @(
    "IsElevated", "GetLocalSourceSha", "AssertPrerequisites", "DispatchWorkflow",
    "GenerateRepositoryJitConfiguration", "CreateOwnedVm", "TransferAndStartRunner", "ObserveRunner",
    "ValidateAdmission", "WriteEvidence", "WaitForWorkflow", "ValidateReceipt", "TeardownOwnedResources",
    "ObserveRunnerAbsent", "ObserveOwnedResourcesAbsent", "ValidateDestruction"
  )
  if ((($Operations.Keys | Sort-Object) -join "`n") -cne (($requiredOperations | Sort-Object) -join "`n")) {
    throw "Preliminary JIT operation boundary is not closed"
  }

  $context = [pscustomobject]@{
    Repository = $Repository
    Workflow = $Workflow
    SourceSha = $SourceSha
    Ref = $Ref
    BaseVhdxPath = [IO.Path]::GetFullPath($BaseVhdxPath)
    BaseVhdxSha256 = $BaseVhdxSha256
    RunnerArchivePath = [IO.Path]::GetFullPath($RunnerArchivePath)
    RunnerArchiveSha256 = $RunnerArchiveSha256
    HostTemporaryRoot = [IO.Path]::GetFullPath($HostTemporaryRoot)
    OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
    VmSwitchName = $VmSwitchName
    GuestCredential = $GuestCredential
    RunnerGroupId = $RunnerGroupId
    VmProcessorCount = $VmProcessorCount
    VmMemoryBytes = $VmMemoryBytes
    VmDiskBytes = $VmDiskBytes
    TimeoutSeconds = $TimeoutSeconds
    InvocationId = [Guid]::NewGuid().ToString("N")
    JitEndpoint = "/repos/$Repository/actions/runners/generate-jitconfig"
    RunId = $null
    RunAttempt = $null
    RequiredLabels = $null
    RunnerId = $null
    RunnerName = $null
  }
  if (-not (& $Operations["IsElevated"] $context)) { throw "Preliminary JIT live mode requires an elevated PowerShell session" }
  if ((& $Operations["GetLocalSourceSha"] $context) -cne $SourceSha) { throw "Preliminary JIT local source identity mismatch" }
  [void](& $Operations["AssertPrerequisites"] $context)

  $jitConfiguration = $null
  $owned = [pscustomobject]@{
    Owned = $true
    AuthorityEstablished = $false
    RootPath = [IO.Path]::Combine($context.HostTemporaryRoot, "bharatcode-preliminary-jit-$($context.InvocationId)")
    VmName = "bharatcode-preliminary-jit-$($context.InvocationId)"
    VmId = $null
    DiskPath = [IO.Path]::Combine($context.HostTemporaryRoot, "bharatcode-preliminary-jit-$($context.InvocationId)", "guest.vhdx")
    NetworkNames = @()
  }
  $admission = $null
  $admissionCanonical = $null
  $admissionWritten = $false
  $destructionCanonical = $null
  $receiptValidated = $false
  $primary = $null
  $cleanupErrors = [Collections.Generic.List[Exception]]::new()
  try {
    $dispatch = & $Operations["DispatchWorkflow"] $context
    Assert-PreliminaryDispatch $dispatch $context
    $context.RunId = [string]$dispatch.RunId
    $context.RunAttempt = [string]$dispatch.RunAttempt
    $context.RequiredLabels = @("self-hosted", "windows", "x64", "wsl2", "bharatcode-acceptance-$($context.RunId)-$($context.RunAttempt)")

    $jit = & $Operations["GenerateRepositoryJitConfiguration"] $context
    if ($jit.Endpoint -cne $context.JitEndpoint -or $jit.RunnerId -notmatch '^[1-9][0-9]*$' -or [string]::IsNullOrWhiteSpace($jit.RunnerName) -or [string]::IsNullOrWhiteSpace($jit.EncodedJitConfiguration)) {
      throw "Repository JIT configuration response is invalid"
    }
    $context.RunnerId = [string]$jit.RunnerId
    $context.RunnerName = [string]$jit.RunnerName
    $jitConfiguration = [string]$jit.EncodedJitConfiguration
    $jit = $null

    $owned = & $Operations["CreateOwnedVm"] $context $owned
    Assert-PreliminaryOwnedResources $owned $context
    [void](& $Operations["TransferAndStartRunner"] $context $owned $jitConfiguration)
    $jitConfiguration = $null

    $observed = & $Operations["ObserveRunner"] $context
    Assert-PreliminaryObservedRunner $observed $context
    $bindings = [ordered]@{
      source_sha = $context.SourceSha
      run_id = $context.RunId
      run_attempt = $context.RunAttempt
      required_labels = @($context.RequiredLabels)
      provider = "bharatcode-jit-controller"
      controller_identity = "controller/preliminary-wsl-jit-v1"
      admission_observation_id = "admission-$($context.RunId)-$($context.RunAttempt)-$($context.InvocationId)"
      runner_id = $context.RunnerId
      runner_name_sha256 = Get-PreliminarySha256 ([string]$context.RunnerName)
      vm_instance_id_sha256 = Get-PreliminarySha256 ([string]$owned.VmId)
      vm_image_sha256 = $context.BaseVhdxSha256
      admission_observed_at = [string]$observed.ObservedAt
    }
    $admitted = [DateTimeOffset]::ParseExact($bindings.admission_observed_at, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
    $admission = [ordered]@{
      schema = "bharatcode-preliminary-jit-admission-v1"
      evidence_class = "PRELIMINARY_UNSIGNED"
      promotable = $false
      composable = $false
      repository = $context.Repository
      workflow = $context.Workflow
      source_sha = $context.SourceSha
      github = [ordered]@{ run_id = $context.RunId; run_attempt = $context.RunAttempt }
      provenance = [ordered]@{
        authority = "INDEPENDENT_HOST_CONTROL_PLANE"; guest_originated = $false
        provider = $bindings.provider; controller_identity = $bindings.controller_identity
        observation_id = $bindings.admission_observation_id; observed_at = $bindings.admission_observed_at
      }
      runner = [ordered]@{
        runner_id = $context.RunnerId; runner_name_sha256 = $bindings.runner_name_sha256; scope = "repository"
        labels = @($context.RequiredLabels); jit = $true; ephemeral = $true; one_run = $true; no_other_workload = $true
        registered_at = [string]$observed.RegisteredAt
      }
      vm = [ordered]@{ instance_id_sha256 = $bindings.vm_instance_id_sha256; image_sha256 = $bindings.vm_image_sha256; dedicated = $true }
      admitted_at = $admitted.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
      expires_at = $admitted.AddSeconds($context.TimeoutSeconds).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
    }
    $admissionCanonical = [string](& $Operations["ValidateAdmission"] $admission $bindings)
    [void](& $Operations["WriteEvidence"] $context "admission" $admissionCanonical)
    $admissionWritten = $true

    $workflowResult = & $Operations["WaitForWorkflow"] $context $owned
    Assert-PreliminaryWorkflowResult $workflowResult $context
    if ($workflowResult.Conclusion -cne "success") { throw "Exact preliminary workflow did not succeed" }
    [void](& $Operations["ValidateReceipt"] $workflowResult.Receipt $context)
    $receiptValidated = $true
  }
  catch { $primary = $_.Exception }
  finally {
    $jitConfiguration = $null
    try { [void](& $Operations["TeardownOwnedResources"] $context $owned) }
    catch { [void]$cleanupErrors.Add($_.Exception) }

    $runnerAbsent = $false
    $resourcesAbsent = $false
    try {
      $runnerAbsent = [bool](& $Operations["ObserveRunnerAbsent"] $context)
      if (-not $runnerAbsent) { throw "Repository JIT runner absence was not proven" }
    }
    catch { [void]$cleanupErrors.Add($_.Exception) }
    try {
      $resourcesAbsent = [bool](& $Operations["ObserveOwnedResourcesAbsent"] $context $owned)
      if (-not $resourcesAbsent) { throw "Owned VM, disk, network, or temporary-file absence was not proven" }
    }
    catch { [void]$cleanupErrors.Add($_.Exception) }

    if ($admissionWritten -and $runnerAbsent -and $resourcesAbsent) {
      try {
        $completed = [DateTimeOffset]::UtcNow
        $admittedAt = [DateTimeOffset]::Parse([string]$admission.admitted_at, [Globalization.CultureInfo]::InvariantCulture)
        if ($completed -le $admittedAt) { $completed = $admittedAt.AddMilliseconds(1) }
        $completedAt = $completed.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
        $destructionBindings = [ordered]@{}
        foreach ($entry in $bindings.GetEnumerator()) { $destructionBindings[$entry.Key] = $entry.Value }
        $destructionBindings.destruction_observation_id = "destruction-$($context.RunId)-$($context.RunAttempt)-$($context.InvocationId)"
        $destructionBindings.destruction_observed_at = $completedAt
        $destruction = [ordered]@{
          schema = "bharatcode-preliminary-jit-destruction-v1"; evidence_class = "PRELIMINARY_UNSIGNED"
          promotable = $false; composable = $false; repository = $context.Repository; workflow = $context.Workflow
          source_sha = $context.SourceSha; github = [ordered]@{ run_id = $context.RunId; run_attempt = $context.RunAttempt }
          admission_sha256 = Get-PreliminarySha256 $admissionCanonical
          provenance = [ordered]@{
            authority = "INDEPENDENT_HOST_CONTROL_PLANE"; guest_originated = $false; provider = $destructionBindings.provider
            controller_identity = $destructionBindings.controller_identity; observation_id = $destructionBindings.destruction_observation_id
            observed_at = $destructionBindings.destruction_observed_at
          }
          runner = [ordered]@{ runner_id = $context.RunnerId; deregistered = $true; deregistered_at = $completedAt }
          vm = [ordered]@{ instance_id_sha256 = $bindings.vm_instance_id_sha256; destroyed = $true; destroyed_at = $completedAt }
          completed_at = $completedAt
        }
        $destructionCanonical = [string](& $Operations["ValidateDestruction"] $destruction $admission $destructionBindings)
        [void](& $Operations["WriteEvidence"] $context "destruction" $destructionCanonical)
      }
      catch { [void]$cleanupErrors.Add($_.Exception) }
    }
  }

  if ($primary -or $cleanupErrors.Count -gt 0) {
    if ($primary -and $cleanupErrors.Count -gt 0) {
      throw [AggregateException]::new("Preliminary JIT execution and destruction failed", @($primary) + [Exception[]]$cleanupErrors.ToArray())
    }
    if ($primary) { throw $primary }
    if ($cleanupErrors.Count -eq 1) { throw $cleanupErrors[0] }
    throw [AggregateException]::new("Preliminary JIT destruction failed", [Exception[]]$cleanupErrors.ToArray())
  }
  if (-not $receiptValidated -or [string]::IsNullOrWhiteSpace($admissionCanonical) -or [string]::IsNullOrWhiteSpace($destructionCanonical)) {
    throw "Preliminary JIT closed lifecycle is incomplete"
  }
  return [pscustomobject]@{
    Status = "PASS"; EvidenceClass = "PRELIMINARY_UNSIGNED"; Promotable = $false; Composable = $false
    Repository = $context.Repository; Workflow = $context.Workflow; SourceSha = $context.SourceSha
    RunId = $context.RunId; RunAttempt = $context.RunAttempt
  }
}

function Assert-PreliminaryWslJitInputs {
  param(
    [string] $Mode, [string] $Repository, [string] $Workflow, [string] $SourceSha, [string] $Ref,
    [string] $BaseVhdxPath, [string] $BaseVhdxSha256, [string] $RunnerArchivePath, [string] $RunnerArchiveSha256,
    [string] $HostTemporaryRoot, [string] $OutputDirectory, [string] $VmSwitchName, [object] $GuestCredential,
    [int] $RunnerGroupId, [int] $VmProcessorCount, [long] $VmMemoryBytes, [long] $VmDiskBytes,
    [int] $TimeoutSeconds, [hashtable] $Operations
  )
  if ($Repository -cne "BharatCode-ai/bharatcode-desktop") { throw "Preliminary JIT repository is invalid" }
  if ($Workflow -cne ".github/workflows/bharatcode-preliminary-unsigned-wsl.yml") { throw "Preliminary JIT workflow is invalid" }
  if ($Ref -cne "dev" -or $SourceSha -cnotmatch '^[0-9a-f]{40}$') { throw "Preliminary JIT source identity is invalid" }
  foreach ($pair in @(@($BaseVhdxPath, $BaseVhdxSha256), @($RunnerArchivePath, $RunnerArchiveSha256))) {
    if (-not [IO.File]::Exists($pair[0]) -or $pair[1] -cnotmatch '^[0-9a-f]{64}$') { throw "Prepared dependency is invalid" }
    if ((Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pair[1]) { throw "Prepared dependency digest mismatch" }
  }
  foreach ($path in @($HostTemporaryRoot, $OutputDirectory)) {
    if (-not [IO.Directory]::Exists($path)) { throw "Prepared host directory is invalid" }
  }
  if ([string]::IsNullOrWhiteSpace($VmSwitchName) -or $null -eq $GuestCredential) { throw "Prepared guest boundary is incomplete" }
  if ($RunnerGroupId -lt 1 -or $VmProcessorCount -lt 1 -or $VmProcessorCount -gt 8) { throw "VM processor or runner group bound is invalid" }
  if ($VmMemoryBytes -lt 2GB -or $VmMemoryBytes -gt 32GB -or $VmDiskBytes -lt 32GB -or $VmDiskBytes -gt 256GB) { throw "VM memory or disk bound is invalid" }
  if ($TimeoutSeconds -lt 60 -or $TimeoutSeconds -gt 1800) { throw "Preliminary JIT timeout is invalid" }
  if ($null -eq $Operations) { throw "Preliminary JIT operation boundary is missing" }
}

function Assert-PreliminaryDispatch {
  param([object] $Dispatch, [object] $Context)
  if ($Dispatch.Repository -cne $Context.Repository -or $Dispatch.Workflow -cne $Context.Workflow -or $Dispatch.SourceSha -cne $Context.SourceSha) { throw "Dispatched workflow identity drift" }
  if ([string]$Dispatch.RunId -cnotmatch '^[1-9][0-9]*$' -or [string]$Dispatch.RunAttempt -cnotmatch '^[1-9][0-9]*$') { throw "Dispatched workflow run identity is invalid" }
}

function Assert-PreliminaryOwnedResources {
  param([object] $Owned, [object] $Context)
  $expectedRoot = [IO.Path]::Combine($Context.HostTemporaryRoot, "bharatcode-preliminary-jit-$($Context.InvocationId)")
  if (-not $Owned.Owned -or -not $Owned.AuthorityEstablished -or $Owned.RootPath -cne $expectedRoot -or $Owned.VmName -cne "bharatcode-preliminary-jit-$($Context.InvocationId)" -or [string]::IsNullOrWhiteSpace($Owned.VmId)) { throw "Owned VM identity is invalid" }
  if ($Owned.DiskPath -cne [IO.Path]::Combine($expectedRoot, "guest.vhdx") -or @($Owned.NetworkNames).Count -ne 0) { throw "Owned disk or network identity is invalid" }
}

function Assert-PreliminaryObservedRunner {
  param([object] $Observed, [object] $Context)
  if ([string]$Observed.RunnerId -cne $Context.RunnerId -or [string]$Observed.RunnerName -cne $Context.RunnerName -or [string]$Observed.Status -cne "online") { throw "Independent runner observation is invalid" }
  if (-not (Test-PreliminaryLabelSet @($Observed.Labels) @($Context.RequiredLabels))) { throw "Independent runner labels are invalid" }
  foreach ($time in @($Observed.RegisteredAt, $Observed.ObservedAt)) {
    if ([string]$time -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') { throw "Independent runner chronology is invalid" }
  }
}

function Assert-PreliminaryWorkflowResult {
  param([object] $Result, [object] $Context)
  if ($Result.Repository -cne $Context.Repository -or $Result.Workflow -cne $Context.Workflow -or $Result.SourceSha -cne $Context.SourceSha -or [string]$Result.RunId -cne $Context.RunId -or [string]$Result.RunAttempt -cne $Context.RunAttempt) { throw "Completed workflow identity drift" }
  if ([string]$Result.Conclusion -notin @("success", "failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale")) { throw "Completed workflow conclusion is invalid" }
}

function Get-PreliminarySha256 {
  param([string] $Value)
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant()
}

function Test-PreliminaryLabelSet {
  param([string[]] $Actual, [string[]] $Expected)
  if ($Actual.Count -ne $Expected.Count -or @($Actual | Sort-Object -Unique -CaseSensitive).Count -ne $Actual.Count) { return $false }
  return (($Actual | Sort-Object -CaseSensitive) -join "`n") -ceq (($Expected | Sort-Object -CaseSensitive) -join "`n")
}

function Invoke-PreliminaryProcess {
  param([string] $FilePath, [string[]] $ArgumentList, [string] $InputText, [int] $TimeoutMilliseconds = 300000)
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $FilePath
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.RedirectStandardInput = $null -ne $InputText
  foreach ($argument in $ArgumentList) { [void]$start.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw "Prepared command could not start" }
  if ($null -ne $InputText) { $process.StandardInput.Write($InputText); $process.StandardInput.Close() }
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutMilliseconds)) { $process.Kill($true); throw "Prepared command timed out" }
  $output = $stdout.GetAwaiter().GetResult()
  [void]$stderr.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) { throw "Prepared command failed" }
  return $output
}

function Invoke-PreliminaryGhJson {
  param([string] $Method, [string] $Endpoint, [object] $Body)
  $arguments = @("api", "--method", $Method, $Endpoint, "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10")
  $input = $null
  if ($null -ne $Body) { $arguments += @("--input", "-"); $input = $Body | ConvertTo-Json -Depth 20 -Compress }
  $raw = Invoke-PreliminaryProcess (Get-Command gh -CommandType Application).Source $arguments $input
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return $raw | ConvertFrom-Json -Depth 30
}

function Find-PreliminaryRepositoryRunner {
  param([object] $Context)
  for ($page = 1; $page -le 100; $page++) {
    $response = Invoke-PreliminaryGhJson "GET" "repos/$($Context.Repository)/actions/runners?per_page=100&page=$page" $null
    $matches = @($response.runners | Where-Object { [string]$_.id -ceq $Context.RunnerId })
    if ($matches.Count -gt 1) { throw "Repository runner ID is not unique" }
    if ($matches.Count -eq 1) {
      if ([string]$matches[0].name -cne $Context.RunnerName) { throw "Repository runner name identity drift" }
      return $matches[0]
    }
    if (@($response.runners).Count -lt 100) { return $null }
  }
  throw "Repository runner enumeration exceeded its bound"
}

function Invoke-PreliminaryLifecycleAdapter {
  param([ValidateSet("admission", "destruction", "receipt")] [string] $Operation, [object] $Input)
  $bun = (Get-Command bun -CommandType Application).Source
  $adapter = Join-Path $PSScriptRoot "../../opencode/script/preliminary-jit-evidence-cli.mjs"
  return Invoke-PreliminaryProcess $bun @($adapter, $Operation) ($Input | ConvertTo-Json -Depth 30 -Compress)
}

function New-PreliminaryWslJitLiveOperations {
  return @{
    IsElevated = {
      $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
      return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    GetLocalSourceSha = { (Invoke-PreliminaryProcess (Get-Command git -CommandType Application).Source @("rev-parse", "HEAD") $null).Trim() }
    AssertPrerequisites = {
      param($Context)
      if ($ExecutionContext.SessionState.LanguageMode -ne [Management.Automation.PSLanguageMode]::FullLanguage) { throw "PowerShell FullLanguage is required" }
      foreach ($command in @("gh", "git", "bun", "Get-VM", "Get-VHD", "New-VHD", "New-VM", "Set-VMProcessor", "Start-VM", "Stop-VM", "Remove-VM", "Get-VMSwitch")) { if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Missing prepared prerequisite: $command" } }
      if (-not ($Context.GuestCredential -is [pscredential])) { throw "PowerShell Direct guest credential is required" }
      if (-not (Get-VMSwitch -Name $Context.VmSwitchName -ErrorAction SilentlyContinue)) { throw "Prepared Hyper-V switch is unavailable" }
      if ((Invoke-PreliminaryProcess (Get-Command git -CommandType Application).Source @("status", "--porcelain") $null).Length -ne 0) { throw "Live controller checkout must be clean" }
      $origin = (Invoke-PreliminaryProcess (Get-Command git -CommandType Application).Source @("remote", "get-url", "origin") $null).Trim()
      if ($origin -notmatch 'BharatCode-ai[/:]bharatcode-desktop(?:\.git)?$') { throw "Live controller origin is invalid" }
      $vhd = Get-VHD -Path $Context.BaseVhdxPath
      if ($vhd.VhdType -notin @("Fixed", "Dynamic") -or $vhd.Size -gt $Context.VmDiskBytes) { throw "Prepared base VHDX exceeds the approved disk bound" }
      if ([IO.Path]::GetExtension($Context.RunnerArchivePath) -cne ".zip") { throw "Prepared runner archive is invalid" }
    }
    DispatchWorkflow = {
      param($Context)
      $workflowName = [Uri]::EscapeDataString([IO.Path]::GetFileName($Context.Workflow))
      $response = Invoke-PreliminaryGhJson "POST" "repos/$($Context.Repository)/actions/workflows/$workflowName/dispatches" ([ordered]@{ ref = $Context.Ref; inputs = [ordered]@{ source_sha = $Context.SourceSha } })
      if ([string]$response.workflow_run_id -notmatch '^[1-9][0-9]*$') { throw "Workflow dispatch did not return an immutable run ID" }
      $run = Invoke-PreliminaryGhJson "GET" "repos/$($Context.Repository)/actions/runs/$($response.workflow_run_id)" $null
      return [pscustomobject]@{ Repository = $Context.Repository; Workflow = [string]$run.path; SourceSha = [string]$run.head_sha; RunId = [string]$run.id; RunAttempt = [string]$run.run_attempt }
    }
    GenerateRepositoryJitConfiguration = {
      param($Context)
      $name = "bharatcode-jit-$($Context.RunId)-$($Context.RunAttempt)-$($Context.InvocationId)"
      $response = Invoke-PreliminaryGhJson "POST" $Context.JitEndpoint ([ordered]@{ name = $name; runner_group_id = $Context.RunnerGroupId; labels = @($Context.RequiredLabels); work_folder = "_work" })
      return [pscustomobject]@{ Endpoint = $Context.JitEndpoint; RunnerId = [string]$response.runner.id; RunnerName = [string]$response.runner.name; EncodedJitConfiguration = [string]$response.encoded_jit_config }
    }
    CreateOwnedVm = {
      param($Context, $Owned)
      if ([IO.Directory]::Exists($Owned.RootPath) -or (Get-VM -Name $Owned.VmName -ErrorAction SilentlyContinue)) { throw "Run-specific Hyper-V identity collided" }
      [void][IO.Directory]::CreateDirectory($Owned.RootPath)
      $marker = Join-Path $Owned.RootPath "controller-owned.txt"
      [IO.File]::WriteAllText($marker, $Context.InvocationId, [Text.UTF8Encoding]::new($false))
      $Owned.AuthorityEstablished = $true
      [void](New-VHD -Path $Owned.DiskPath -ParentPath $Context.BaseVhdxPath -Differencing)
      $vm = New-VM -Name $Owned.VmName -Generation 2 -MemoryStartupBytes $Context.VmMemoryBytes -VHDPath $Owned.DiskPath -SwitchName $Context.VmSwitchName
      $Owned.VmId = [string]$vm.Id
      [void](Set-VMProcessor -VM $vm -Count $Context.VmProcessorCount -ExposeVirtualizationExtensions $true)
      return $Owned
    }
    TransferAndStartRunner = {
      param($Context, $Owned, $Secret)
      [void](Start-VM -Id ([Guid]$Owned.VmId))
      $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Min(300, $Context.TimeoutSeconds))
      $session = $null
      while (-not $session -and [DateTime]::UtcNow -lt $deadline) {
        try { $session = New-PSSession -VMName $Owned.VmName -Credential $Context.GuestCredential -ErrorAction Stop }
        catch { Start-Sleep -Seconds 2 }
      }
      if (-not $session) { throw "PowerShell Direct guest session timed out" }
      try {
        [void](Invoke-Command -Session $session -ScriptBlock { [void][IO.Directory]::CreateDirectory("C:\BharatCodeJit") })
        Copy-Item -LiteralPath $Context.RunnerArchivePath -Destination "C:\BharatCodeJit\runner.zip" -ToSession $session
        [void](Invoke-Command -Session $session -ArgumentList $Secret -ScriptBlock {
            param($EncodedJitConfiguration)
            Expand-Archive -LiteralPath "C:\BharatCodeJit\runner.zip" -DestinationPath "C:\BharatCodeJit\runner" -Force
            [void](Start-Process -FilePath "C:\BharatCodeJit\runner\run.cmd" -ArgumentList @("--jitconfig", $EncodedJitConfiguration) -WorkingDirectory "C:\BharatCodeJit\runner" -PassThru)
          })
      }
      finally { Remove-PSSession $session }
    }
    ObserveRunner = {
      param($Context)
      $deadline = [DateTime]::UtcNow.AddSeconds($Context.TimeoutSeconds)
      while ([DateTime]::UtcNow -lt $deadline) {
        $runner = Invoke-PreliminaryGhJson "GET" "repos/$($Context.Repository)/actions/runners/$($Context.RunnerId)" $null
        $labels = @($runner.labels | ForEach-Object { [string]$_.name })
        if ([string]$runner.id -ceq $Context.RunnerId -and [string]$runner.name -ceq $Context.RunnerName -and [string]$runner.status -ceq "online" -and (Test-PreliminaryLabelSet $labels @($Context.RequiredLabels))) {
          $now = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
          return [pscustomobject]@{ RunnerId = $Context.RunnerId; RunnerName = $Context.RunnerName; Status = "online"; Busy = [bool]$runner.busy; Labels = @($Context.RequiredLabels); RegisteredAt = $now; ObservedAt = $now }
        }
        Start-Sleep -Seconds 2
      }
      throw "Independent repository runner observation timed out"
    }
    ValidateAdmission = { param($Record, $Bindings) Invoke-PreliminaryLifecycleAdapter "admission" ([ordered]@{ record = $Record; bindings = $Bindings }) }
    WriteEvidence = {
      param($Context, $Kind, $Canonical)
      $path = Join-Path $Context.OutputDirectory "bharatcode-preliminary-jit-$Kind-$($Context.RunId)-$($Context.RunAttempt).json"
      $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Canonical)
      $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $stream.Write($bytes); $stream.Flush($true) }
      finally { $stream.Dispose() }
    }
    WaitForWorkflow = {
      param($Context, $Owned)
      $deadline = [DateTime]::UtcNow.AddSeconds($Context.TimeoutSeconds)
      while ([DateTime]::UtcNow -lt $deadline) {
        $run = Invoke-PreliminaryGhJson "GET" "repos/$($Context.Repository)/actions/runs/$($Context.RunId)" $null
        if ([string]$run.id -cne $Context.RunId -or [string]$run.run_attempt -cne $Context.RunAttempt -or [string]$run.head_sha -cne $Context.SourceSha -or [string]$run.path -cne $Context.Workflow) { throw "Exact workflow run identity drift" }
        if ([string]$run.status -ceq "completed") {
          $receipt = $null
          if ([string]$run.conclusion -ceq "success") {
            $artifactName = "preliminary-wsl-evidence-$($Context.RunId)-$($Context.RunAttempt)"
            $artifactRoot = Join-Path $Owned.RootPath "workflow-evidence"
            [void][IO.Directory]::CreateDirectory($artifactRoot)
            [void](Invoke-PreliminaryProcess (Get-Command gh -CommandType Application).Source @("run", "download", $Context.RunId, "--repo", $Context.Repository, "--name", $artifactName, "--dir", $artifactRoot) $null)
            $receiptPath = Join-Path $artifactRoot "bharatcode-wsl-preliminary-unsigned.json"
            if (-not [IO.File]::Exists($receiptPath)) { throw "Exact preliminary WSL receipt is absent" }
            $receipt = [IO.File]::ReadAllText($receiptPath)
          }
          return [pscustomobject]@{ Repository = $Context.Repository; Workflow = [string]$run.path; SourceSha = [string]$run.head_sha; RunId = [string]$run.id; RunAttempt = [string]$run.run_attempt; Conclusion = [string]$run.conclusion; Receipt = $receipt }
        }
        Start-Sleep -Seconds 2
      }
      throw [TimeoutException]::new("Exact preliminary workflow timed out")
    }
    ValidateReceipt = {
      param($Receipt, $Context)
      [void](Invoke-PreliminaryLifecycleAdapter "receipt" ([ordered]@{
            raw = [string]$Receipt
            identity = [ordered]@{ source_sha = $Context.SourceSha; run_id = $Context.RunId; run_attempt = $Context.RunAttempt }
          }))
    }
    TeardownOwnedResources = {
      param($Context, $Owned)
      $teardownErrors = [Collections.Generic.List[Exception]]::new()
      try {
        if ($Owned.AuthorityEstablished) {
          $marker = Join-Path $Owned.RootPath "controller-owned.txt"
          if (-not [IO.File]::Exists($marker) -or [IO.File]::ReadAllText($marker) -cne $Context.InvocationId) { throw "Owned resource marker drift" }
          $vm = if ($Owned.VmId) { Get-VM -Id ([Guid]$Owned.VmId) -ErrorAction SilentlyContinue } else { $null }
          if ($vm) {
            if ($vm.Name -cne $Owned.VmName) { throw "Owned VM identity drift" }
            if ($vm.State -ne [Microsoft.HyperV.PowerShell.VMState]::Off) { [void](Stop-VM -VM $vm -TurnOff -Force) }
            [void](Remove-VM -VM $vm -Force)
          }
          if ([IO.File]::Exists($Owned.DiskPath)) { Remove-Item -LiteralPath $Owned.DiskPath -Force }
          Remove-Item -LiteralPath $Owned.RootPath -Recurse -Force
        }
      }
      catch { [void]$teardownErrors.Add($_.Exception) }
      try {
        if ($Context.RunnerId -and (Find-PreliminaryRepositoryRunner $Context)) { [void](Invoke-PreliminaryGhJson "DELETE" "repos/$($Context.Repository)/actions/runners/$($Context.RunnerId)" $null) }
      }
      catch { [void]$teardownErrors.Add($_.Exception) }
      if ($teardownErrors.Count -eq 1) { throw $teardownErrors[0] }
      if ($teardownErrors.Count -gt 1) { throw [AggregateException]::new("Preliminary JIT teardown failures", [Exception[]]$teardownErrors.ToArray()) }
    }
    ObserveRunnerAbsent = {
      param($Context)
      if (-not $Context.RunnerId) { return $true }
      $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Min(120, $Context.TimeoutSeconds))
      while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Find-PreliminaryRepositoryRunner $Context)) { return $true }
        Start-Sleep -Seconds 2
      }
      return $false
    }
    ObserveOwnedResourcesAbsent = {
      param($Context, $Owned)
      $vmAbsent = -not $Owned.VmId -or -not (Get-VM -Id ([Guid]$Owned.VmId) -ErrorAction SilentlyContinue)
      return $vmAbsent -and -not [IO.File]::Exists($Owned.DiskPath) -and -not [IO.Directory]::Exists($Owned.RootPath) -and @($Owned.NetworkNames).Count -eq 0
    }
    ValidateDestruction = { param($Record, $Admission, $Bindings) Invoke-PreliminaryLifecycleAdapter "destruction" ([ordered]@{ record = $Record; admission = $Admission; bindings = $Bindings }) }
  }
}

if ([Environment]::GetEnvironmentVariable("BHARATCODE_PRELIMINARY_JIT_HOST_CONTROLLER_TEST", [EnvironmentVariableTarget]::Process) -ne "1") {
  $operations = New-PreliminaryWslJitLiveOperations
  Invoke-PreliminaryWslJitHostController -Mode $Mode -Repository $Repository -Workflow $Workflow -SourceSha $SourceSha -Ref $Ref `
    -BaseVhdxPath $BaseVhdxPath -BaseVhdxSha256 $BaseVhdxSha256 -RunnerArchivePath $RunnerArchivePath `
    -RunnerArchiveSha256 $RunnerArchiveSha256 -HostTemporaryRoot $HostTemporaryRoot -OutputDirectory $OutputDirectory `
    -VmSwitchName $VmSwitchName -GuestCredential $GuestCredential -RunnerGroupId $RunnerGroupId -VmProcessorCount $VmProcessorCount `
    -VmMemoryBytes $VmMemoryBytes -VmDiskBytes $VmDiskBytes -TimeoutSeconds $TimeoutSeconds -Operations $operations
}
