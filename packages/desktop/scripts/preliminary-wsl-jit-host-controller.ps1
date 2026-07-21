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
    "ValidateAdmission", "WriteEvidence", "WaitForWorkflow", "ValidateReceipt", "RequestWorkflowCancellation",
    "WaitForWorkflowTerminal", "TeardownOwnedVm", "TeardownOwnedRunner", "ObserveRunnerAbsent",
    "ObserveOwnedResourcesAbsent", "ValidateDestruction"
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
    DeadlineUtc = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    InvocationId = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(16)).ToLowerInvariant()
    JitEndpoint = "/repos/$Repository/actions/runners/generate-jitconfig"
    RunId = $null
    RunAttempt = $null
    RequiredLabels = $null
    RunnerId = $null
    RunnerName = $null
    WorkflowDispatched = $false
    WorkflowCompleted = $false
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
    VmCreationAttempted = $false
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
    $context.RunnerName = "bharatcode-jit-$($context.RunId)-$($context.RunAttempt)-$($context.InvocationId)"
    $context.WorkflowDispatched = $true

    $jit = & $Operations["GenerateRepositoryJitConfiguration"] $context
    if ($null -ne $jit -and $jit.PSObject.Properties.Name -contains "RunnerId" -and [string]$jit.RunnerId -match '^[1-9][0-9]*$') {
      $context.RunnerId = [string]$jit.RunnerId
    }
    if ($null -eq $jit -or $jit.PSObject.Properties.Name -notcontains "Endpoint" -or $jit.PSObject.Properties.Name -notcontains "RunnerName" -or
      $jit.PSObject.Properties.Name -notcontains "EncodedJitConfiguration" -or $jit.Endpoint -cne $context.JitEndpoint -or
      $context.RunnerId -notmatch '^[1-9][0-9]*$' -or [string]$jit.RunnerName -cne $context.RunnerName -or
      [string]::IsNullOrWhiteSpace([string]$jit.EncodedJitConfiguration)) {
      throw "Repository JIT configuration response is invalid"
    }
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
      expires_at = $context.DeadlineUtc.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
    }
    $admissionCanonical = [string](& $Operations["ValidateAdmission"] $admission $bindings $context)
    [void](& $Operations["WriteEvidence"] $context "admission" $admissionCanonical)
    $admissionWritten = $true

    $workflowResult = & $Operations["WaitForWorkflow"] $context $owned
    Assert-PreliminaryWorkflowResult $workflowResult $context
    $context.WorkflowCompleted = $true
    if ($workflowResult.Conclusion -cne "success") { throw "Exact preliminary workflow did not succeed" }
    [void](& $Operations["ValidateReceipt"] $workflowResult.Receipt $context)
    $receiptValidated = $true
  }
  catch { $primary = $_.Exception }
  finally {
    $jit = $null
    $jitConfiguration = $null
    $cancellationRequired = $context.WorkflowDispatched -and -not $context.WorkflowCompleted
    if ($cancellationRequired) {
      try {
        [void](& $Operations["RequestWorkflowCancellation"] $context)
      }
      catch { [void]$cleanupErrors.Add($_.Exception) }
    }
    try { [void](& $Operations["TeardownOwnedVm"] $context $owned) }
    catch { [void]$cleanupErrors.Add($_.Exception) }
    try { [void](& $Operations["TeardownOwnedRunner"] $context) }
    catch { [void]$cleanupErrors.Add($_.Exception) }
    if ($cancellationRequired) {
      try {
        $terminal = & $Operations["WaitForWorkflowTerminal"] $context
        Assert-PreliminaryWorkflowResult $terminal $context
        $context.WorkflowCompleted = $true
      }
      catch { [void]$cleanupErrors.Add($_.Exception) }
    }

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
        $destructionCanonical = [string](& $Operations["ValidateDestruction"] $destruction $admission $destructionBindings $context)
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
  if (-not $Owned.Owned -or -not $Owned.AuthorityEstablished -or -not $Owned.VmCreationAttempted -or $Owned.RootPath -cne $expectedRoot -or $Owned.VmName -cne "bharatcode-preliminary-jit-$($Context.InvocationId)" -or [string]::IsNullOrWhiteSpace($Owned.VmId)) { throw "Owned VM identity is invalid" }
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

function Get-PreliminaryRemainingTimeoutMilliseconds {
  param([object] $Context, [DateTime] $NowUtc = [DateTime]::UtcNow)
  $remaining = ($Context.DeadlineUtc - $NowUtc).TotalMilliseconds
  if ($remaining -le 0) { throw [TimeoutException]::new("Preliminary JIT absolute deadline expired") }
  return [int][Math]::Min([int]::MaxValue, [Math]::Floor($remaining))
}

function Invoke-PreliminaryProcess {
  param([object] $Context, [string] $FilePath, [string[]] $ArgumentList, [string] $InputText, [int] $MaximumTimeoutMilliseconds = 300000)
  $timeoutMilliseconds = [Math]::Min($MaximumTimeoutMilliseconds, (Get-PreliminaryRemainingTimeoutMilliseconds $Context))
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
  $errorOutput = $stderr.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) { throw "Prepared command failed with exit code $($process.ExitCode) and stderr SHA-256 $(Get-PreliminarySha256 $errorOutput)" }
  return $output
}

