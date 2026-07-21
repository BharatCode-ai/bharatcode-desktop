$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-True {
  param([bool] $Condition, [string] $Message)
  if (-not $Condition) { throw $Message }
}

function Assert-Throws {
  param([scriptblock] $Action, [string] $Message)
  try { & $Action }
  catch { return $_.Exception }
  throw $Message
}

function New-TestState {
  [pscustomobject]@{
    Calls = [Collections.Generic.List[string]]::new()
    Evidence = [Collections.Generic.List[string]]::new()
    EncodedJitConfiguration = "encoded-jit-secret-never-log"
    Elevated = $true
    WorkflowMode = "success"
    RunnerAbsent = $true
    ResourcesAbsent = $true
    OwnedVmPresent = $true
    OwnedDiskPresent = $true
    ForeignRunnerPresent = $true
    ForeignVmPresent = $true
    ForeignDiskPresent = $true
    ForeignNetworkPresent = $true
    Labels = $null
    ObservedLabels = $null
    Endpoint = $null
  }
}

function New-TestOperation {
  param([object] $State, [string] $Name, [scriptblock] $Body)
  $capturedState = $State
  $capturedName = $Name
  $capturedBody = $Body
  return {
    param($First, $Second, $Third)
    [void]$capturedState.Calls.Add($capturedName)
    & $capturedBody $capturedState $First $Second $Third
  }.GetNewClosure()
}

function New-TestOperations {
  param([object] $State)
  return @{
    IsElevated = New-TestOperation $State "is-elevated" { param($State) $State.Elevated }
    GetLocalSourceSha = New-TestOperation $State "local-source" { param($State, $Context) $Context.SourceSha }
    AssertPrerequisites = New-TestOperation $State "prerequisites" { }
    DispatchWorkflow = New-TestOperation $State "dispatch" {
      param($State, $Context)
      [pscustomobject]@{
        Repository = $Context.Repository
        Workflow = $Context.Workflow
        SourceSha = $Context.SourceSha
        RunId = "29730000001"
        RunAttempt = "2"
      }
    }
    GenerateRepositoryJitConfiguration = New-TestOperation $State "jit-config" {
      param($State, $Context)
      $State.Endpoint = $Context.JitEndpoint
      $State.Labels = @($Context.RequiredLabels)
      [pscustomobject]@{
        Endpoint = $Context.JitEndpoint
        RunnerId = "9812345"
        RunnerName = "bharatcode-jit-$($Context.RunId)-$($Context.RunAttempt)-$($Context.InvocationId)"
        EncodedJitConfiguration = $State.EncodedJitConfiguration
      }
    }
    CreateOwnedVm = New-TestOperation $State "create-vm" {
      param($State, $Context)
      [pscustomobject]@{
        Owned = $true
        AuthorityEstablished = $true
        RootPath = [IO.Path]::Combine($Context.HostTemporaryRoot, "bharatcode-preliminary-jit-$($Context.InvocationId)")
        VmName = "bharatcode-preliminary-jit-$($Context.InvocationId)"
        VmId = "vm-$($Context.InvocationId)"
        DiskPath = [IO.Path]::Combine($Context.HostTemporaryRoot, "bharatcode-preliminary-jit-$($Context.InvocationId)", "guest.vhdx")
        NetworkNames = @()
      }
    }
    TransferAndStartRunner = New-TestOperation $State "start-runner" {
      param($State, $Context, $Owned, $Secret)
      Assert-True ($Secret -ceq $State.EncodedJitConfiguration) "JIT secret was substituted before guest transfer"
    }
    ObserveRunner = New-TestOperation $State "observe-runner" {
      param($State, $Context)
      [pscustomobject]@{
        RunnerId = $Context.RunnerId
        RunnerName = $Context.RunnerName
        Status = "online"
        Busy = $false
        Labels = if ($State.ObservedLabels) { @($State.ObservedLabels) } else { @($Context.RequiredLabels) }
        RegisteredAt = "2026-07-20T10:00:00.000Z"
        ObservedAt = "2026-07-20T10:00:02.000Z"
      }
    }
    ValidateAdmission = New-TestOperation $State "validate-admission" {
      param($State, $Record, $Bindings)
      Assert-True ($State.Calls.IndexOf("observe-runner") -lt $State.Calls.IndexOf("validate-admission")) "admission preceded independent runner observation"
      Assert-True ($Record.runner.labels.Count -eq 5) "admission labels are not closed"
      return ($Record | ConvertTo-Json -Depth 20 -Compress) + "`n"
    }
    WriteEvidence = New-TestOperation $State "write-evidence" {
      param($State, $Context, $Kind, $Canonical)
      Assert-True (-not $Canonical.Contains($State.EncodedJitConfiguration)) "JIT secret entered lifecycle evidence"
      [void]$State.Evidence.Add([string]$Kind)
    }
    WaitForWorkflow = New-TestOperation $State "wait-workflow" {
      param($State, $Context)
      if ($State.WorkflowMode -eq "timeout") { throw [TimeoutException]::new("simulated exact-run timeout") }
      [pscustomobject]@{
        Repository = $Context.Repository
        Workflow = $Context.Workflow
        SourceSha = $Context.SourceSha
        RunId = $Context.RunId
        RunAttempt = $Context.RunAttempt
        Conclusion = $State.WorkflowMode
        Receipt = [pscustomobject]@{ schema = "bharatcode-wsl-preliminary-unsigned-v1" }
      }
    }
    ValidateReceipt = New-TestOperation $State "validate-receipt" { }
    TeardownOwnedResources = New-TestOperation $State "teardown" {
      param($State, $Context, $Owned)
      Assert-True ($Owned.Owned -and $Owned.VmName -ceq "bharatcode-preliminary-jit-$($Context.InvocationId)") "teardown escaped owned VM identity"
      $State.OwnedVmPresent = $false
      $State.OwnedDiskPresent = $false
    }
    ObserveRunnerAbsent = New-TestOperation $State "runner-absent" { param($State) $State.RunnerAbsent }
    ObserveOwnedResourcesAbsent = New-TestOperation $State "resources-absent" {
      param($State)
      Assert-True (-not $State.OwnedVmPresent -and -not $State.OwnedDiskPresent) "owned resource observation preceded teardown"
      $State.ResourcesAbsent
    }
    ValidateDestruction = New-TestOperation $State "validate-destruction" {
      param($State, $Record, $Admission, $Bindings)
      Assert-True ($State.Calls.IndexOf("runner-absent") -lt $State.Calls.IndexOf("validate-destruction")) "destruction preceded runner absence"
      Assert-True ($State.Calls.IndexOf("resources-absent") -lt $State.Calls.IndexOf("validate-destruction")) "destruction preceded VM/disk/network absence"
      return ($Record | ConvertTo-Json -Depth 20 -Compress) + "`n"
    }
  }
}

