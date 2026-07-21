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

function Invoke-CorrectionCase {
  param([string] $Name, [scriptblock] $Action, [Collections.Generic.List[string]] $Failures)
  try { & $Action }
  catch {
    $message = "$Name`: $($_.Exception.Message)"
    [void]$Failures.Add($message)
    Write-Output "correction_red=$message"
  }
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
    OwnedRunnerPresent = $false
    OwnedVmPresent = $true
    OwnedDiskPresent = $true
    ForeignRunnerPresent = $true
    ForeignVmPresent = $true
    ForeignDiskPresent = $true
    ForeignNetworkPresent = $true
    Labels = $null
    ObservedLabels = $null
    Endpoint = $null
    CancellationFailure = $false
    TerminalFailure = $false
    VmTeardownFailure = $false
    RunnerTeardownFailure = $false
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
      $State.OwnedRunnerPresent = $true
      [pscustomobject]@{
        Endpoint = $Context.JitEndpoint
        RunnerId = "9812345"
        RunnerName = $Context.RunnerName
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
        VmCreationAttempted = $true
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
    RequestWorkflowCancellation = New-TestOperation $State "cancel-workflow" {
      param($State)
      if ($State.CancellationFailure) { throw "simulated cancellation failure" }
    }
    WaitForWorkflowTerminal = New-TestOperation $State "wait-terminal" {
      param($State, $Context)
      if ($State.TerminalFailure) { throw "simulated terminal-state failure" }
      if (-not $Context.RunAttempt) { $Context.RunAttempt = "2" }
      [pscustomobject]@{
        Repository = $Context.Repository
        Workflow = $Context.Workflow
        SourceSha = $Context.SourceSha
        RunId = $Context.RunId
        RunAttempt = $Context.RunAttempt
        Conclusion = "cancelled"
        Receipt = $null
      }
    }
    TeardownOwnedVm = New-TestOperation $State "teardown-vm" {
      param($State, $Context, $Owned)
      Assert-True ($Owned.Owned -and $Owned.VmName -ceq "bharatcode-preliminary-jit-$($Context.InvocationId)") "teardown escaped owned VM identity"
      if ($State.VmTeardownFailure) { throw "simulated VM teardown failure" }
      $State.OwnedVmPresent = $false
      $State.OwnedDiskPresent = $false
    }
    TeardownOwnedRunner = New-TestOperation $State "teardown-runner" {
      param($State)
      if ($State.RunnerTeardownFailure) { throw "simulated runner teardown failure" }
      $State.OwnedRunnerPresent = $false
    }
    ObserveRunnerAbsent = New-TestOperation $State "runner-absent" { param($State) $State.RunnerAbsent -and -not $State.OwnedRunnerPresent }
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
      "ValidateAdmission", "WriteEvidence", "WaitForWorkflow", "ValidateReceipt", "RequestWorkflowCancellation",
      "WaitForWorkflowTerminal", "TeardownOwnedVm", "TeardownOwnedRunner", "ObserveRunnerAbsent",
      "ObserveOwnedResourcesAbsent", "ValidateDestruction"
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
    Assert-True ($state.Calls.Contains("teardown-vm") -and $state.Calls.Contains("teardown-runner")) "$workflowMode skipped teardown: $($state.Calls -join ','); error=$($workflowError.Message)"
    Assert-True ($state.Calls.IndexOf("teardown-vm") -lt $state.Calls.IndexOf("teardown-runner")) "$workflowMode reversed VM-before-runner teardown"
    Assert-True ($state.Calls.Contains("runner-absent") -and $state.Calls.Contains("resources-absent")) "$workflowMode skipped absence proof"
    Assert-True ($state.Evidence.Contains("destruction")) "$workflowMode omitted validated destruction evidence"
    Assert-True (($workflowMode -ceq "timeout") -eq $state.Calls.Contains("cancel-workflow")) "$workflowMode cancellation decision drifted"
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

  $correctionFailures = [Collections.Generic.List[string]]::new()
  $runnerLabels = @("self-hosted", "windows", "x64", "wsl2", "bharatcode-acceptance-29730000001-2")
  $runnerContext = [pscustomobject]@{
    Repository = "BharatCode-ai/bharatcode-desktop"
    RunId = "29730000001"
    RunAttempt = "2"
    RunnerId = $null
    RunnerName = "bharatcode-jit-29730000001-2-0123456789abcdef0123456789abcdef"
    RequiredLabels = $runnerLabels
  }
  $ownedDisk = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "owned-correction-test.vhdx"))
  $ownedVm = [pscustomobject]@{
    VmCreationAttempted = $true
    VmId = $null
    VmName = "bharatcode-preliminary-jit-0123456789abcdef0123456789abcdef"
    DiskPath = $ownedDisk
  }
  $ownedVmRecord = [pscustomobject]@{ Id = [Guid]::NewGuid(); Name = $ownedVm.VmName; State = "Off" }

  Invoke-CorrectionCase "runner response lost after side effect" {
    $state = New-TestState
    $operations = New-TestOperations $state
    $operations.GenerateRepositoryJitConfiguration = New-TestOperation $state "jit-config" {
      param($State, $Context)
      $State.Endpoint = [string]$Context.RunnerName
      $State.OwnedRunnerPresent = $true
      throw "simulated lost JIT response after runner creation"
    }
    $caseInput = New-TestInput $operations
    [void](Assert-Throws { Invoke-PreliminaryWslJitHostController @caseInput } "lost JIT response returned PASS")
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$state.Endpoint)) "runner name was not established before JIT request; calls=$($state.Calls -join ',')"
    Assert-True (-not $state.OwnedRunnerPresent -and $state.Calls.Contains("teardown-runner")) "lost-response runner was not cleaned by its pre-established identity"
  } $correctionFailures

  Invoke-CorrectionCase "malformed JIT response retains cleanup identity" {
    $state = New-TestState
    $operations = New-TestOperations $state
    $operations.GenerateRepositoryJitConfiguration = New-TestOperation $state "jit-config" {
      param($State, $Context)
      $State.Endpoint = [string]$Context.RunnerName
      $State.OwnedRunnerPresent = $true
      [pscustomobject]@{ Endpoint = $Context.JitEndpoint; RunnerName = $Context.RunnerName; EncodedJitConfiguration = "" }
    }
    $caseInput = New-TestInput $operations
    [void](Assert-Throws { Invoke-PreliminaryWslJitHostController @caseInput } "malformed JIT response returned PASS")
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$state.Endpoint)) "runner name was not established before malformed JIT response; calls=$($state.Calls -join ',')"
    Assert-True (-not $state.OwnedRunnerPresent -and $state.Calls.Contains("teardown-runner")) "malformed-response runner was not cleaned by its pre-established identity"
  } $correctionFailures

  Invoke-CorrectionCase "paginated exact-name runner fallback" {
    $foreign = 1..100 | ForEach-Object { [pscustomobject]@{ id = 1000 + $_; name = "foreign-$_"; labels = @() } }
    $owned = [pscustomobject]@{ id = 9812345; name = $runnerContext.RunnerName; labels = @($runnerLabels | ForEach-Object { [pscustomobject]@{ name = $_ } }) }
    $found = Find-PreliminaryRepositoryRunner $runnerContext {
      param($Context, $Page)
      if ($Page -eq 1) { return [pscustomobject]@{ runners = $foreign } }
      return [pscustomobject]@{ runners = @($owned) }
    }
    Assert-True ([string]$found.id -ceq "9812345") "paginated exact-name runner was not resolved"
  } $correctionFailures

  Invoke-CorrectionCase "exact runner ID remains preferred" {
    $idContext = $runnerContext.PSObject.Copy()
    $idContext.RunnerId = "9812345"
    $sameNameForeignId = [pscustomobject]@{ id = 17; name = $runnerContext.RunnerName; labels = @($runnerLabels | ForEach-Object { [pscustomobject]@{ name = $_ } }) }
    $exactId = [pscustomobject]@{ id = 9812345; name = $runnerContext.RunnerName; labels = @($runnerLabels | ForEach-Object { [pscustomobject]@{ name = $_ } }) }
    $found = Find-PreliminaryRepositoryRunner $idContext { [pscustomobject]@{ runners = @($sameNameForeignId, $exactId) } }
    Assert-True ([string]$found.id -ceq "9812345") "exact runner ID was not preferred"
  } $correctionFailures

  foreach ($runnerCase in @(
      @{ Name = "foreign runner match"; Runners = @([pscustomobject]@{ id = 9; name = $runnerContext.RunnerName; labels = @([pscustomobject]@{ name = "self-hosted" }, [pscustomobject]@{ name = "windows" }, [pscustomobject]@{ name = "x64" }, [pscustomobject]@{ name = "wsl2" }, [pscustomobject]@{ name = "bharatcode-acceptance-9-1" }) }); Error = "label" },
      @{ Name = "duplicate runner match"; Runners = @([pscustomobject]@{ id = 9; name = $runnerContext.RunnerName; labels = @($runnerLabels | ForEach-Object { [pscustomobject]@{ name = $_ } }) }, [pscustomobject]@{ id = 10; name = $runnerContext.RunnerName; labels = @($runnerLabels | ForEach-Object { [pscustomobject]@{ name = $_ } }) }); Error = "unique" },
      @{ Name = "label-drifted runner match"; Runners = @([pscustomobject]@{ id = 9; name = $runnerContext.RunnerName; labels = @($runnerLabels[0..3] | ForEach-Object { [pscustomobject]@{ name = $_ } }) }); Error = "label" }
    )) {
    Invoke-CorrectionCase $runnerCase.Name {
      $case = $runnerCase
      $error = Assert-Throws { Find-PreliminaryRepositoryRunner $runnerContext { [pscustomobject]@{ runners = $case.Runners } } } "uncertain runner match was accepted"
      Assert-True ($error.Message.Contains($case.Error)) "uncertain runner failed for the wrong reason: $($error.Message)"
    } $correctionFailures
  }

  Invoke-CorrectionCase "name-resolved VM with owned disk" {
    $resolved = Resolve-PreliminaryOwnedVm $ownedVm { @() } { @($ownedVmRecord) } { @($ownedDisk) }
    Assert-True ([string]$resolved.Id -ceq [string]$ownedVmRecord.Id) "owned name-resolved VM was not recovered"
  } $correctionFailures

  Invoke-CorrectionCase "live VM start uses the exact resolved owned VM" {
    $vmId = [Guid]::NewGuid()
    $vmName = "bharatcode-preliminary-jit-start-binding-test"
    $diskPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "owned-start-binding-test.vhdx"))
    $vm = [pscustomobject]@{ Id = $vmId; Name = $vmName; State = "Off" }
    $owned = [pscustomobject]@{
      VmCreationAttempted = $true
      VmId = [string]$vmId
      VmName = $vmName
      DiskPath = $diskPath
    }
    $context = [pscustomobject]@{ TimeoutSeconds = 1800; GuestCredential = [pscustomobject]@{ TestOnly = $true } }
    $capture = [pscustomobject]@{ GetVmCalls = 0; GetDiskCalls = 0; StartVmCalls = 0; StartedVm = $null; PowerShellDirectCalls = 0 }
    $sentinel = "test-only Start-VM -VM sentinel"
    $operations = New-PreliminaryWslJitLiveOperations
    $error = Assert-Throws {
      & {
        function Get-VM {
          [CmdletBinding()]
          param([Guid] $Id, [string] $Name)
          $capture.GetVmCalls++
          Assert-True ($Id -eq $vmId -and [string]::IsNullOrEmpty($Name)) "fixture received an inexact VM lookup"
          return $vm
        }
        function Get-VMHardDiskDrive {
          [CmdletBinding()]
          param([Parameter(Mandatory)] [object] $VM)
          $capture.GetDiskCalls++
          Assert-True ([object]::ReferenceEquals($VM, $vm)) "fixture received a substituted VM for disk validation"
          return [pscustomobject]@{ Path = $diskPath }
        }
        function Start-VM {
          [CmdletBinding()]
          param([Parameter(Mandatory)] [object] $VM)
          $capture.StartVmCalls++
          $capture.StartedVm = $VM
          throw $sentinel
        }
        function New-PSSession {
          $capture.PowerShellDirectCalls++
          throw "fixture allowed PowerShell Direct"
        }
        & $operations.TransferAndStartRunner $context $owned "test-only-jit-secret"
      }
    } "live VM start unexpectedly reached PowerShell Direct"
    Assert-True ($error.Message -ceq $sentinel) "live start path did not call supported Start-VM -VM: $($error.GetType().FullName): $($error.Message)"
    Assert-True ($capture.GetVmCalls -eq 1 -and $capture.GetDiskCalls -eq 1) "live start path did not resolve and validate the exact owned VM"
    Assert-True ($capture.StartVmCalls -eq 1 -and [object]::ReferenceEquals($capture.StartedVm, $vm)) "live start path did not pass the resolved VM object"
    Assert-True ($capture.PowerShellDirectCalls -eq 0) "live start regression reached PowerShell Direct"
  } $correctionFailures

  Invoke-CorrectionCase "production VM start matches the installed host parameter contract" {
    $startVm = Get-Command Start-VM -CommandType Cmdlet -ErrorAction Stop
    Assert-True ($startVm.Parameters.ContainsKey("VM")) "installed Start-VM does not expose the required VM parameter"
    Assert-True (-not $startVm.Parameters.ContainsKey("Id")) "installed Start-VM unexpectedly exposes an Id parameter"
    $source = [IO.File]::ReadAllText($controllerPath)
    $startSource = $source.Substring($source.IndexOf('    TransferAndStartRunner = {'), $source.IndexOf('    ObserveRunner = {') - $source.IndexOf('    TransferAndStartRunner = {'))
    Assert-True (-not $startSource.Contains('Start-VM -Id')) "production still uses unsupported Start-VM -Id"
    Assert-True ($startSource.Contains('$vm = Resolve-PreliminaryOwnedVm $Owned')) "VM start does not resolve the exact owned VM"
    Assert-True ($startSource.IndexOf('$vm = Resolve-PreliminaryOwnedVm $Owned') -lt $startSource.IndexOf('Start-VM -VM $vm')) "VM start does not pass the resolved object to Start-VM -VM"
  } $correctionFailures

  Invoke-CorrectionCase "owned VM disables automatic checkpoints before first start" {
    $testId = [Guid]::NewGuid().ToString("N")
    $root = Join-Path ([IO.Path]::GetTempPath()) "bharatcode-preliminary-checkpoint-test-$testId"
    $disk = Join-Path $root "guest.vhdx"
    $vm = [pscustomobject]@{ Id = [Guid]::NewGuid(); Name = "bharatcode-preliminary-jit-$testId"; State = "Off" }
    $capture = [pscustomobject]@{ SetVmCalls = 0; AutomaticCheckpointsEnabled = $null }
    $context = [pscustomobject]@{
      InvocationId = $testId
      BaseVhdxPath = $basePath
      VmMemoryBytes = 4GB
      VmProcessorCount = 2
      VmSwitchName = "approved-existing-switch"
    }
    $owned = [pscustomobject]@{
      AuthorityEstablished = $false
      RootPath = $root
      VmName = $vm.Name
      VmId = $null
      VmCreationAttempted = $false
      DiskPath = $disk
    }
    $operations = New-PreliminaryWslJitLiveOperations
    try {
      & {
        function Get-VM { param([string] $Name) return $null }
        function New-VHD { param([string] $Path, [string] $ParentPath, [switch] $Differencing) [pscustomobject]@{ Path = $Path } }
        function New-VM {
          param([string] $Name, [int] $Generation, [long] $MemoryStartupBytes, [string] $VHDPath, [string] $SwitchName)
          return $vm
        }
        function Set-VMProcessor { param([object] $VM, [int] $Count, [bool] $ExposeVirtualizationExtensions) }
        function Set-VM {
          param([object] $VM, [bool] $AutomaticCheckpointsEnabled)
          $capture.SetVmCalls++
          $capture.AutomaticCheckpointsEnabled = $AutomaticCheckpointsEnabled
        }
        [void](& $operations.CreateOwnedVm $context $owned)
      }
      Assert-True ($capture.SetVmCalls -eq 1 -and $capture.AutomaticCheckpointsEnabled -eq $false) "live VM creation left automatic checkpoints enabled"
      $source = [IO.File]::ReadAllText($controllerPath)
      $prerequisites = $source.Substring($source.IndexOf('    AssertPrerequisites = {'), $source.IndexOf('    DispatchWorkflow = {') - $source.IndexOf('    AssertPrerequisites = {'))
      Assert-True ($prerequisites.Contains('"Set-VM"')) "automatic-checkpoint control is not a closed live prerequisite"
    }
    finally {
      if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root, $true) }
    }
  } $correctionFailures

  Invoke-CorrectionCase "all phases consume one absolute controller deadline" {
    $source = [IO.File]::ReadAllText($controllerPath)
    Assert-True ($source.Contains('DeadlineUtc = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)')) "controller does not establish one absolute deadline"
    Assert-True ([regex]::Matches($source, 'AddSeconds\(\$Context\.TimeoutSeconds\)').Count -eq 0) "a controller phase resets the overall timeout"
    Assert-True ($source.Contains('Get-PreliminaryRemainingTimeoutMilliseconds $Context')) "prepared processes do not receive only the remaining budget"
    $start = [DateTime]::Parse("2026-07-21T10:00:00Z").ToUniversalTime()
    $context = [pscustomobject]@{ DeadlineUtc = $start.AddSeconds(10) }
    $first = Get-PreliminaryRemainingTimeoutMilliseconds $context $start.AddSeconds(2)
    $second = Get-PreliminaryRemainingTimeoutMilliseconds $context $start.AddSeconds(8)
    Assert-True ($first -eq 8000 -and $second -eq 2000 -and $second -lt $first) "remaining deadline budget was reset between phases"
    $error = Assert-Throws { Get-PreliminaryRemainingTimeoutMilliseconds $context $context.DeadlineUtc } "expired absolute deadline was accepted"
    Assert-True ($error -is [TimeoutException]) "expired absolute deadline failed with the wrong error: $($error.GetType().FullName)"
  } $correctionFailures

  Invoke-CorrectionCase "prepared process failure reports only exit metadata" {
    $context = [pscustomobject]@{ DeadlineUtc = [DateTime]::UtcNow.AddSeconds(30) }
    $error = Assert-Throws {
      Invoke-PreliminaryProcess $context (Get-Command pwsh.exe -CommandType Application).Source @("-NoLogo", "-NoProfile", "-Command", "[Console]::Error.Write('diagnostic-only'); exit 7") $null
    } "failing prepared process returned success"
    Assert-True ($error.Message.Contains("exit code 7") -and $error.Message.Contains("stderr SHA-256")) "prepared process failure discarded non-secret exit metadata: $($error.Message)"
    Assert-True (-not $error.Message.Contains("diagnostic-only")) "prepared process failure exposed stderr contents"
  } $correctionFailures

  Invoke-CorrectionCase "GitHub failure retains endpoint identity without request body" {
    $context = [pscustomobject]@{ DeadlineUtc = [DateTime]::UtcNow.AddSeconds(30) }
    $secretSentinel = "encoded-jit-secret-must-not-appear"
    $error = & {
      function Invoke-PreliminaryProcess { throw "simulated prepared command failure" }
      Assert-Throws {
        Invoke-PreliminaryGhJson $context "POST" "repos/BharatCode-ai/bharatcode-desktop/actions/runners/generate-jitconfig" ([ordered]@{ encoded_jit_config = $secretSentinel })
      } "failing GitHub boundary returned success"
    }
    Assert-True ($error.Message.Contains("GitHub API POST repos/BharatCode-ai/bharatcode-desktop/actions/runners/generate-jitconfig failed")) "GitHub failure discarded its non-secret stage identity: $($error.Message)"
    Assert-True (-not $error.ToString().Contains($secretSentinel)) "GitHub failure exposed its request body"
  } $correctionFailures

  Invoke-CorrectionCase "lifecycle adapter failure retains operation identity without payload" {
    $context = [pscustomobject]@{ DeadlineUtc = [DateTime]::UtcNow.AddSeconds(30) }
    $secretSentinel = "lifecycle-secret-must-not-appear"
    $error = & {
      function Invoke-PreliminaryProcess { throw "simulated lifecycle command failure" }
      Assert-Throws {
        Invoke-PreliminaryLifecycleAdapter $context "admission" ([ordered]@{ secret = $secretSentinel })
      } "failing lifecycle boundary returned success"
    }
    Assert-True ($error.Message.Contains("Preliminary lifecycle adapter admission failed")) "lifecycle failure discarded its operation identity: $($error.Message)"
    Assert-True (-not $error.ToString().Contains($secretSentinel)) "lifecycle failure exposed its payload"
  } $correctionFailures

  Invoke-CorrectionCase "New-VM side effect is cleaned after throw" {
    $state = New-TestState
    $operations = New-TestOperations $state
    $operations.CreateOwnedVm = New-TestOperation $state "create-vm" {
      param($State, $Context, $Owned)
      $Owned.AuthorityEstablished = $true
      $Owned.VmCreationAttempted = $true
      $State.OwnedVmPresent = $true
      $State.OwnedDiskPresent = $true
      throw "simulated New-VM post-creation failure"
    }
    $caseInput = New-TestInput $operations
    [void](Assert-Throws { Invoke-PreliminaryWslJitHostController @caseInput } "post-creation New-VM failure returned PASS")
    Assert-True (-not $state.OwnedVmPresent -and -not $state.OwnedDiskPresent) "partial VM was not cleaned after New-VM threw; calls=$($state.Calls -join ',')"
    Assert-True ($state.Calls.IndexOf("teardown-vm") -lt $state.Calls.IndexOf("teardown-runner")) "partial VM cleanup did not precede runner cleanup"
  } $correctionFailures

  foreach ($vmCase in @(
      @{ Name = "missing VM fallback"; ByName = @(); Paths = @($ownedDisk); Error = "missing" },
      @{ Name = "duplicate VM fallback"; ByName = @($ownedVmRecord, $ownedVmRecord); Paths = @($ownedDisk); Error = "unique" },
      @{ Name = "foreign VM fallback"; ByName = @([pscustomobject]@{ Id = [Guid]::NewGuid(); Name = "foreign-vm"; State = "Off" }); Paths = @($ownedDisk); Error = "identity" },
      @{ Name = "disk-mismatched VM fallback"; ByName = @($ownedVmRecord); Paths = @([IO.Path]::GetFullPath((Join-Path $PSScriptRoot "foreign.vhdx"))); Error = "disk" }
    )) {
    Invoke-CorrectionCase $vmCase.Name {
      $case = $vmCase
      $error = Assert-Throws { Resolve-PreliminaryOwnedVm $ownedVm { @() } { $case.ByName } { $case.Paths } } "uncertain VM fallback was accepted"
      Assert-True ($error.Message.Contains($case.Error)) "uncertain VM failed for the wrong reason: $($error.Message)"
    } $correctionFailures
  }

  $failureOperations = @{
    "jit-config" = "GenerateRepositoryJitConfiguration"
    "create-vm" = "CreateOwnedVm"
    "start-runner" = "TransferAndStartRunner"
    "validate-admission" = "ValidateAdmission"
  }
  foreach ($failureStage in @("jit-config", "create-vm", "start-runner", "validate-admission", "wait-workflow")) {
    Invoke-CorrectionCase "workflow cancellation after $failureStage failure" {
      $state = New-TestState
      if ($failureStage -ceq "wait-workflow") { $state.WorkflowMode = "timeout" }
      $operations = New-TestOperations $state
      if ($failureStage -cne "wait-workflow") {
        $operations[$failureOperations[$failureStage]] = New-TestOperation $state $failureStage { throw "simulated post-dispatch failure" }
      }
      $caseInput = New-TestInput $operations
      [void](Assert-Throws { Invoke-PreliminaryWslJitHostController @caseInput } "post-dispatch failure returned PASS")
      Assert-True ($state.Calls.Contains("cancel-workflow")) "abandoned exact workflow run was not cancelled; calls=$($state.Calls -join ',')"
      Assert-True ($state.Calls.Contains("wait-terminal")) "cancelled exact workflow run did not reach a terminal state"
      Assert-True ($state.Calls.IndexOf("teardown-vm") -lt $state.Calls.IndexOf("teardown-runner")) "VM-before-runner teardown order drifted"
    } $correctionFailures
  }

  Invoke-CorrectionCase "workflow cancellation after immutable dispatch ID follow-up failure" {
    $state = New-TestState
    $operations = New-TestOperations $state
    $operations.DispatchWorkflow = New-TestOperation $state "dispatch" {
      param($State, $Context)
      $Context.RunId = "29730000001"
      $Context.WorkflowDispatched = $true
      throw "simulated post-dispatch identity lookup failure"
    }
    $caseInput = New-TestInput $operations
    $error = Assert-Throws { Invoke-PreliminaryWslJitHostController @caseInput } "partial dispatch failure returned PASS"
    Assert-True ($state.Calls.Contains("cancel-workflow") -and $state.Calls.Contains("wait-terminal")) "immutable partial dispatch was abandoned"
    Assert-True (-not $error.ToString().Contains("Completed workflow identity drift")) "partial dispatch could not independently resolve its run attempt"
  } $correctionFailures

  Invoke-CorrectionCase "successful workflow is never cancelled" {
    $state = New-TestState
    $caseInput = New-TestInput (New-TestOperations $state)
    [void](Invoke-PreliminaryWslJitHostController @caseInput)
    Assert-True (-not $state.Calls.Contains("cancel-workflow")) "successful workflow was cancelled"
  } $correctionFailures

  foreach ($completedFailure in @("receipt-retrieval", "receipt-validation")) {
    Invoke-CorrectionCase "completed successful workflow is not cancelled after $completedFailure failure" {
      $state = New-TestState
      $operations = New-TestOperations $state
      if ($completedFailure -ceq "receipt-retrieval") {
        $operations.WaitForWorkflow = New-TestOperation $state "wait-workflow" {
          param($State, $Context)
          $Context.WorkflowCompleted = $true
          throw "simulated post-completion receipt retrieval failure"
        }
      } else {
        $operations.ValidateReceipt = New-TestOperation $state "validate-receipt" { throw "simulated receipt validation failure" }
      }
      $caseInput = New-TestInput $operations
      [void](Assert-Throws { Invoke-PreliminaryWslJitHostController @caseInput } "post-completion receipt failure returned PASS")
      Assert-True (-not $state.Calls.Contains("cancel-workflow")) "completed successful workflow was cancelled after $completedFailure failure"
    } $correctionFailures
  }

  Invoke-CorrectionCase "independent cancellation VM and runner cleanup aggregation" {
    $state = New-TestState
    $state.WorkflowMode = "timeout"
    $state.CancellationFailure = $true
    $state.VmTeardownFailure = $true
    $state.RunnerTeardownFailure = $true
    $caseInput = New-TestInput (New-TestOperations $state)
    $error = Assert-Throws { Invoke-PreliminaryWslJitHostController @caseInput } "independent cleanup failures returned PASS"
    $messages = if ($error -is [AggregateException]) { @($error.Flatten().InnerExceptions | ForEach-Object { $_.Message }) -join "`n" } else { $error.Message }
    foreach ($expected in @("simulated cancellation failure", "simulated VM teardown failure", "simulated runner teardown failure")) {
      Assert-True ($messages.Contains($expected)) "cleanup aggregation omitted: $expected; messages=$messages; calls=$($state.Calls -join ',')"
    }
    Assert-True ($state.Calls.Contains("teardown-vm") -and $state.Calls.Contains("teardown-runner")) "cancellation failure suppressed VM or runner teardown"
    Assert-True ($state.Calls.IndexOf("teardown-vm") -lt $state.Calls.IndexOf("teardown-runner")) "cleanup failure reversed VM-before-runner order"
    Assert-True ($state.Calls.Contains("wait-terminal")) "cancellation request failure suppressed bounded terminal observation"
  } $correctionFailures

  if ($correctionFailures.Count -gt 0) {
    throw [AggregateException]::new("Preliminary JIT correction regressions failed", [Exception[]]@($correctionFailures | ForEach-Object { [Exception]::new($_) }))
  }

  $source = [IO.File]::ReadAllText($controllerPath)
  Assert-True (-not $source.Contains("/orgs/")) "organization runner authority was introduced"
  Assert-True (-not $source.Contains("registration-token")) "persistent registration fallback was introduced"
  Assert-True (-not $source.Contains("-ExecutionPolicy")) "execution policy override was introduced"
  Assert-True (-not $source.Contains("force-cancel")) "force-cancel fallback was introduced"
  Assert-True ($source.Contains("[Security.Cryptography.RandomNumberGenerator]::GetBytes(16)")) "runner and VM identities are not cryptographically random"
  Assert-True ($source.Contains("function Find-PreliminaryRepositoryRunner") -and $source.Contains('per_page=100&page=$page')) "runner absence is limited to one API page"
  $createVmSource = $source.Substring($source.IndexOf('    CreateOwnedVm = {'), $source.IndexOf('    TransferAndStartRunner = {') - $source.IndexOf('    CreateOwnedVm = {'))
  Assert-True ($createVmSource.IndexOf('$Owned.VmCreationAttempted = $true') -lt $createVmSource.IndexOf('New-VM')) "New-VM can run before its name fallback is armed"
  Assert-True ($createVmSource.IndexOf('$Owned.VmId =') -lt $createVmSource.IndexOf('Set-VMProcessor')) "partial VM creation can lose teardown identity"
  $finallySource = $source.Substring($source.IndexOf('  finally {'), $source.IndexOf('  if ($primary -or $cleanupErrors.Count') - $source.IndexOf('  finally {'))
  Assert-True ($finallySource.IndexOf('$Operations["TeardownOwnedVm"]') -lt $finallySource.IndexOf('$Operations["TeardownOwnedRunner"]')) "runner deletion precedes owned VM destruction"
  Assert-True ($finallySource.Contains('$Operations["RequestWorkflowCancellation"]') -and $finallySource.Contains('$Operations["WaitForWorkflowTerminal"]')) "abandoned exact-run cancellation is not bounded"
  $dispatchSource = $source.Substring($source.IndexOf('    DispatchWorkflow = {'), $source.IndexOf('    GenerateRepositoryJitConfiguration = {') - $source.IndexOf('    DispatchWorkflow = {'))
  Assert-True ($dispatchSource.Contains('$Context.RunId =') -and $dispatchSource.IndexOf('$Context.RunId =') -lt $dispatchSource.IndexOf('$run =')) "immutable dispatch ID is not armed for cancellation before follow-up lookup"
  Write-Output "preliminary_wsl_jit_host_controller_tests=passed"
}
finally {
  [Environment]::SetEnvironmentVariable("BHARATCODE_PRELIMINARY_JIT_HOST_CONTROLLER_TEST", $previousTestMode, [EnvironmentVariableTarget]::Process)
}