function Invoke-PreliminaryGhJson {
  param([object] $Context, [string] $Method, [string] $Endpoint, [object] $Body)
  $arguments = @("api", "--method", $Method, $Endpoint, "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10")
  $input = $null
  if ($null -ne $Body) { $arguments += @("--input", "-"); $input = $Body | ConvertTo-Json -Depth 20 -Compress }
  try { $raw = Invoke-PreliminaryProcess $Context (Get-Command gh -CommandType Application).Source $arguments $input }
  catch { throw [InvalidOperationException]::new("GitHub API $Method $Endpoint failed", $_.Exception) }
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return $raw | ConvertFrom-Json -Depth 30
}

function Find-PreliminaryRepositoryRunner {
  param([object] $Context, [scriptblock] $ListPage)
  if ([string]::IsNullOrWhiteSpace([string]$Context.RunnerName)) { return $null }
  $matches = [Collections.Generic.List[object]]::new()
  $complete = $false
  for ($page = 1; $page -le 100; $page++) {
    $response = if ($ListPage) {
      & $ListPage $Context $page
    } else {
      Invoke-PreliminaryGhJson $Context "GET" "repos/$($Context.Repository)/actions/runners?per_page=100&page=$page" $null
    }
    if ($null -eq $response -or $response.PSObject.Properties.Name -notcontains "runners") { throw "Repository runner enumeration response is invalid" }
    $runners = @($response.runners)
    foreach ($runner in $runners) {
      if ($Context.RunnerId) {
        if ([string]$runner.id -ceq $Context.RunnerId) { [void]$matches.Add($runner) }
        continue
      }
      if ([string]$runner.name -ceq $Context.RunnerName) { [void]$matches.Add($runner) }
    }
    if ($runners.Count -lt 100) {
      $complete = $true
      break
    }
  }
  if (-not $complete) { throw "Repository runner enumeration exceeded its bound" }
  if ($matches.Count -gt 1) { throw "Repository runner cleanup identity is not unique" }
  if ($matches.Count -eq 0) { return $null }
  if ([string]$matches[0].name -cne $Context.RunnerName) { throw "Repository runner name identity drift" }
  $labels = @($matches[0].labels | ForEach-Object { [string]$_.name })
  if (-not (Test-PreliminaryLabelSet $labels @($Context.RequiredLabels))) { throw "Repository runner label identity drift" }
  return $matches[0]
}