$controllerPath = Join-Path $PSScriptRoot "preliminary-wsl-jit-host-controller.ps1"
Assert-True ([IO.File]::Exists($controllerPath)) "missing preliminary WSL JIT host controller"
$previousTestMode = [Environment]::GetEnvironmentVariable("BHARATCODE_PRELIMINARY_JIT_HOST_CONTROLLER_TEST", [EnvironmentVariableTarget]::Process)
[Environment]::SetEnvironmentVariable("BHARATCODE_PRELIMINARY_JIT_HOST_CONTROLLER_TEST", "1", [EnvironmentVariableTarget]::Process)
. $controllerPath

$sourceSha = "7" * 40
$basePath = Join-Path $PSScriptRoot "../../../.github/workflows/bharatcode-preliminary-unsigned-wsl.yml"
$runnerPath = Join-Path $PSScriptRoot "../../opencode/script/lean-preliminary-jit-lifecycle.mjs"
$baseSha256 = (Get-FileHash -LiteralPath $basePath -Algorithm SHA256).Hash.ToLowerInvariant()
$runnerSha256 = (Get-FileHash -LiteralPath $runnerPath -Algorithm SHA256).Hash.ToLowerInvariant()

function New-TestInput {
  param([hashtable] $Operations, [string] $Mode = "Live")
  return @{
    Mode = $Mode
    Repository = "BharatCode-ai/bharatcode-desktop"
    Workflow = ".github/workflows/bharatcode-preliminary-unsigned-wsl.yml"
    SourceSha = $sourceSha
    Ref = "dev"
    BaseVhdxPath = $basePath
    BaseVhdxSha256 = $baseSha256
    RunnerArchivePath = $runnerPath
    RunnerArchiveSha256 = $runnerSha256
    HostTemporaryRoot = $PSScriptRoot
    OutputDirectory = $PSScriptRoot
    VmSwitchName = "approved-existing-switch"
    GuestCredential = [pscustomobject]@{ TestOnly = $true }
    RunnerGroupId = 1
    VmProcessorCount = 2
    VmMemoryBytes = 4GB
    VmDiskBytes = 64GB
    TimeoutSeconds = 1800
    Operations = $Operations
  }
}