function Resolve-PreliminaryOwnedVm {
  param(
    [object] $Owned,
    [scriptblock] $GetById,
    [scriptblock] $GetByName,
    [scriptblock] $GetDiskPaths
  )
  if (-not $Owned.VmCreationAttempted) { return $null }
  $vms = @(if ($Owned.VmId) {
    if ($GetById) { @(& $GetById $Owned) } else { @(Get-VM -Id ([Guid]$Owned.VmId) -ErrorAction SilentlyContinue) }
  } else {
    if ($GetByName) { @(& $GetByName $Owned) } else { @(Get-VM -Name $Owned.VmName -ErrorAction SilentlyContinue) }
  })
  if ($vms.Count -gt 1) { throw "Owned VM cleanup identity is not unique" }
  if ($vms.Count -eq 0) {
    if ($Owned.VmId) { return $null }
    throw "Owned VM cleanup identity is missing"
  }
  if ([string]$vms[0].Name -cne $Owned.VmName) { throw "Owned VM cleanup identity drift" }
  $diskPaths = @(if ($GetDiskPaths) {
    @(& $GetDiskPaths $vms[0])
  } else {
    @(Get-VMHardDiskDrive -VM $vms[0] | ForEach-Object { [string]$_.Path })
  })
  if ($diskPaths.Count -ne 1 -or [IO.Path]::GetFullPath([string]$diskPaths[0]) -cne [IO.Path]::GetFullPath([string]$Owned.DiskPath)) {
    throw "Owned VM attached disk identity drift"
  }
  return $vms[0]
}

function Invoke-PreliminaryLifecycleAdapter {
  param([object] $Context, [ValidateSet("admission", "destruction", "receipt")] [string] $Operation, [object] $Payload)
  $bun = (Get-Command bun -CommandType Application).Source
  $adapter = Join-Path $PSScriptRoot "../../opencode/script/preliminary-jit-evidence-cli.mjs"
  try { return Invoke-PreliminaryProcess $Context $bun @($adapter, $Operation) ($Payload | ConvertTo-Json -Depth 30 -Compress) }
  catch { throw [InvalidOperationException]::new("Preliminary lifecycle adapter $Operation failed", $_.Exception) }
}

function New-PreliminaryWslJitLiveOperations {
  return @{
    IsElevated = {
      $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
      return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    GetLocalSourceSha = { param($Context) (Invoke-PreliminaryProcess $Context (Get-Command git -CommandType Application).Source @("rev-parse", "HEAD") $null).Trim() }
    AssertPrerequisites = {
      param($Context)
      if ($ExecutionContext.SessionState.LanguageMode -ne [Management.Automation.PSLanguageMode]::FullLanguage) { throw "PowerShell FullLanguage is required" }
      foreach ($command in @("gh", "git", "bun", "Get-VM", "Get-VHD", "New-VHD", "New-VM", "Set-VM", "Set-VMProcessor", "Start-VM", "Stop-VM", "Remove-VM", "Get-VMHardDiskDrive", "Get-VMSwitch")) { if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Missing prepared prerequisite: $command" } }
      if (-not ($Context.GuestCredential -is [pscredential])) { throw "PowerShell Direct guest credential is required" }
      if (-not (Get-VMSwitch -Name $Context.VmSwitchName -ErrorAction SilentlyContinue)) { throw "Prepared Hyper-V switch is unavailable" }
      if ((Invoke-PreliminaryProcess $Context (Get-Command git -CommandType Application).Source @("status", "--porcelain") $null).Length -ne 0) { throw "Live controller checkout must be clean" }
      $origin = (Invoke-PreliminaryProcess $Context (Get-Command git -CommandType Application).Source @("remote", "get-url", "origin") $null).Trim()
      if ($origin -notmatch 'BharatCode-ai[/:]bharatcode-desktop(?:\.git)?$') { throw "Live controller origin is invalid" }
      $vhd = Get-VHD -Path $Context.BaseVhdxPath
      if ($vhd.VhdType -notin @("Fixed", "Dynamic") -or $vhd.Size -gt $Context.VmDiskBytes) { throw "Prepared base VHDX exceeds the approved disk bound" }
      if ([IO.Path]::GetExtension($Context.RunnerArchivePath) -cne ".zip") { throw "Prepared runner archive is invalid" }
    }
    DispatchWorkflow = {
      param($Context)
      $workflowName = [Uri]::EscapeDataString([IO.Path]::GetFileName($Context.Workflow))
      $response = Invoke-PreliminaryGhJson $Context "POST" "repos/$($Context.Repository)/actions/workflows/$workflowName/dispatches" ([ordered]@{ ref = $Context.Ref; inputs = [ordered]@{ source_sha = $Context.SourceSha } })
      if ([string]$response.workflow_run_id -notmatch '^[1-9][0-9]*$') { throw "Workflow dispatch did not return an immutable run ID" }
      $Context.RunId = [string]$response.workflow_run_id
      $Context.WorkflowDispatched = $true
      $run = Invoke-PreliminaryGhJson $Context "GET" "repos/$($Context.Repository)/actions/runs/$($response.workflow_run_id)" $null
      return [pscustomobject]@{ Repository = $Context.Repository; Workflow = [string]$run.path; SourceSha = [string]$run.head_sha; RunId = [string]$run.id; RunAttempt = [string]$run.run_attempt }
    }
    GenerateRepositoryJitConfiguration = {
      param($Context)
      $response = Invoke-PreliminaryGhJson $Context "POST" $Context.JitEndpoint ([ordered]@{ name = $Context.RunnerName; runner_group_id = $Context.RunnerGroupId; labels = @($Context.RequiredLabels); work_folder = "_work" })
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
      $Owned.VmCreationAttempted = $true
      $vm = New-VM -Name $Owned.VmName -Generation 2 -MemoryStartupBytes $Context.VmMemoryBytes -VHDPath $Owned.DiskPath -SwitchName $Context.VmSwitchName
      $Owned.VmId = [string]$vm.Id
      [void](Set-VMProcessor -VM $vm -Count $Context.VmProcessorCount -ExposeVirtualizationExtensions $true)
      [void](Set-VM -VM $vm -AutomaticCheckpointsEnabled $false)
      return $Owned
    }
    TransferAndStartRunner = {
      param($Context, $Owned, $Secret)
      $vm = Resolve-PreliminaryOwnedVm $Owned
      if (-not $vm) { throw "Owned VM is unavailable before start" }
      [void](Start-VM -VM $vm)
      $sessionDeadline = [DateTime]::UtcNow.AddSeconds(300)
      $deadline = if ($sessionDeadline -lt $Context.DeadlineUtc) { $sessionDeadline } else { $Context.DeadlineUtc }
      $session = $null
      while (-not $session -and [DateTime]::UtcNow -lt $deadline) {
        try { $session = New-PSSession -VMName $Owned.VmName -Credential $Context.GuestCredential -ErrorAction Stop }
        catch { Start-Sleep -Milliseconds ([Math]::Min(2000, (Get-PreliminaryRemainingTimeoutMilliseconds $Context))) }
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
      $deadline = $Context.DeadlineUtc
      while ([DateTime]::UtcNow -lt $deadline) {
        $runner = Invoke-PreliminaryGhJson $Context "GET" "repos/$($Context.Repository)/actions/runners/$($Context.RunnerId)" $null
        $labels = @($runner.labels | ForEach-Object { [string]$_.name })
        if ([string]$runner.id -ceq $Context.RunnerId -and [string]$runner.name -ceq $Context.RunnerName -and [string]$runner.status -ceq "online" -and (Test-PreliminaryLabelSet $labels @($Context.RequiredLabels))) {
          $now = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
          return [pscustomobject]@{ RunnerId = $Context.RunnerId; RunnerName = $Context.RunnerName; Status = "online"; Busy = [bool]$runner.busy; Labels = @($Context.RequiredLabels); RegisteredAt = $now; ObservedAt = $now }
        }
        Start-Sleep -Milliseconds ([Math]::Min(2000, (Get-PreliminaryRemainingTimeoutMilliseconds $Context)))
      }
      throw "Independent repository runner observation timed out"
    }
    ValidateAdmission = { param($Record, $Bindings, $Context) Invoke-PreliminaryLifecycleAdapter $Context "admission" ([ordered]@{ record = $Record; bindings = $Bindings }) }
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
      $deadline = $Context.DeadlineUtc
      while ([DateTime]::UtcNow -lt $deadline) {
        $run = Invoke-PreliminaryGhJson $Context "GET" "repos/$($Context.Repository)/actions/runs/$($Context.RunId)" $null
        if ([string]$run.id -cne $Context.RunId -or [string]$run.run_attempt -cne $Context.RunAttempt -or [string]$run.head_sha -cne $Context.SourceSha -or [string]$run.path -cne $Context.Workflow) { throw "Exact workflow run identity drift" }
        if ([string]$run.status -ceq "completed") {
          $Context.WorkflowCompleted = $true
          $receipt = $null
          if ([string]$run.conclusion -ceq "success") {
            $artifactName = "preliminary-wsl-evidence-$($Context.RunId)-$($Context.RunAttempt)"
            $artifactRoot = Join-Path $Owned.RootPath "workflow-evidence"
            [void][IO.Directory]::CreateDirectory($artifactRoot)
            [void](Invoke-PreliminaryProcess $Context (Get-Command gh -CommandType Application).Source @("run", "download", $Context.RunId, "--repo", $Context.Repository, "--name", $artifactName, "--dir", $artifactRoot) $null)
            $receiptPath = Join-Path $artifactRoot "bharatcode-wsl-preliminary-unsigned.json"
            if (-not [IO.File]::Exists($receiptPath)) { throw "Exact preliminary WSL receipt is absent" }
            $receipt = [IO.File]::ReadAllText($receiptPath)
          }
          return [pscustomobject]@{ Repository = $Context.Repository; Workflow = [string]$run.path; SourceSha = [string]$run.head_sha; RunId = [string]$run.id; RunAttempt = [string]$run.run_attempt; Conclusion = [string]$run.conclusion; Receipt = $receipt }
        }
        Start-Sleep -Milliseconds ([Math]::Min(2000, (Get-PreliminaryRemainingTimeoutMilliseconds $Context)))
      }
      throw [TimeoutException]::new("Exact preliminary workflow timed out")
    }
    ValidateReceipt = {
      param($Receipt, $Context)
      [void](Invoke-PreliminaryLifecycleAdapter $Context "receipt" ([ordered]@{
            raw = [string]$Receipt
            identity = [ordered]@{ source_sha = $Context.SourceSha; run_id = $Context.RunId; run_attempt = $Context.RunAttempt }
          }))
    }
    RequestWorkflowCancellation = {
      param($Context)
      if (-not $Context.WorkflowDispatched -or [string]::IsNullOrWhiteSpace([string]$Context.RunId)) { throw "Exact workflow cancellation identity is unavailable" }
      [void](Invoke-PreliminaryGhJson $Context "POST" "repos/$($Context.Repository)/actions/runs/$($Context.RunId)/cancel" $null)
    }
    WaitForWorkflowTerminal = {
      param($Context)
      $deadline = $Context.DeadlineUtc
      while ([DateTime]::UtcNow -lt $deadline) {
        $run = Invoke-PreliminaryGhJson $Context "GET" "repos/$($Context.Repository)/actions/runs/$($Context.RunId)" $null
        if ([string]$run.id -cne $Context.RunId -or [string]$run.head_sha -cne $Context.SourceSha -or [string]$run.path -cne $Context.Workflow) { throw "Cancelled workflow run identity drift" }
        if ($Context.RunAttempt) {
          if ([string]$run.run_attempt -cne $Context.RunAttempt) { throw "Cancelled workflow run attempt drift" }
        } else {
          if ([string]$run.run_attempt -cnotmatch '^[1-9][0-9]*$') { throw "Cancelled workflow run attempt is invalid" }
          $Context.RunAttempt = [string]$run.run_attempt
        }
        if ([string]$run.status -ceq "completed") {
          return [pscustomobject]@{ Repository = $Context.Repository; Workflow = [string]$run.path; SourceSha = [string]$run.head_sha; RunId = [string]$run.id; RunAttempt = [string]$run.run_attempt; Conclusion = [string]$run.conclusion; Receipt = $null }
        }
        Start-Sleep -Milliseconds ([Math]::Min(2000, (Get-PreliminaryRemainingTimeoutMilliseconds $Context)))
      }
      throw [TimeoutException]::new("Cancelled preliminary workflow did not reach a terminal state")
    }
    TeardownOwnedVm = {
      param($Context, $Owned)
      if ($Owned.AuthorityEstablished) {
        $marker = Join-Path $Owned.RootPath "controller-owned.txt"
        if (-not [IO.File]::Exists($marker) -or [IO.File]::ReadAllText($marker) -cne $Context.InvocationId) { throw "Owned resource marker drift" }
        $vm = Resolve-PreliminaryOwnedVm $Owned
        if ($vm) {
          if ($vm.State -ne [Microsoft.HyperV.PowerShell.VMState]::Off) { [void](Stop-VM -VM $vm -TurnOff -Force) }
          [void](Remove-VM -VM $vm -Force)
        }
        if ([IO.File]::Exists($Owned.DiskPath)) { Remove-Item -LiteralPath $Owned.DiskPath -Force }
        Remove-Item -LiteralPath $Owned.RootPath -Recurse -Force
      }
    }
    TeardownOwnedRunner = {
      param($Context)
      $runner = Find-PreliminaryRepositoryRunner $Context
      if ($runner) { [void](Invoke-PreliminaryGhJson $Context "DELETE" "repos/$($Context.Repository)/actions/runners/$([string]$runner.id)" $null) }
    }
    ObserveRunnerAbsent = {
      param($Context)
      if ([string]::IsNullOrWhiteSpace([string]$Context.RunnerName)) { return $true }
      $absenceDeadline = [DateTime]::UtcNow.AddSeconds(120)
      $deadline = if ($absenceDeadline -lt $Context.DeadlineUtc) { $absenceDeadline } else { $Context.DeadlineUtc }
      while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Find-PreliminaryRepositoryRunner $Context)) { return $true }
        Start-Sleep -Milliseconds ([Math]::Min(2000, (Get-PreliminaryRemainingTimeoutMilliseconds $Context)))
      }
      return $false
    }
    ObserveOwnedResourcesAbsent = {
      param($Context, $Owned)
      $vms = @(if ($Owned.VmId) {
        @(Get-VM -Id ([Guid]$Owned.VmId) -ErrorAction SilentlyContinue)
      } elseif ($Owned.VmCreationAttempted) {
        @(Get-VM -Name $Owned.VmName -ErrorAction SilentlyContinue)
      } else {
        @()
      })
      $vmAbsent = $vms.Count -eq 0
      return $vmAbsent -and -not [IO.File]::Exists($Owned.DiskPath) -and -not [IO.Directory]::Exists($Owned.RootPath) -and @($Owned.NetworkNames).Count -eq 0
    }
    ValidateDestruction = { param($Record, $Admission, $Bindings, $Context) Invoke-PreliminaryLifecycleAdapter $Context "destruction" ([ordered]@{ record = $Record; admission = $Admission; bindings = $Bindings }) }
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