try {
  $noLiveOperations = @{}
  foreach ($name in @(
      "IsElevated", "GetLocalSourceSha", "AssertPrerequisites", "DispatchWorkflow",
      "GenerateRepositoryJitConfiguration", "CreateOwnedVm", "TransferAndStartRunner", "ObserveRunner",
      "ValidateAdmission", "WriteEvidence", "WaitForWorkflow", "ValidateReceipt", "TeardownOwnedResources",
      "ObserveRunnerAbsent", "ObserveOwnedResourcesAbsent", "ValidateDestruction"
    )) {
    $noLiveOperations[$name] = { throw "validation mode invoked a live boundary" }
  }
  $validateInput = New-TestInput $noLiveOperations "Validate"
  $validated = Invoke-PreliminaryWslJitHostController @validateInput
  Assert-True ($validated.Status -ceq "VALIDATED") "validation mode did not close without live action"

  foreach ($hostile in @(
      @{ Repository = "foreign/example" },
      @{ Workflow = ".github/workflows/foreign.yml" },
      @{ SourceSha = "A" * 40 }
    )) {
    $state = New-TestState
    $caseInput = New-TestInput (New-TestOperations $state)
    foreach ($entry in $hostile.GetEnumerator()) { $caseInput[$entry.Key] = $entry.Value }
    [void](Assert-Throws { Invoke-PreliminaryWslJitHostController @caseInput } "hostile identity was accepted")
    Assert-True ($state.Calls.Count -eq 0) "hostile identity reached an injected effect"
  }

  $nonElevated = New-TestState
  $nonElevated.Elevated = $false
  $nonElevatedInput = New-TestInput (New-TestOperations $nonElevated)
  $nonElevatedError = Assert-Throws { Invoke-PreliminaryWslJitHostController @nonElevatedInput } "non-elevated live mode was accepted"
  Assert-True (($nonElevated.Calls -join ",") -ceq "is-elevated") "non-elevated mode reached a live effect: $($nonElevated.Calls -join ','); error=$($nonElevatedError.Message)"

  $success = New-TestState
  $successInput = New-TestInput (New-TestOperations $success)
  $successResult = @(Invoke-PreliminaryWslJitHostController @successInput 6>&1)
  $pass = $successResult | Where-Object { $_ -is [psobject] -and $_.PSObject.Properties.Name -contains "Status" } | Select-Object -Last 1
  Assert-True ($pass.Status -ceq "PASS") "successful closed lifecycle did not return PASS"
  Assert-True (($success.Labels -join ",") -ceq "self-hosted,windows,x64,wsl2,bharatcode-acceptance-29730000001-2") "run-attempt labels drifted"
  Assert-True ($success.Endpoint -ceq "/repos/BharatCode-ai/bharatcode-desktop/actions/runners/generate-jitconfig") "repository JIT endpoint drifted"
  Assert-True (-not (($successResult | Out-String).Contains($success.EncodedJitConfiguration))) "JIT configuration reached output"
  Assert-True (($success.Evidence -join ",") -ceq "admission,destruction") "closed lifecycle evidence order drifted"
  Assert-True ($success.Calls.FindAll({ param($Name) $Name -ceq "dispatch" }).Count -eq 1) "controller did not dispatch exactly once"
  Assert-True ($success.Calls.FindAll({ param($Name) $Name -ceq "start-runner" }).Count -eq 1) "controller did not start exactly one runner"
  Assert-True ($success.ForeignRunnerPresent -and $success.ForeignVmPresent -and $success.ForeignDiskPresent -and $success.ForeignNetworkPresent) "foreign resources were mutated"

  $unorderedLabels = New-TestState
  $unorderedLabels.ObservedLabels = @("wsl2", "self-hosted", "x64", "windows", "bharatcode-acceptance-29730000001-2")
  $unorderedInput = New-TestInput (New-TestOperations $unorderedLabels)
  $unorderedResult = Invoke-PreliminaryWslJitHostController @unorderedInput
  Assert-True ($unorderedResult.Status -ceq "PASS") "unordered GitHub label observation was not canonically admitted"

  foreach ($workflowMode in @("failure", "timeout")) {
    $state = New-TestState
    $state.WorkflowMode = $workflowMode
    $caseInput = New-TestInput (New-TestOperations $state)
    $workflowError = Assert-Throws { Invoke-PreliminaryWslJitHostController @caseInput } "$workflowMode incorrectly returned PASS"
    Assert-True ($state.Calls.Contains("teardown")) "$workflowMode skipped teardown: $($state.Calls -join ','); error=$($workflowError.Message)"
    Assert-True ($state.Calls.Contains("runner-absent") -and $state.Calls.Contains("resources-absent")) "$workflowMode skipped absence proof"
    Assert-True ($state.Evidence.Contains("destruction")) "$workflowMode omitted validated destruction evidence"
  }

  $deregistrationFailure = New-TestState
  $deregistrationFailure.RunnerAbsent = $false
  $deregistrationInput = New-TestInput (New-TestOperations $deregistrationFailure)
  [void](Assert-Throws { Invoke-PreliminaryWslJitHostController @deregistrationInput } "runner deregistration failure returned PASS")
  Assert-True (-not $deregistrationFailure.Evidence.Contains("destruction")) "destruction was emitted without runner absence"

  $vmFailure = New-TestState
  $vmFailure.ResourcesAbsent = $false
  $vmInput = New-TestInput (New-TestOperations $vmFailure)
  [void](Assert-Throws { Invoke-PreliminaryWslJitHostController @vmInput } "VM destruction failure returned PASS")
  Assert-True (-not $vmFailure.Evidence.Contains("destruction")) "destruction was emitted without VM/disk/network absence"

  $source = [IO.File]::ReadAllText($controllerPath)
  Assert-True (-not $source.Contains("/orgs/")) "organization runner authority was introduced"
  Assert-True (-not $source.Contains("registration-token")) "persistent registration fallback was introduced"
  Assert-True (-not $source.Contains("-ExecutionPolicy")) "execution policy override was introduced"
  Assert-True ($source.Contains("function Find-PreliminaryRepositoryRunner") -and $source.Contains('per_page=100&page=$page')) "runner absence is limited to one API page"
  $createVmSource = $source.Substring($source.IndexOf('    CreateOwnedVm = {'), $source.IndexOf('    TransferAndStartRunner = {') - $source.IndexOf('    CreateOwnedVm = {'))
  Assert-True ($createVmSource.IndexOf('$Owned.VmId =') -lt $createVmSource.IndexOf('Set-VMProcessor')) "partial VM creation can lose teardown identity"
  $teardownSource = $source.Substring($source.IndexOf('    TeardownOwnedResources = {'), $source.IndexOf('    ObserveRunnerAbsent = {') - $source.IndexOf('    TeardownOwnedResources = {'))
  Assert-True ($teardownSource.IndexOf('Remove-VM') -lt $teardownSource.IndexOf('actions/runners/$($Context.RunnerId)')) "runner deletion precedes owned VM destruction"
  Assert-True ($teardownSource.Contains('$teardownErrors') -and $teardownSource.Contains('Preliminary JIT teardown failures')) "VM failure can suppress exact runner teardown"
  Write-Output "preliminary_wsl_jit_host_controller_tests=passed"
}
finally {
  [Environment]::SetEnvironmentVariable("BHARATCODE_PRELIMINARY_JIT_HOST_CONTROLLER_TEST", $previousTestMode, [EnvironmentVariableTarget]::Process)
}
