$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not ("BharatCode.Preliminary.PreliminaryControllerNative" -as [type])) {
  Add-Type -TypeDefinition @'
using Microsoft.Win32.SafeHandles;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace BharatCode.Preliminary {
  public sealed class PreliminaryOwnedProcess : IDisposable {
    private SafeFileHandle processHandle;
    public int ProcessId { get; private set; }
    internal PreliminaryOwnedProcess(SafeFileHandle handle, int processId) { processHandle = handle; ProcessId = processId; }
    public int WaitForExit(int milliseconds) {
      var wait = PreliminaryControllerNative.WaitForSingleObject(processHandle, checked((uint)milliseconds));
      PreliminaryControllerNative.Diagnostic("preliminary_controller_process_wait=pid:" + ProcessId.ToString() + ";wait:" + wait.ToString() + ";timeout_ms:" + milliseconds.ToString());
      if (wait == PreliminaryControllerNative.WAIT_TIMEOUT) throw new TimeoutException("Preliminary owned process timed out");
      if (wait != PreliminaryControllerNative.WAIT_OBJECT_0) throw new InvalidOperationException("Preliminary owned process wait failed");
      uint exitCode;
      if (!PreliminaryControllerNative.GetExitCodeProcess(processHandle, out exitCode)) throw new InvalidOperationException("Preliminary owned process result is unavailable");
      PreliminaryControllerNative.Diagnostic("preliminary_controller_process_exit=pid:" + ProcessId.ToString() + ";exit_code:" + exitCode.ToString());
      return unchecked((int)exitCode);
    }
    public void Dispose() { if (processHandle != null) processHandle.Dispose(); processHandle = null; }
  }

  internal sealed class PinnedFile : IDisposable {
    internal readonly SafeFileHandle Handle;
    internal readonly ulong VolumeSerialNumber;
    internal readonly byte[] FileId;
    internal readonly string FinalPath;
    internal readonly byte[] ContentIdentity;
    private readonly DirectoryChainAuthority externalParent;
    private readonly OwnedDirectoryAuthority ownedParent;
    internal long Length { get { return BitConverter.ToInt64(ContentIdentity, 0); } }
    internal string Sha256 { get { return PreliminaryControllerNative.Hex(ContentIdentity.Skip(8).ToArray()); } }
    internal PinnedFile(SafeFileHandle handle, PreliminaryControllerNative.FILE_ID_INFO identity, string finalPath, DirectoryChainAuthority parent) {
      Handle = handle;
      VolumeSerialNumber = identity.VolumeSerialNumber;
      FileId = identity.FileId.ToByteArray();
      FinalPath = finalPath;
      externalParent = parent;
      ContentIdentity = PreliminaryControllerNative.ContentIdentity(Handle);
    }
    internal PinnedFile(SafeFileHandle handle, PreliminaryControllerNative.FILE_ID_INFO identity, string finalPath, OwnedDirectoryAuthority parent) {
      Handle = handle;
      VolumeSerialNumber = identity.VolumeSerialNumber;
      FileId = identity.FileId.ToByteArray();
      FinalPath = finalPath;
      ownedParent = parent;
      ContentIdentity = PreliminaryControllerNative.ContentIdentity(Handle);
    }
    internal PinnedFile(SafeFileHandle handle, PreliminaryControllerNative.FILE_ID_INFO identity, string finalPath) {
      Handle = handle;
      VolumeSerialNumber = identity.VolumeSerialNumber;
      FileId = identity.FileId.ToByteArray();
      FinalPath = finalPath;
      ContentIdentity = PreliminaryControllerNative.ContentIdentity(Handle);
    }
    internal void Validate() {
      if (externalParent != null) externalParent.Validate();
      if (ownedParent != null) ownedParent.Validate();
      var identity = PreliminaryControllerNative.Identity(Handle);
      if (identity.VolumeSerialNumber != VolumeSerialNumber || !PreliminaryControllerNative.FixedEquals(identity.FileId.ToByteArray(), FileId)) throw new InvalidOperationException("Preliminary pinned file ID drift");
      if (!String.Equals(PreliminaryControllerNative.FinalPath(Handle), FinalPath, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Preliminary pinned file final path drift");
      if ((PreliminaryControllerNative.Attributes(Handle) & PreliminaryControllerNative.FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw new InvalidOperationException("Preliminary pinned file became a reparse point");
      if (!PreliminaryControllerNative.FixedEquals(PreliminaryControllerNative.ContentIdentity(Handle), ContentIdentity)) throw new InvalidOperationException("Preliminary pinned file content drift");
    }
    internal string Diagnostic() { return PreliminaryControllerNative.DescribeHandle(Handle); }
    public void Dispose() { Handle.Dispose(); if (externalParent != null) externalParent.Dispose(); }
  }

  public sealed class PinnedFileAuthority : IDisposable {
    private readonly Dictionary<string, PinnedFile> pins = new Dictionary<string, PinnedFile>(StringComparer.OrdinalIgnoreCase);
    private bool disposed;
    public void PinExternal(string label, string path) {
      if (disposed || String.IsNullOrEmpty(label) || !System.Text.RegularExpressions.Regex.IsMatch(label, "^[a-z][a-z0-9-]{0,63}$") || pins.ContainsKey(label)) throw new InvalidOperationException("Preliminary external pin label is invalid or already exists");
      pins.Add(label, PreliminaryControllerNative.PinFile(path, null));
      Validate();
    }
    internal PinnedFile RequiredPin(string label) {
      PinnedFile pin;
      if (disposed || String.IsNullOrEmpty(label) || !pins.TryGetValue(label, out pin)) throw new InvalidOperationException("Preliminary external pin is unavailable");
      pin.Validate();
      return pin;
    }
    internal void Validate() {
      if (disposed) throw new InvalidOperationException("Preliminary pinned-file authority is unavailable");
      foreach (var pin in pins.Values) pin.Validate();
    }
    internal string Diagnostic() { return String.Join(" || ", pins.Select(pin => pin.Key + ":" + pin.Value.Diagnostic())); }
    public void Dispose() {
      if (disposed) return;
      foreach (var pin in pins.Values) pin.Dispose();
      pins.Clear();
      disposed = true;
    }
  }

  internal sealed class HeldDirectory {
    internal readonly SafeFileHandle Handle;
    internal readonly string FinalPath;
    internal readonly PreliminaryControllerNative.FILE_ID_INFO Identity;
    internal HeldDirectory(SafeFileHandle handle, string finalPath, PreliminaryControllerNative.FILE_ID_INFO identity) {
      Handle = handle;
      FinalPath = finalPath;
      Identity = identity;
    }
  }

  internal sealed class DirectoryChainAuthority : IDisposable {
    private readonly List<HeldDirectory> chain;
    internal SafeFileHandle Handle { get { return chain[chain.Count - 1].Handle; } }
    internal string FinalPath { get { return chain[chain.Count - 1].FinalPath; } }
    internal PreliminaryControllerNative.FILE_ID_INFO Identity { get { return chain[chain.Count - 1].Identity; } }
    internal DirectoryChainAuthority(List<HeldDirectory> value) { chain = value; }
    internal void Validate() {
      if (chain == null || chain.Count == 0) throw new InvalidOperationException("Preliminary directory-chain authority is unavailable");
      foreach (var held in chain) PreliminaryControllerNative.ValidateHeldDirectory(held.Handle, held.FinalPath, held.Identity.VolumeSerialNumber, held.Identity.FileId.ToByteArray());
    }
    internal string Diagnostic() { return String.Join(" || ", chain.Select((held, index) => "index:" + index.ToString() + ";" + PreliminaryControllerNative.DescribeHandle(held.Handle))); }
    public void Dispose() { for (var index = chain.Count - 1; index >= 0; index--) chain[index].Handle.Dispose(); chain.Clear(); }
  }

  internal sealed class OwnedDirectoryAuthority : IDisposable {
    internal readonly SafeFileHandle Handle;
    internal readonly string FinalPath;
    internal readonly PreliminaryControllerNative.FILE_ID_INFO Identity;
    internal OwnedDirectoryAuthority(SafeFileHandle handle, string finalPath) { Handle = handle; FinalPath = finalPath; Identity = PreliminaryControllerNative.Identity(handle); }
    internal void Validate() { PreliminaryControllerNative.ValidateHeldDirectory(Handle, FinalPath, Identity.VolumeSerialNumber, Identity.FileId.ToByteArray()); }
    internal string Diagnostic() { return PreliminaryControllerNative.DescribeHandle(Handle); }
    public void Dispose() { Handle.Dispose(); }
  }

  public sealed class PublicationAuthority : IDisposable {
    private readonly DirectoryChainAuthority parent;
    private readonly string leaf;
    internal PublicationAuthority(DirectoryChainAuthority value, string name) { parent = value; leaf = name; }
    internal void Validate() { parent.Validate(); if (PreliminaryControllerNative.RelativeEntryExists(parent.Handle, leaf)) throw new InvalidOperationException("Preliminary final receipt collision"); }
    public void PublishCreateNew(byte[] bytes) { Validate(); PreliminaryControllerNative.PublishCreateNew(parent.Handle, leaf, bytes); parent.Validate(); }
    public void Dispose() { parent.Dispose(); }
  }

  public sealed class PreliminaryControllerLease : IDisposable {
    private readonly DirectoryChainAuthority parentAuthority;
    private SafeFileHandle rootHandle;
    private SafeFileHandle jobHandle;
    private readonly byte[] capability;
    private readonly byte[] sealedCapability;
    private readonly ulong expectedVolumeSerial;
    private byte[] expectedFileId;
    private string expectedFinalPath;
    private readonly byte[] expectedSecurityDigest;
    private readonly string expectedParentFinalPath;
    private readonly ulong expectedParentVolumeSerial;
    private readonly byte[] expectedParentFileId;
    private readonly SecurityIdentifier expectedOwner;
    private readonly Dictionary<string, PinnedFile> pins = new Dictionary<string, PinnedFile>(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, OwnedDirectoryAuthority> ownedDirectories = new Dictionary<string, OwnedDirectoryAuthority>(StringComparer.OrdinalIgnoreCase);
    private readonly List<PreliminaryOwnedProcess> processes = new List<PreliminaryOwnedProcess>();
    private PinnedFileAuthority externalPins;
    private bool deleted;
    private string activeStage;
    public string RootPath { get; private set; }
    public string RootLeaf { get; private set; }

    internal PreliminaryControllerLease(string rootPath, DirectoryChainAuthority parent, SafeFileHandle root, PreliminaryControllerNative.FILE_ID_INFO rootIdentity, SecurityIdentifier owner, byte[] securityDigest, byte[] secret) {
      RootPath = rootPath;
      RootLeaf = Path.GetFileName(rootPath);
      parentAuthority = parent;
      rootHandle = root;
      expectedParentFinalPath = parent.FinalPath;
      expectedParentVolumeSerial = parent.Identity.VolumeSerialNumber;
      expectedParentFileId = parent.Identity.FileId.ToByteArray();
      expectedFinalPath = PreliminaryControllerNative.FinalPath(root);
      expectedVolumeSerial = rootIdentity.VolumeSerialNumber;
      expectedFileId = rootIdentity.FileId.ToByteArray();
      expectedOwner = owner;
      expectedSecurityDigest = securityDigest;
      capability = secret;
      sealedCapability = (byte[])secret.Clone();
    }

    public void Validate() {
      if (deleted || rootHandle == null || rootHandle.IsInvalid || rootHandle.IsClosed || !PreliminaryControllerNative.FixedEquals(capability, sealedCapability)) throw new InvalidOperationException("Preliminary controller capability is unavailable");
      parentAuthority.Validate();
      if (externalPins != null) externalPins.Validate();
      PreliminaryControllerNative.ValidateHeldDirectory(rootHandle, expectedFinalPath, expectedVolumeSerial, expectedFileId);
      var security = PreliminaryControllerNative.ValidateSecurity(RootPath, expectedOwner);
      if (!PreliminaryControllerNative.FixedEquals(security, expectedSecurityDigest)) throw new InvalidOperationException("Preliminary root DACL drift");
    }

    public void PinInstaller(string path) { Pin(path, "installer", false); }
    public void PinInstalledDesktop(string path) { Pin(path, "installed", true); }
    public void PinExternal(string label, string path) { Pin(path, label, false); }
    public void PinOwned(string label, string path) { Pin(path, label, true); }
    public void CreateOwnedDirectory(string label, string leaf) {
      Validate();
      if (String.IsNullOrEmpty(label) || ownedDirectories.ContainsKey(label)) throw new InvalidOperationException("Preliminary owned directory label is invalid or already exists");
      ownedDirectories.Add(label, PreliminaryControllerNative.CreateOwnedDirectory(rootHandle, RootPath, leaf));
      Validate();
    }
    public void CopyPinnedNew(string sourceLabel, string destinationLabel, string directoryLabel, string leaf) {
      Validate();
      if (pins.ContainsKey(destinationLabel)) throw new InvalidOperationException("Preliminary destination pin already exists");
      pins.Add(destinationLabel, PreliminaryControllerNative.CopyPinnedNew(RequiredPin(sourceLabel), RequiredOwnedDirectory(directoryLabel), leaf));
      Validate();
    }
    public void WriteNew(string destinationLabel, string leaf, byte[] bytes) {
      Validate();
      if (pins.ContainsKey(destinationLabel)) throw new InvalidOperationException("Preliminary destination pin already exists");
      pins.Add(destinationLabel, PreliminaryControllerNative.WriteNew(rootHandle, RootPath, leaf, bytes));
      Validate();
    }
    public void PinOwnedRelative(string label, string leaf) {
      Validate();
      if (pins.ContainsKey(label)) throw new InvalidOperationException("Preliminary destination pin already exists");
      pins.Add(label, PreliminaryControllerNative.PinOwnedRelative(rootHandle, RootPath, leaf));
      Validate();
    }
    public void AttachPinnedFiles(PinnedFileAuthority value) {
      Validate();
      if (value == null || externalPins != null) throw new InvalidOperationException("Preliminary pinned-file authority attachment is invalid");
      value.Validate();
      externalPins = value;
      Validate();
    }
    public long PinnedLength(string label) { Validate(); return RequiredPin(label).Length; }
    public string PinnedSha256(string label) { Validate(); return RequiredPin(label).Sha256; }
    public byte[] PinnedBytes(string label) { Validate(); return PreliminaryControllerNative.ReadAllBytes(RequiredPin(label).Handle); }
    private PinnedFile RequiredPin(string label) {
      PinnedFile pin;
      if (String.IsNullOrEmpty(label)) throw new InvalidOperationException("Preliminary pin is unavailable");
      if (!pins.TryGetValue(label, out pin)) return externalPins == null ? throw new InvalidOperationException("Preliminary pin is unavailable") : externalPins.RequiredPin(label);
      pin.Validate();
      return pin;
    }
    private OwnedDirectoryAuthority RequiredOwnedDirectory(string label) {
      OwnedDirectoryAuthority value;
      if (String.IsNullOrEmpty(label) || !ownedDirectories.TryGetValue(label, out value)) throw new InvalidOperationException("Preliminary owned directory authority is unavailable");
      value.Validate();
      return value;
    }
    private void Pin(string path, string label, bool requireRoot) {
      Validate();
      if (String.IsNullOrEmpty(label) || !System.Text.RegularExpressions.Regex.IsMatch(label, "^[a-z][a-z0-9-]{0,63}$") || pins.ContainsKey(label)) throw new InvalidOperationException("Preliminary pin label is invalid or already exists");
      pins.Add(label, PreliminaryControllerNative.PinFile(path, requireRoot ? RootPath : null));
    }

    public void BeginStage(string stage) {
      Validate();
      if (String.IsNullOrEmpty(stage) || !System.Text.RegularExpressions.Regex.IsMatch(stage, "^[a-z][a-z0-9-]{0,31}$")) throw new InvalidOperationException("Preliminary stage name is invalid");
      if (jobHandle != null || activeStage != null || processes.Count != 0) throw new InvalidOperationException("Preliminary process stage is already active");
      jobHandle = PreliminaryControllerNative.CreateKillOnCloseJob();
      activeStage = stage;
    }

    public PreliminaryOwnedProcess StartOwnedProcess(string pinLabel, string arguments) {
      return StartOwnedProcess(pinLabel, arguments, false);
    }
    public PreliminaryOwnedProcess StartOwnedProcess(string pinLabel, string arguments, bool forceAssignmentFailure) {
      Validate();
      if (activeStage == null || jobHandle == null || jobHandle.IsClosed || jobHandle.IsInvalid) throw new InvalidOperationException("Preliminary process stage is unavailable");
      var pin = RequiredPin(pinLabel);
      var process = PreliminaryControllerNative.StartSuspendedInJob(jobHandle, pin.FinalPath, arguments, forceAssignmentFailure);
      pin.Validate();
      processes.Add(process);
      return process;
    }

    public int JobProcessCount { get { return jobHandle == null ? 0 : PreliminaryControllerNative.JobProcessCount(jobHandle); } }
    public int[] JobProcessIds { get { return jobHandle == null ? new int[0] : PreliminaryControllerNative.JobProcessIds(jobHandle); } }

    public void CloseStage() {
      if (jobHandle == null) { AssertNoOwnedProcesses(); return; }
      Exception failure = null;
      var barrierProven = false;
      try {
        try {
          var beforePids = PreliminaryControllerNative.JobProcessIds(jobHandle);
          PreliminaryControllerNative.Diagnostic("preliminary_controller_job_before_termination=stage:" + activeStage + ";controller_pid:" + System.Diagnostics.Process.GetCurrentProcess().Id.ToString() + ";owned_pids:" + String.Join(",", processes.Select(process => process.ProcessId.ToString())) + ";job_pids:" + String.Join(",", beforePids.Select(pid => pid.ToString())) + ";job_count:" + beforePids.Length.ToString());
        }
        catch (Exception diagnostic) { PreliminaryControllerNative.Diagnostic("preliminary_controller_job_before_termination=stage:" + activeStage + ";controller_pid:" + System.Diagnostics.Process.GetCurrentProcess().Id.ToString() + ";membership_error:" + diagnostic.ToString()); }
        var terminated = PreliminaryControllerNative.TerminateJobForStage(jobHandle, 1);
        PreliminaryControllerNative.Diagnostic("preliminary_controller_job_termination=stage:" + activeStage + ";result:" + terminated.ToString());
        if (!terminated) {
          PreliminaryControllerNative.Diagnostic("preliminary_controller_job_termination_fallback=stage:" + activeStage + ";mode:member-drain");
          PreliminaryControllerNative.TerminateJobMembersIndividually(jobHandle, 1);
        }
        var deadline = DateTime.UtcNow.AddSeconds(20);
        var remainingCount = -1;
        Exception countFailure = null;
        try {
          do {
            remainingCount = PreliminaryControllerNative.JobProcessCount(jobHandle);
            if (remainingCount == 0) break;
            Thread.Sleep(50);
          } while (DateTime.UtcNow < deadline);
        }
        catch (Exception error) { countFailure = error; }
        int[] remainingPids = null;
        try { remainingPids = PreliminaryControllerNative.JobProcessIds(jobHandle); }
        catch (Exception identityFailure) {
          if (remainingCount != 0) throw new AggregateException("Preliminary stage Job barrier probes failed", countFailure ?? new InvalidOperationException("Preliminary job member count is nonzero"), identityFailure);
          PreliminaryControllerNative.Diagnostic("preliminary_controller_job_after_termination=stage:" + activeStage + ";membership_error:" + identityFailure.ToString() + ";job_count:0");
          remainingPids = new int[0];
        }
        if (countFailure != null) PreliminaryControllerNative.Diagnostic("preliminary_controller_job_after_termination=stage:" + activeStage + ";count_error:" + countFailure.ToString() + ";fallback_job_pids:" + String.Join(",", remainingPids.Select(pid => pid.ToString())));
        if (remainingCount < 0 && remainingPids.Length == 0) remainingCount = 0;
        PreliminaryControllerNative.Diagnostic("preliminary_controller_job_after_termination=stage:" + activeStage + ";job_pids:" + String.Join(",", remainingPids.Select(pid => pid.ToString())) + ";job_count:" + remainingCount.ToString());
        if (remainingPids.Length != 0 || remainingCount != 0) throw new InvalidOperationException("Preliminary stage job children survived termination");
        barrierProven = true;
      }
      catch (Exception error) { failure = error; }
      if (barrierProven) {
        foreach (var process in processes) process.Dispose();
        processes.Clear();
        jobHandle.Dispose();
        jobHandle = null;
        activeStage = null;
      }
      if (failure != null) throw failure;
      AssertNoOwnedProcesses();
    }

    public void AssertNoOwnedProcesses() {
      if (jobHandle != null || activeStage != null || processes.Count != 0 || JobProcessCount != 0 || JobProcessIds.Length != 0) throw new InvalidOperationException("Preliminary owned process barrier is not empty");
    }

    public void DeleteOwnedTree() {
      ValidateCleanupAuthority();
      AssertNoOwnedProcesses();
      PreliminaryControllerNative.Diagnostic("preliminary_controller_cleanup_handles=root:" + PreliminaryControllerNative.DescribeHandle(rootHandle) + ";parent_chain:" + parentAuthority.Diagnostic() + ";external_pins:" + (externalPins == null ? "" : externalPins.Diagnostic()) + ";pins:" + String.Join(" || ", pins.Select(pin => pin.Key + ":" + pin.Value.Diagnostic())) + ";owned_directories:" + String.Join(" || ", ownedDirectories.Select(directory => directory.Key + ":" + directory.Value.Diagnostic())));
      foreach (var pin in pins.Values) pin.Validate();
      foreach (var pin in pins.Values) pin.Dispose();
      pins.Clear();
      if (externalPins != null) { externalPins.Dispose(); externalPins = null; }
      foreach (var directory in ownedDirectories.Values) directory.Dispose();
      ownedDirectories.Clear();
      PreliminaryControllerNative.DeleteChildrenHandleRelative(rootHandle);
      PreliminaryControllerNative.DeleteByHandle(rootHandle);
      rootHandle.Dispose();
      rootHandle = null;
      deleted = true;
      if (PreliminaryControllerNative.ParentContainsName(parentAuthority.Handle, RootLeaf)) throw new InvalidOperationException("Preliminary root child survived cleanup");
    }

    private void ValidateCleanupAuthority() {
      if (deleted || rootHandle == null || rootHandle.IsInvalid || rootHandle.IsClosed || !PreliminaryControllerNative.FixedEquals(capability, sealedCapability)) throw new InvalidOperationException("Preliminary controller cleanup capability is unavailable");
      parentAuthority.Validate();
      PreliminaryControllerNative.ValidateHeldDirectory(rootHandle, expectedFinalPath, expectedVolumeSerial, expectedFileId);
    }

    public void Dispose() {
      foreach (var pin in pins.Values) pin.Dispose();
      pins.Clear();
      foreach (var directory in ownedDirectories.Values) directory.Dispose();
      ownedDirectories.Clear();
      foreach (var process in processes) process.Dispose();
      processes.Clear();
      if (jobHandle != null) jobHandle.Dispose();
      if (rootHandle != null) rootHandle.Dispose();
      parentAuthority.Dispose();
    }
  }

  public static class PreliminaryControllerNative {
    public static int LastAssignmentFailureProcessId { get; private set; }
    private static int failNextJobProcessIdsForTest;
    private static int failNextJobProcessCountForTest;
    private static int failNextTerminateJobForTest;
    public const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_LIST_DIRECTORY = 0x00000001;
    private const uint READ_CONTROL = 0x00020000;
    private const uint DELETE = 0x00010000;
    private const uint GENERIC_ALL = 0x10000000;
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint PROCESS_TERMINATE = 0x00000001;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_CREATE = 2;
    private const uint FILE_OPEN = 1;
    private const uint FILE_DIRECTORY_FILE = 0x00000001;
    private const uint FILE_NON_DIRECTORY_FILE = 0x00000040;
    private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
    private const uint FILE_OPEN_REPARSE_POINT = 0x00200000;
    private const uint OBJ_CASE_INSENSITIVE = 0x00000040;
    private const int FILE_ID_INFO_CLASS = 18;
    private const int FILE_STANDARD_INFO_CLASS = 1;
    private const int FILE_ATTRIBUTE_TAG_INFO_CLASS = 9;
    private const int FILE_DIRECTORY_INFORMATION = 1;
    private const int FILE_DISPOSITION_INFORMATION_EX = 64;
    private const int FILE_RENAME_INFORMATION_EX = 65;
    private const uint FILE_DISPOSITION_FLAG_DELETE = 0x00000001;
    private const uint FILE_DISPOSITION_FLAG_POSIX_SEMANTICS = 0x00000002;
    private const uint FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE = 0x00000010;
    private const uint FILE_RENAME_FLAG_POSIX_SEMANTICS = 0x00000002;
    private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
    private const int JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
    private const int JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
    private const uint DRIVE_FIXED = 3;
    internal const uint WAIT_OBJECT_0 = 0;
    internal const uint WAIT_TIMEOUT = 258;
    private const int ERROR_MORE_DATA = 234;
    private const int STATUS_NO_MORE_FILES = unchecked((int)0x80000006);

    [StructLayout(LayoutKind.Sequential)] internal struct UNICODE_STRING { internal ushort Length; internal ushort MaximumLength; internal IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] internal struct OBJECT_ATTRIBUTES { internal int Length; internal IntPtr RootDirectory; internal IntPtr ObjectName; internal uint Attributes; internal IntPtr SecurityDescriptor; internal IntPtr SecurityQualityOfService; }
    [StructLayout(LayoutKind.Sequential)] internal struct IO_STATUS_BLOCK { internal IntPtr Status; internal UIntPtr Information; }
    [StructLayout(LayoutKind.Sequential)] internal struct FILE_DISPOSITION_INFO_EX { internal uint Flags; }
    [StructLayout(LayoutKind.Sequential)] internal struct FILE_ATTRIBUTE_TAG_INFO { internal uint FileAttributes; internal uint ReparseTag; }
    [StructLayout(LayoutKind.Sequential)] internal struct FILE_STANDARD_INFO { internal long AllocationSize; internal long EndOfFile; internal uint NumberOfLinks; [MarshalAs(UnmanagedType.U1)] internal bool DeletePending; [MarshalAs(UnmanagedType.U1)] internal bool Directory; }
    [StructLayout(LayoutKind.Sequential)] public struct FILE_ID_INFO { public ulong VolumeSerialNumber; public Guid FileId; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct STARTUPINFO { internal uint cb; internal string reserved; internal string desktop; internal string title; internal uint x; internal uint y; internal uint xSize; internal uint ySize; internal uint xCountChars; internal uint yCountChars; internal uint fillAttribute; internal uint flags; internal ushort showWindow; internal ushort reserved2; internal IntPtr reserved2Pointer; internal IntPtr standardInput; internal IntPtr standardOutput; internal IntPtr standardError; }
    [StructLayout(LayoutKind.Sequential)] internal struct PROCESS_INFORMATION { internal IntPtr Process; internal IntPtr Thread; internal uint ProcessId; internal uint ThreadId; }
    [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION { internal long PerProcessUserTimeLimit; internal long PerJobUserTimeLimit; internal uint LimitFlags; internal UIntPtr MinimumWorkingSetSize; internal UIntPtr MaximumWorkingSetSize; internal uint ActiveProcessLimit; internal UIntPtr Affinity; internal uint PriorityClass; internal uint SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] internal struct IO_COUNTERS { internal ulong ReadOperationCount; internal ulong WriteOperationCount; internal ulong OtherOperationCount; internal ulong ReadTransferCount; internal ulong WriteTransferCount; internal ulong OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; internal IO_COUNTERS IoInfo; internal UIntPtr ProcessMemoryLimit; internal UIntPtr JobMemoryLimit; internal UIntPtr PeakProcessMemoryUsed; internal UIntPtr PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION { internal long TotalUserTime; internal long TotalKernelTime; internal long ThisPeriodTotalUserTime; internal long ThisPeriodTotalKernelTime; internal uint TotalPageFaultCount; internal uint TotalProcesses; internal uint ActiveProcesses; internal uint TotalTerminatedProcesses; }

    [DllImport("ntdll.dll")] private static extern int NtCreateFile(out SafeFileHandle fileHandle, uint desiredAccess, ref OBJECT_ATTRIBUTES objectAttributes, out IO_STATUS_BLOCK ioStatusBlock, IntPtr allocationSize, uint fileAttributes, uint shareAccess, uint createDisposition, uint createOptions, IntPtr eaBuffer, uint eaLength);
    [DllImport("ntdll.dll")] private static extern int NtQueryDirectoryFile(SafeFileHandle fileHandle, IntPtr eventHandle, IntPtr apcRoutine, IntPtr apcContext, out IO_STATUS_BLOCK ioStatusBlock, IntPtr fileInformation, uint length, int fileInformationClass, [MarshalAs(UnmanagedType.U1)] bool returnSingleEntry, IntPtr fileName, [MarshalAs(UnmanagedType.U1)] bool restartScan);
    [DllImport("ntdll.dll")] private static extern int NtSetInformationFile(SafeFileHandle fileHandle, out IO_STATUS_BLOCK ioStatusBlock, IntPtr fileInformation, uint length, int fileInformationClass);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int informationClass, out FILE_ID_INFO information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int informationClass, out FILE_ATTRIBUTE_TAG_INFO information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int informationClass, out FILE_STANDARD_INFO information, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern uint GetDriveTypeW(string rootPath);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(SafeFileHandle job, int informationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(SafeFileHandle job, int informationClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information, uint length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(SafeFileHandle job, int informationClass, IntPtr information, uint length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(SafeFileHandle job, SafeFileHandle process);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(SafeFileHandle thread);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(SafeFileHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetExitCodeProcess(SafeFileHandle process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(SafeFileHandle process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeFileHandle OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(SafeFileHandle process, SafeFileHandle job, out bool result);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DuplicateHandle(IntPtr sourceProcess, SafeFileHandle sourceHandle, IntPtr targetProcess, out SafeFileHandle targetHandle, uint desiredAccess, bool inheritHandle, uint options);

    internal static void Diagnostic(string value) {
      if (String.Equals(Environment.GetEnvironmentVariable("BHARATCODE_PRELIMINARY_CONTROLLER_TEST"), "1", StringComparison.Ordinal)) Console.WriteLine(value);
    }

    internal static string DescribeHandle(SafeFileHandle handle) {
      if (handle == null) return "handle:null";
      if (handle.IsClosed) return "handle:closed";
      if (handle.IsInvalid) return "handle:invalid";
      try {
        FILE_ATTRIBUTE_TAG_INFO tag;
        if (!GetFileInformationByHandleEx(handle, FILE_ATTRIBUTE_TAG_INFO_CLASS, out tag, (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO)))) throw new InvalidOperationException("attribute tag unavailable");
        var identity = Identity(handle);
        return "handle:0x" + handle.DangerousGetHandle().ToInt64().ToString("X") + ";attributes:0x" + tag.FileAttributes.ToString("X8") + ";reparse_tag:0x" + tag.ReparseTag.ToString("X8") + ";volume:0x" + identity.VolumeSerialNumber.ToString("X16") + ";file_id:" + identity.FileId.ToString("N") + ";path:" + FinalPath(handle);
      }
      catch (Exception error) { return "handle:0x" + handle.DangerousGetHandle().ToInt64().ToString("X") + ";diagnostic_error:" + error.Message; }
    }

    public static PreliminaryControllerLease Reserve(string runnerTemp, string runId, string runAttempt, string testNonce, string testFailpoint) {
      ValidatePositiveDecimal(runId);
      ValidatePositiveDecimal(runAttempt);
      var nonce = String.IsNullOrEmpty(testNonce) ? Hex(RandomBytes(32)) : testNonce;
      if (!System.Text.RegularExpressions.Regex.IsMatch(nonce, "^[0-9a-f]{64}$")) throw new InvalidOperationException("Preliminary namespace nonce is invalid");
      var leaf = "bharatcode-preliminary-unsigned-" + runId + "-" + runAttempt + "-" + nonce;
      DirectoryChainAuthority parent = null;
      SafeFileHandle root = null;
      try {
        parent = AcquireRunnerTempHandleRelative(runnerTemp);
        var parentPath = parent.FinalPath;
        var owner = WindowsIdentity.GetCurrent().User;
        if (owner == null) throw new InvalidOperationException("Preliminary controller owner is unavailable");
        root = CreateDirectoryRelative(parent.Handle, leaf, SecurityDescriptor(owner));
        ThrowTestFailpoint(testFailpoint, "after-create");
        var rootPath = Path.Combine(parentPath, leaf);
        var security = ValidateSecurity(rootPath, owner);
        ThrowTestFailpoint(testFailpoint, "after-dacl");
        var rootIdentity = Identity(root);
        ValidateHeldDirectory(root, Path.GetFullPath(rootPath), rootIdentity.VolumeSerialNumber, rootIdentity.FileId.ToByteArray());
        ThrowTestFailpoint(testFailpoint, "after-file-id");
        return new PreliminaryControllerLease(rootPath, parent, root, rootIdentity, owner, security, RandomBytes(32));
      }
      catch {
        if (root != null && !root.IsInvalid && !root.IsClosed) {
          try { DeleteChildrenHandleRelative(root); DeleteByHandle(root); } finally { root.Dispose(); }
        }
        if (parent != null) parent.Dispose();
        throw;
      }
    }

    internal static DirectoryChainAuthority AcquireRunnerTempHandleRelative(string input) { return AcquireDirectoryChain(input); }

    internal static DirectoryChainAuthority AcquireDirectoryChain(string input) {
      if (String.IsNullOrWhiteSpace(input) || input.StartsWith("\\\\", StringComparison.Ordinal) || input.StartsWith("\\\\?\\", StringComparison.Ordinal) || input.StartsWith("\\\\.\\", StringComparison.Ordinal)) throw new InvalidOperationException("Preliminary controller requires a non-device local path");
      var full = Normalize(input);
      if (full.IndexOf(':', 2) >= 0) throw new InvalidOperationException("Preliminary controller path contains an alternate data stream");
      var volume = Path.GetPathRoot(full);
      if (String.IsNullOrEmpty(volume) || GetDriveTypeW(volume) != DRIVE_FIXED) throw new InvalidOperationException("Preliminary controller requires DRIVE_FIXED");
      var chain = new List<HeldDirectory>();
      try {
        var current = OpenDirectory(volume, true);
        var volumeIdentity = Identity(current);
        var currentPath = Normalize(volume);
        if ((Attributes(current) & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || !String.Equals(FinalPath(current), currentPath, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Preliminary controller volume identity drift");
        chain.Add(new HeldDirectory(current, currentPath, volumeIdentity));
        foreach (var segment in full.Substring(volume.Length).Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries)) {
          var next = OpenRelative(current, segment, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE, FILE_OPEN, FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, null);
          try {
            var nextPath = Normalize(Path.Combine(currentPath, segment));
            if ((Attributes(next) & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw new InvalidOperationException("Preliminary controller ancestor is a reparse point");
            var identity = Identity(next);
            if (identity.VolumeSerialNumber != volumeIdentity.VolumeSerialNumber || !String.Equals(FinalPath(next), nextPath, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Preliminary controller ancestor identity drift");
            chain.Add(new HeldDirectory(next, nextPath, identity));
            current = next;
            currentPath = nextPath;
          }
          catch { next.Dispose(); throw; }
        }
        if (!String.Equals(FinalPath(current), full, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Preliminary controller RUNNER_TEMP final path drift");
        return new DirectoryChainAuthority(chain);
      }
      catch { for (var index = chain.Count - 1; index >= 0; index--) chain[index].Handle.Dispose(); throw; }
    }

    private static string ValidateRunnerTemp(string input) {
      using (var held = AcquireRunnerTempHandleRelative(input)) return held.FinalPath;
    }

    internal static void ValidateHeldDirectory(SafeFileHandle handle, string expectedPath, ulong expectedVolume, byte[] expectedFileId) {
      if ((Attributes(handle) & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw new InvalidOperationException("Preliminary held directory is a reparse point");
      var identity = Identity(handle);
      if (identity.VolumeSerialNumber != expectedVolume || !FixedEquals(identity.FileId.ToByteArray(), expectedFileId)) throw new InvalidOperationException("Preliminary held directory FILE_ID_INFO drift");
      if (!String.Equals(FinalPath(handle), Normalize(expectedPath), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Preliminary held directory final path drift");
    }

    internal static FILE_ID_INFO Identity(SafeFileHandle handle) {
      FILE_ID_INFO identity;
      if (!GetFileInformationByHandleEx(handle, FILE_ID_INFO_CLASS, out identity, (uint)Marshal.SizeOf(typeof(FILE_ID_INFO)))) throw new InvalidOperationException("Preliminary FILE_ID_INFO is unavailable");
      return identity;
    }

    internal static uint Attributes(SafeFileHandle handle) {
      FILE_ATTRIBUTE_TAG_INFO value;
      if (!GetFileInformationByHandleEx(handle, FILE_ATTRIBUTE_TAG_INFO_CLASS, out value, (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO)))) throw new InvalidOperationException("Preliminary file attributes are unavailable");
      return value.FileAttributes;
    }

    internal static uint LinkCount(SafeFileHandle handle) {
      FILE_STANDARD_INFO value;
      if (!GetFileInformationByHandleEx(handle, FILE_STANDARD_INFO_CLASS, out value, (uint)Marshal.SizeOf(typeof(FILE_STANDARD_INFO)))) throw new InvalidOperationException("Preliminary file standard information is unavailable");
      return value.NumberOfLinks;
    }

    internal static string FinalPath(SafeFileHandle handle) {
      var needed = GetFinalPathNameByHandleW(handle, null, 0, 0);
      if (needed == 0) throw new InvalidOperationException("Preliminary final path is unavailable");
      var buffer = new StringBuilder(checked((int)needed + 1));
      if (GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0) == 0) throw new InvalidOperationException("Preliminary final path is unavailable");
      var value = buffer.ToString();
      if (value.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) value = "\\\\" + value.Substring(8);
      else if (value.StartsWith("\\\\?\\", StringComparison.OrdinalIgnoreCase)) value = value.Substring(4);
      return Normalize(value);
    }

    internal static byte[] ValidateSecurity(string path, SecurityIdentifier expectedOwner) {
      var security = new DirectorySecurity(path, AccessControlSections.Owner | AccessControlSections.Access);
      if (!((SecurityIdentifier)security.GetOwner(typeof(SecurityIdentifier))).Equals(expectedOwner) || !security.AreAccessRulesProtected) throw new InvalidOperationException("Preliminary owner or protected DACL is invalid");
      var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
      var rules = security.GetAccessRules(true, false, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToArray();
      if (rules.Length != 2) throw new InvalidOperationException("Preliminary DACL is not closed");
      foreach (var identity in new[] { expectedOwner, system }) {
        var matches = rules.Where(rule => ((SecurityIdentifier)rule.IdentityReference).Equals(identity)).ToArray();
        if (matches.Length != 1 || matches[0].AccessControlType != AccessControlType.Allow || matches[0].FileSystemRights != FileSystemRights.FullControl || matches[0].IsInherited || matches[0].InheritanceFlags != (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit) || matches[0].PropagationFlags != PropagationFlags.None) throw new InvalidOperationException("Preliminary DACL rule is invalid");
      }
      var canonical = expectedOwner.Value + "|protected|" + String.Join("|", rules
        .OrderBy(rule => ((SecurityIdentifier)rule.IdentityReference).Value, StringComparer.Ordinal)
        .Select(rule => ((SecurityIdentifier)rule.IdentityReference).Value + ":" + ((int)rule.FileSystemRights).ToString() + ":" + ((int)rule.AccessControlType).ToString() + ":" + ((int)rule.InheritanceFlags).ToString() + ":" + ((int)rule.PropagationFlags).ToString()));
      using (var hash = SHA256.Create()) return hash.ComputeHash(Encoding.UTF8.GetBytes(canonical));
    }

    private static byte[] SecurityDescriptor(SecurityIdentifier owner) {
      var descriptor = new RawSecurityDescriptor("O:" + owner.Value + "G:" + owner.Value + "D:P(A;OICI;FA;;;" + owner.Value + ")(A;OICI;FA;;;SY)");
      var bytes = new byte[descriptor.BinaryLength];
      descriptor.GetBinaryForm(bytes, 0);
      return bytes;
    }

    private static SafeFileHandle CreateDirectoryRelative(SafeFileHandle parent, string leaf, byte[] securityDescriptor) {
      return OpenRelative(parent, leaf, GENERIC_ALL | SYNCHRONIZE, FILE_CREATE, FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, securityDescriptor);
    }

    internal static OwnedDirectoryAuthority CreateOwnedDirectory(SafeFileHandle root, string rootPath, string leaf) {
      var handle = CreateDirectoryRelative(root, leaf, null);
      try {
        if ((Attributes(handle) & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw new InvalidOperationException("Preliminary owned directory is a reparse point");
        var expected = Normalize(Path.Combine(rootPath, leaf));
        if (!String.Equals(FinalPath(handle), expected, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Preliminary owned directory final path drift");
        return new OwnedDirectoryAuthority(handle, expected);
      }
      catch { handle.Dispose(); throw; }
    }

    internal static PinnedFile CopyPinnedNew(PinnedFile source, OwnedDirectoryAuthority destination, string leaf) {
      source.Validate();
      destination.Validate();
      var handle = CreateFileRelative(destination.Handle, leaf);
      try {
        using (var input = StreamFromDuplicate(source.Handle, FileAccess.Read))
        using (var output = StreamFromDuplicate(handle, FileAccess.Write)) {
          input.Position = 0;
          output.Position = 0;
          input.CopyTo(output);
          output.Flush(true);
        }
        var expected = Normalize(Path.Combine(destination.FinalPath, leaf));
        if (!String.Equals(FinalPath(handle), expected, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Preliminary copied file final path drift");
        source.Validate();
        destination.Validate();
        return new PinnedFile(handle, Identity(handle), expected, destination);
      }
      catch { try { DeleteByHandle(handle); } catch {} handle.Dispose(); throw; }
    }

    internal static PinnedFile WriteNew(SafeFileHandle parent, string parentPath, string leaf, byte[] bytes) {
      var handle = CreateFileRelative(parent, leaf);
      try {
        using (var output = StreamFromDuplicate(handle, FileAccess.Write)) {
          output.Write(bytes, 0, bytes.Length);
          output.Flush(true);
        }
        var expected = Normalize(Path.Combine(parentPath, leaf));
        if (!String.Equals(FinalPath(handle), expected, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Preliminary written file final path drift");
        return new PinnedFile(handle, Identity(handle), expected);
      }
      catch { try { DeleteByHandle(handle); } catch {} handle.Dispose(); throw; }
    }

    internal static PinnedFile PinOwnedRelative(SafeFileHandle parent, string parentPath, string leaf) {
      var handle = OpenRelative(parent, leaf, GENERIC_READ | READ_CONTROL | SYNCHRONIZE, FILE_OPEN, FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, null, 0, FILE_SHARE_READ);
      try {
        if ((Attributes(handle) & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) throw new InvalidOperationException("Preliminary owned file identity is invalid");
        if (LinkCount(handle) != 1) throw new InvalidOperationException("Preliminary owned file link count is invalid");
        var expected = Normalize(Path.Combine(parentPath, leaf));
        if (!String.Equals(FinalPath(handle), expected, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Preliminary owned file final path drift");
        return new PinnedFile(handle, Identity(handle), expected);
      }
      catch { handle.Dispose(); throw; }
    }

    private static SafeFileHandle CreateFileRelative(SafeFileHandle parent, string leaf) {
      return OpenRelative(parent, leaf, GENERIC_READ | GENERIC_WRITE | READ_CONTROL | DELETE | SYNCHRONIZE, FILE_CREATE, FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, null, 0, FILE_SHARE_READ);
    }

    private static SafeFileHandle OpenRelative(SafeFileHandle parent, string name, uint access, uint disposition, uint options, byte[] securityDescriptor) {
      return OpenRelative(parent, name, access, disposition, options, securityDescriptor, disposition == FILE_CREATE ? FILE_ATTRIBUTE_DIRECTORY : 0u, FILE_SHARE_READ | FILE_SHARE_WRITE);
    }

    private static SafeFileHandle OpenRelative(SafeFileHandle parent, string name, uint access, uint disposition, uint options, byte[] securityDescriptor, uint fileAttributes, uint shareAccess) {
      if (String.IsNullOrEmpty(name) || name == "." || name == ".." || name.IndexOfAny(new[] { '\\', '/', ':' }) >= 0) throw new InvalidOperationException("Preliminary relative child name is invalid");
      var nameBuffer = Marshal.StringToHGlobalUni(name);
      var unicode = new UNICODE_STRING { Length = checked((ushort)(name.Length * 2)), MaximumLength = checked((ushort)((name.Length + 1) * 2)), Buffer = nameBuffer };
      var namePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
      GCHandle security = default(GCHandle);
      try {
        Marshal.StructureToPtr(unicode, namePointer, false);
        if (securityDescriptor != null) security = GCHandle.Alloc(securityDescriptor, GCHandleType.Pinned);
        var attributes = new OBJECT_ATTRIBUTES { Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)), RootDirectory = parent.DangerousGetHandle(), ObjectName = namePointer, Attributes = OBJ_CASE_INSENSITIVE, SecurityDescriptor = securityDescriptor == null ? IntPtr.Zero : security.AddrOfPinnedObject(), SecurityQualityOfService = IntPtr.Zero };
        IO_STATUS_BLOCK status;
        SafeFileHandle handle;
        var result = NtCreateFile(out handle, access, ref attributes, out status, IntPtr.Zero, fileAttributes, shareAccess, disposition, options, IntPtr.Zero, 0);
        if (result < 0 || handle == null || handle.IsInvalid) { if (handle != null) handle.Dispose(); throw new InvalidOperationException("Preliminary relative NtCreateFile failed with NTSTATUS 0x" + unchecked((uint)result).ToString("X8")); }
        return handle;
      }
      finally {
        if (security.IsAllocated) security.Free();
        Marshal.FreeHGlobal(namePointer);
        Marshal.FreeHGlobal(nameBuffer);
      }
    }

    private static SafeFileHandle OpenDirectory(string path, bool denyDelete) {
      var share = FILE_SHARE_READ | FILE_SHARE_WRITE | (denyDelete ? 0u : FILE_SHARE_DELETE);
      var handle = CreateFileW(path, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL, share, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
      if (handle == null || handle.IsInvalid) { if (handle != null) handle.Dispose(); throw new InvalidOperationException("Preliminary directory handle is unavailable"); }
      return handle;
    }

    internal static PinnedFile PinFile(string path, string requiredRoot) {
      var full = Path.GetFullPath(path);
      if (requiredRoot != null && !full.StartsWith(requiredRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Preliminary installed file escaped the root");
      var parent = AcquireDirectoryChain(Path.GetDirectoryName(full));
      var handle = CreateFileW(full, GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
      if (handle == null || handle.IsInvalid) { if (handle != null) handle.Dispose(); parent.Dispose(); throw new InvalidOperationException("Preliminary pinned file is unavailable"); }
      try {
        if ((Attributes(handle) & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) throw new InvalidOperationException("Preliminary pinned file identity is invalid");
        var finalPath = FinalPath(handle);
        if (!String.Equals(finalPath, Normalize(full), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Preliminary pinned file final path drift");
        return new PinnedFile(handle, Identity(handle), finalPath, parent);
      }
      catch { handle.Dispose(); parent.Dispose(); throw; }
    }

    internal static byte[] ContentIdentity(SafeFileHandle handle) {
      using (var stream = StreamFromDuplicate(handle, FileAccess.Read))
      using (var hash = SHA256.Create()) {
        stream.Position = 0;
        var digest = hash.ComputeHash(stream);
        var value = new byte[8 + digest.Length];
        Buffer.BlockCopy(BitConverter.GetBytes(stream.Length), 0, value, 0, 8);
        Buffer.BlockCopy(digest, 0, value, 8, digest.Length);
        return value;
      }
    }

    internal static byte[] ReadAllBytes(SafeFileHandle handle) {
      using (var stream = StreamFromDuplicate(handle, FileAccess.Read)) {
        stream.Position = 0;
        if (stream.Length > Int32.MaxValue) throw new InvalidOperationException("Preliminary held file is too large");
        var value = new byte[checked((int)stream.Length)];
        var offset = 0;
        while (offset < value.Length) {
          var count = stream.Read(value, offset, value.Length - offset);
          if (count == 0) throw new InvalidOperationException("Preliminary held file read ended early");
          offset += count;
        }
        return value;
      }
    }

    private static FileStream StreamFromDuplicate(SafeFileHandle handle, FileAccess access) {
      SafeFileHandle duplicate;
      var process = GetCurrentProcess();
      if (!DuplicateHandle(process, handle, process, out duplicate, 0, false, DUPLICATE_SAME_ACCESS) || duplicate == null || duplicate.IsInvalid) { if (duplicate != null) duplicate.Dispose(); throw new InvalidOperationException("Preliminary held file duplication failed"); }
      try { return new FileStream(duplicate, access, 65536, false); }
      catch { duplicate.Dispose(); throw; }
    }

    public static PublicationAuthority AcquirePublicationAuthority(string path) {
      var full = Path.GetFullPath(path);
      var leaf = Path.GetFileName(full);
      if (String.IsNullOrEmpty(leaf) || leaf == "." || leaf == ".." || leaf.IndexOfAny(new[] { '\\', '/', ':' }) >= 0) throw new InvalidOperationException("Preliminary receipt leaf is invalid");
      var parent = AcquireDirectoryChain(Path.GetDirectoryName(full));
      try {
        var authority = new PublicationAuthority(parent, leaf);
        authority.Validate();
        return authority;
      }
      catch { parent.Dispose(); throw; }
    }

    internal static bool RelativeEntryExists(SafeFileHandle parent, string leaf) {
      return DirectoryEntries(parent).Any(entry => String.Equals(entry.Name, leaf, StringComparison.OrdinalIgnoreCase));
    }

    internal static void PublishCreateNew(SafeFileHandle parent, string finalLeaf, byte[] bytes) {
      if (bytes == null) throw new InvalidOperationException("Preliminary receipt bytes are unavailable");
      var stageLeaf = ".bharatcode-preliminary-" + Guid.NewGuid().ToString("N") + ".tmp";
      var stage = CreateFileRelative(parent, stageLeaf);
      try {
        using (var output = StreamFromDuplicate(stage, FileAccess.Write)) {
          output.Write(bytes, 0, bytes.Length);
          output.Flush(true);
        }
        if (RelativeEntryExists(parent, finalLeaf)) throw new InvalidOperationException("Preliminary final receipt collision");
        RenameRelativeNoReplace(stage, parent, finalLeaf);
        if (RelativeEntryExists(parent, stageLeaf) || !RelativeEntryExists(parent, finalLeaf)) throw new InvalidOperationException("Preliminary receipt publication namespace drift");
      }
      catch (Exception primary) {
        try { DeleteByHandle(stage); }
        catch (Exception cleanup) { throw new AggregateException("Preliminary receipt publication and staging cleanup failed", primary, cleanup); }
        throw;
      }
      finally { stage.Dispose(); }
    }

    private static void RenameRelativeNoReplace(SafeFileHandle source, SafeFileHandle parent, string leaf) {
      var name = Encoding.Unicode.GetBytes(leaf);
      var rootOffset = IntPtr.Size == 8 ? 8 : 4;
      var lengthOffset = rootOffset + IntPtr.Size;
      var nameOffset = lengthOffset + 4;
      var pointer = Marshal.AllocHGlobal(checked(nameOffset + name.Length));
      try {
        for (var index = 0; index < nameOffset + name.Length; index++) Marshal.WriteByte(pointer, index, 0);
        Marshal.WriteInt32(pointer, 0, unchecked((int)FILE_RENAME_FLAG_POSIX_SEMANTICS));
        Marshal.WriteIntPtr(pointer, rootOffset, parent.DangerousGetHandle());
        Marshal.WriteInt32(pointer, lengthOffset, name.Length);
        Marshal.Copy(name, 0, IntPtr.Add(pointer, nameOffset), name.Length);
        IO_STATUS_BLOCK status;
        var result = NtSetInformationFile(source, out status, pointer, checked((uint)(nameOffset + name.Length)), FILE_RENAME_INFORMATION_EX);
        if (result < 0) throw new InvalidOperationException("Preliminary handle-relative receipt publication failed with NTSTATUS 0x" + unchecked((uint)result).ToString("X8"));
      }
      finally { Marshal.FreeHGlobal(pointer); }
    }

    internal static SafeFileHandle CreateKillOnCloseJob() {
      var job = CreateJobObjectW(IntPtr.Zero, null);
      if (job == null || job.IsInvalid) throw new InvalidOperationException("Preliminary unnamed job creation failed");
      var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if (!SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ref information, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) { job.Dispose(); throw new InvalidOperationException("Preliminary kill-on-close job configuration failed"); }
      return job;
    }

    internal static PreliminaryOwnedProcess StartSuspendedInJob(SafeFileHandle job, string application, string arguments, bool forceAssignmentFailure) {
      var executable = Path.GetFullPath(application);
      var startup = new STARTUPINFO { cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO)) };
      PROCESS_INFORMATION process;
      var command = new StringBuilder("\"" + executable.Replace("\"", "\\\"") + "\"" + (String.IsNullOrWhiteSpace(arguments) ? "" : " " + arguments));
      if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, null, ref startup, out process)) throw new InvalidOperationException("Preliminary suspended process creation failed");
      var processHandle = new SafeFileHandle(process.Process, true);
      var threadHandle = new SafeFileHandle(process.Thread, true);
      try {
          if (forceAssignmentFailure || !AssignProcessToJobObject(job, processHandle)) {
            LastAssignmentFailureProcessId = checked((int)process.ProcessId);
            var primary = new InvalidOperationException("Preliminary process job assignment failed");
            try { TerminateAndWait(processHandle, "assignment failure"); }
            catch (Exception cleanup) { throw new AggregateException("Preliminary assignment failure termination failed", primary, cleanup); }
            throw primary;
          }
          if (ResumeThread(threadHandle) == UInt32.MaxValue) {
            var primary = new InvalidOperationException("Preliminary process resume failed");
            try { TerminateAndWait(processHandle, "resume failure"); }
            catch (Exception cleanup) { throw new AggregateException("Preliminary resume failure termination failed", primary, cleanup); }
            throw primary;
          }
          return new PreliminaryOwnedProcess(processHandle, checked((int)process.ProcessId));
      }
      catch { processHandle.Dispose(); throw; }
      finally { threadHandle.Dispose(); }
    }

    private static void TerminateAndWait(SafeFileHandle process, string label) {
      if (!TerminateProcess(process, 1)) throw new InvalidOperationException("Preliminary " + label + " TerminateProcess failed");
      var wait = WaitForSingleObject(process, 20000);
      if (wait != WAIT_OBJECT_0) throw new InvalidOperationException("Preliminary " + label + " process termination wait failed");
    }


    internal static int JobProcessCount(SafeFileHandle job) {
      if (Interlocked.Exchange(ref failNextJobProcessCountForTest, 0) != 0) throw new InvalidOperationException("Injected preliminary post-termination Job count failure");
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information;
      if (!QueryInformationJobObject(job, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION, out information, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) throw new InvalidOperationException("Preliminary job membership is unavailable");
      return checked((int)information.ActiveProcesses);
    }

    internal static int[] JobProcessIds(SafeFileHandle job) {
      if (Interlocked.Exchange(ref failNextJobProcessIdsForTest, 0) != 0) throw new InvalidOperationException("Injected preliminary job membership diagnostic failure");
      var capacity = 256;
      while (capacity <= 65536) {
        var length = checked(8 + capacity * IntPtr.Size);
        var buffer = Marshal.AllocHGlobal(length);
        try {
          for (var offset = 0; offset < length; offset++) Marshal.WriteByte(buffer, offset, 0);
          var queried = QueryInformationJobObject(job, JOB_OBJECT_BASIC_PROCESS_ID_LIST, buffer, checked((uint)length), IntPtr.Zero);
          var assigned = Marshal.ReadInt32(buffer, 0);
          var present = Marshal.ReadInt32(buffer, 4);
          if ((!queried && Marshal.GetLastWin32Error() == ERROR_MORE_DATA) || assigned > present) {
            capacity = Math.Max(checked(capacity * 2), assigned);
            continue;
          }
          if (!queried || assigned != present || present < 0 || present > capacity) throw new InvalidOperationException("Preliminary job process identity list is unavailable or incomplete");
          var values = new int[present];
          for (var index = 0; index < present; index++) {
            var pointer = Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size);
            var value = pointer.ToInt64();
            if (value <= 0 || value > Int32.MaxValue) throw new InvalidOperationException("Preliminary job process identity is invalid");
            values[index] = checked((int)value);
          }
          return values;
        }
        finally { Marshal.FreeHGlobal(buffer); }
      }
      throw new InvalidOperationException("Preliminary job process identity list exceeds the defensive bound");
    }

    public static void FailNextJobProcessIdsForTest() {
      if (!String.Equals(Environment.GetEnvironmentVariable("BHARATCODE_PRELIMINARY_CONTROLLER_TEST"), "1", StringComparison.Ordinal)) throw new InvalidOperationException("Preliminary controller test authority is unavailable");
      Interlocked.Exchange(ref failNextJobProcessIdsForTest, 1);
    }

    public static void FailNextJobProcessCountForTest() {
      if (!String.Equals(Environment.GetEnvironmentVariable("BHARATCODE_PRELIMINARY_CONTROLLER_TEST"), "1", StringComparison.Ordinal)) throw new InvalidOperationException("Preliminary controller test authority is unavailable");
      Interlocked.Exchange(ref failNextJobProcessCountForTest, 1);
    }

    public static void FailNextTerminateJobForTest() {
      if (!String.Equals(Environment.GetEnvironmentVariable("BHARATCODE_PRELIMINARY_CONTROLLER_TEST"), "1", StringComparison.Ordinal)) throw new InvalidOperationException("Preliminary controller test authority is unavailable");
      Interlocked.Exchange(ref failNextTerminateJobForTest, 1);
    }

    internal static bool TerminateJobForStage(SafeFileHandle job, uint exitCode) {
      if (Interlocked.Exchange(ref failNextTerminateJobForTest, 0) != 0) return false;
      return TerminateJobObject(job, exitCode);
    }

    internal static void TerminateJobMembersIndividually(SafeFileHandle job, uint exitCode) {
      var deadline = DateTime.UtcNow.AddSeconds(20);
      while (DateTime.UtcNow < deadline) {
        var processIds = JobProcessIds(job);
        if (processIds.Length == 0) return;
        var handles = new List<SafeFileHandle>();
        try {
          foreach (var processId in processIds) {
            var handle = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, checked((uint)processId));
            if (handle == null || handle.IsInvalid) { if (handle != null) handle.Dispose(); continue; }
            bool stillInJob;
            if (!IsProcessInJob(handle, job, out stillInJob)) { handle.Dispose(); throw new InvalidOperationException("Preliminary fallback Job membership validation failed"); }
            if (!stillInJob) { handle.Dispose(); continue; }
            handles.Add(handle);
          }
          foreach (var handle in handles) {
            if (!TerminateProcess(handle, exitCode) && WaitForSingleObject(handle, 0) != WAIT_OBJECT_0) throw new InvalidOperationException("Preliminary fallback member termination failed");
          }
          foreach (var handle in handles) {
            if (WaitForSingleObject(handle, 20000) != WAIT_OBJECT_0) throw new InvalidOperationException("Preliminary fallback member termination wait failed");
          }
        }
        finally { foreach (var handle in handles) handle.Dispose(); }
      }
      throw new InvalidOperationException("Preliminary fallback Job member drain timed out");
    }

    internal static void DeleteChildrenHandleRelative(SafeFileHandle directory) {
      foreach (var child in DirectoryEntries(directory)) {
        using (var handle = OpenRelative(directory, child.Name, DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_OPEN, FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, null)) {
          var attributes = Attributes(handle);
          if ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 && (attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) DeleteChildrenHandleRelative(handle);
          DeleteByHandle(handle);
        }
      }
    }

    internal static void DeleteByHandle(SafeFileHandle handle) {
      var value = new FILE_DISPOSITION_INFO_EX { Flags = FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE };
      var pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO_EX)));
      try {
        Marshal.StructureToPtr(value, pointer, false);
        IO_STATUS_BLOCK status;
        var result = NtSetInformationFile(handle, out status, pointer, (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO_EX)), FILE_DISPOSITION_INFORMATION_EX);
        if (result < 0) throw new InvalidOperationException("Preliminary handle-relative deletion failed with NTSTATUS 0x" + unchecked((uint)result).ToString("X8") + "; " + DescribeHandle(handle));
      }
      finally { Marshal.FreeHGlobal(pointer); }
    }

    private sealed class DirectoryEntry { internal string Name; }
    private static IEnumerable<DirectoryEntry> DirectoryEntries(SafeFileHandle directory) {
      var entries = new List<DirectoryEntry>();
      var buffer = Marshal.AllocHGlobal(65536);
      try {
        var restart = true;
        while (true) {
          IO_STATUS_BLOCK status;
          var result = NtQueryDirectoryFile(directory, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out status, buffer, 65536, FILE_DIRECTORY_INFORMATION, false, IntPtr.Zero, restart);
          restart = false;
          if (result == STATUS_NO_MORE_FILES) break;
          if (result < 0) throw new InvalidOperationException("Preliminary handle-relative enumeration failed");
          var offset = 0;
          while (true) {
            var next = Marshal.ReadInt32(buffer, offset);
            var nameLength = Marshal.ReadInt32(buffer, offset + 60);
            var name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 64), nameLength / 2);
            if (name != "." && name != "..") entries.Add(new DirectoryEntry { Name = name });
            if (next == 0) break;
            offset += next;
          }
        }
      }
      finally { Marshal.FreeHGlobal(buffer); }
      return entries;
    }

    internal static bool ParentContainsName(SafeFileHandle parent, string name) { return DirectoryEntries(parent).Any(entry => String.Equals(entry.Name, name, StringComparison.OrdinalIgnoreCase)); }

    public static string[] PrefixEntries(string runnerTemp, string runId, string runAttempt) {
      ValidatePositiveDecimal(runId);
      ValidatePositiveDecimal(runAttempt);
      var prefix = "bharatcode-preliminary-unsigned-" + runId + "-" + runAttempt + "-";
      using (var parent = AcquireRunnerTempHandleRelative(runnerTemp)) return DirectoryEntries(parent.Handle).Where(entry => entry.Name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)).Select(entry => entry.Name).ToArray();
    }

    public static bool EntryExistsNoFollow(string path) {
      var handle = CreateFileW(Path.GetFullPath(path), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
      if (handle != null && !handle.IsInvalid) { handle.Dispose(); return true; }
      if (handle != null) handle.Dispose();
      var error = Marshal.GetLastWin32Error();
      if (error == 2 || error == 3) return false;
      throw new InvalidOperationException("Preliminary no-follow entry observation failed");
    }

    private static string Normalize(string path) {
      var full = Path.GetFullPath(path);
      var root = Path.GetPathRoot(full);
      return String.Equals(full, root, StringComparison.OrdinalIgnoreCase) ? root : full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }
    internal static bool FixedEquals(byte[] left, byte[] right) {
      if (left == null || right == null || left.Length != right.Length) return false;
      var difference = 0;
      for (var index = 0; index < left.Length; index++) difference |= left[index] ^ right[index];
      return difference == 0;
    }
    private static byte[] RandomBytes(int count) {
      var value = new byte[count];
      using (var generator = RandomNumberGenerator.Create()) generator.GetBytes(value);
      return value;
    }
    internal static string Hex(byte[] value) { return BitConverter.ToString(value).Replace("-", "").ToLowerInvariant(); }
    private static void ValidatePositiveDecimal(string value) { long parsed; if (String.IsNullOrEmpty(value) || value[0] == '0' || !Int64.TryParse(value, out parsed) || parsed <= 0 || value.Any(character => character < '0' || character > '9')) throw new InvalidOperationException("Preliminary run identity is invalid"); }
    private static void ThrowTestFailpoint(string actual, string expected) { if (!String.IsNullOrEmpty(actual) && String.Equals(actual, expected, StringComparison.Ordinal)) throw new InvalidOperationException("Injected preliminary controller failure"); }
  }
}
'@
}

function Assert-TestAuthority {
  if ($env:BHARATCODE_PRELIMINARY_CONTROLLER_TEST -ne "1") { throw "Preliminary controller test authority is unavailable" }
}

$script:PreliminaryReservationFailpoints = @("after-create", "after-dacl", "after-file-id")
$script:PreliminaryControllerBoundaries = @(
  "after-reservation", "after-installer-pin", "after-installer-launch", "after-installer-exit",
  "after-installer-stage", "after-installed-pin", "after-acceptance-directory", "after-contracts-directory",
  "after-inputs-directory", "after-adapter-copy", "after-adapter-pin", "after-validator-copy",
  "after-validator-pin", "after-frozen-harness-copy", "after-frozen-harness-pin",
  "after-runtime-manifest-copy", "after-runtime-manifest-pin", "after-runtime-copy", "after-runtime-pin",
  "after-evidence-write", "after-evidence-pin", "after-environment-binding", "after-harness-pin",
  "after-harness-launch", "after-harness-exit", "after-harness-stage", "after-receipt-pin",
  "after-receipt-read", "after-cleanup-before-publication"
)

function Assert-PreliminaryControllerTestHooks {
  param([hashtable]$TestHooks)
  if ($null -eq $TestHooks) { return }
  Assert-TestAuthority
  $allowed = @("Failpoint", "ForceHarnessAssignmentFailure", "ForceInstallerAssignmentFailure", "PauseAt", "ReadyPath", "UseInstalledDesktopAsHarness")
  foreach ($key in @($TestHooks.Keys)) {
    if ($key -isnot [string] -or $allowed -cnotcontains $key) { throw "Preliminary controller test hook is not closed" }
  }
  foreach ($key in @("ForceHarnessAssignmentFailure", "ForceInstallerAssignmentFailure", "UseInstalledDesktopAsHarness")) {
    if ($TestHooks.ContainsKey($key) -and $TestHooks[$key] -isnot [bool]) { throw "Preliminary controller test hook boolean is invalid" }
  }
  if ($TestHooks.ContainsKey("Failpoint")) {
    $failpoint = $TestHooks["Failpoint"]
    if ($failpoint -isnot [string] -or ($script:PreliminaryReservationFailpoints + $script:PreliminaryControllerBoundaries) -cnotcontains $failpoint) { throw "Preliminary controller failpoint is invalid" }
  }
  if ($TestHooks.ContainsKey("PauseAt")) {
    if ($TestHooks["PauseAt"] -cne "after-receipt-read" -or -not $TestHooks.ContainsKey("ReadyPath")) { throw "Preliminary controller crash boundary is invalid" }
    $ready = $TestHooks["ReadyPath"]
    if ($ready -isnot [string] -or [string]::IsNullOrWhiteSpace($ready) -or -not [IO.Path]::IsPathRooted($ready) -or $ready -match '[\r\n]') { throw "Preliminary controller crash ready path is invalid" }
  }
  elseif ($TestHooks.ContainsKey("ReadyPath")) { throw "Preliminary controller crash ready path is unbound" }
  if ($TestHooks.ContainsKey("Failpoint") -and $TestHooks.ContainsKey("PauseAt")) { throw "Preliminary controller test modes are ambiguous" }
  if (($TestHooks["ForceHarnessAssignmentFailure"] -or $TestHooks["PauseAt"]) -and -not $TestHooks["UseInstalledDesktopAsHarness"]) { throw "Preliminary controller harness test mode is unbound" }
}

function Assert-PreliminaryControllerScalars {
  param(
    [Parameter(Mandatory)][string]$RunnerTemp,
    [Parameter(Mandatory)][string]$RunId,
    [Parameter(Mandatory)][string]$RunAttempt,
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$ExpectedVersion,
    [Parameter(Mandatory)][string]$AdapterPath,
    [Parameter(Mandatory)][string]$ValidatorPath,
    [Parameter(Mandatory)][string]$FrozenHarnessPath,
    [Parameter(Mandatory)][string]$RuntimeManifestPath,
    [Parameter(Mandatory)][string]$RuntimePath,
    [Parameter(Mandatory)][string]$EvidenceScript,
    [Parameter(Mandatory)][string]$ReceiptPath
  )
  if ($RunId -notmatch '^[1-9][0-9]*$' -or $RunAttempt -notmatch '^[1-9][0-9]*$') { throw "Preliminary run identity is invalid" }
  if ([string]::IsNullOrEmpty($EvidenceScript) -or $EvidenceScript.IndexOf([char]0) -ge 0) { throw "Preliminary evidence script is invalid" }
  try { $null = [version]$ExpectedVersion }
  catch { throw "Preliminary expected version is invalid" }
  foreach ($path in @($RunnerTemp, $Installer, $AdapterPath, $ValidatorPath, $FrozenHarnessPath, $RuntimeManifestPath, $RuntimePath, $ReceiptPath)) {
    if ([string]::IsNullOrWhiteSpace($path) -or -not [IO.Path]::IsPathRooted($path) -or $path.StartsWith('\\') -or $path.StartsWith('\\?\') -or $path.StartsWith('\\.\') -or $path -match '[\r\n]') { throw "Preliminary controller scalar path is invalid" }
    $null = [IO.Path]::GetFullPath($path)
  }
}

function Test-PreliminaryControllerHook {
  param([hashtable]$TestHooks, [Parameter(Mandatory)][string]$Name)
  $null -ne $TestHooks -and $TestHooks.ContainsKey($Name) -and $TestHooks[$Name] -eq $true
}

function Invoke-PreliminaryControllerBoundary {
  param(
    [hashtable]$TestHooks,
    [Parameter(Mandatory)][string]$Boundary,
    [BharatCode.Preliminary.PreliminaryControllerLease]$Lease
  )
  if ($script:PreliminaryControllerBoundaries -cnotcontains $Boundary) { throw "Preliminary controller boundary is invalid" }
  if ($null -eq $TestHooks) { return }
  if ($TestHooks.ContainsKey("Failpoint") -and $TestHooks["Failpoint"] -ceq $Boundary) { throw "Injected preliminary controller failure at $Boundary" }
  if ($TestHooks.ContainsKey("PauseAt") -and $TestHooks["PauseAt"] -ceq $Boundary) {
    if (-not $Lease) { throw "Preliminary controller crash boundary lacks lease authority" }
    $readyPath = [IO.Path]::GetFullPath($TestHooks["ReadyPath"])
    $ready = [IO.File]::Open($readyPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Lease.RootPath)
      $ready.Write($bytes, 0, $bytes.Length)
      $ready.Flush($true)
    }
    finally { $ready.Dispose() }
    while ($true) { Start-Sleep -Seconds 60 }
  }
}

function Get-PreliminaryNamespaceLeaf {
  param([Parameter(Mandatory)][string]$RunId, [Parameter(Mandatory)][string]$RunAttempt, [Parameter(Mandatory)][string]$Nonce)
  if ($RunId -notmatch '^[1-9][0-9]*$' -or $RunAttempt -notmatch '^[1-9][0-9]*$' -or $Nonce -notmatch '^[0-9a-f]{64}$') { throw "Preliminary namespace leaf identity is invalid" }
  "bharatcode-preliminary-unsigned-$RunId-$RunAttempt-$Nonce"
}

function Test-PreliminaryEntryNoFollow {
  param([Parameter(Mandatory)][string]$Path)
  [BharatCode.Preliminary.PreliminaryControllerNative]::EntryExistsNoFollow($Path)
}

function New-PreliminaryControllerLease {
  param(
    [Parameter(Mandatory)][string]$RunnerTemp,
    [Parameter(Mandatory)][string]$RunId,
    [Parameter(Mandatory)][string]$RunAttempt,
    [string]$TestNonce = "",
    [string]$TestFailpoint = ""
  )
  if ($TestNonce -or $TestFailpoint) { Assert-TestAuthority }
  if ($TestFailpoint -and $script:PreliminaryReservationFailpoints -cnotcontains $TestFailpoint) { throw "Preliminary reservation failpoint is invalid" }
  [BharatCode.Preliminary.PreliminaryControllerNative]::Reserve($RunnerTemp, $RunId, $RunAttempt, $TestNonce, $TestFailpoint)
}

function Assert-PreliminaryNamespacePrefixAbsent {
  param([Parameter(Mandatory)][string]$RunnerTemp, [Parameter(Mandatory)][string]$RunId, [Parameter(Mandatory)][string]$RunAttempt)
  # Observation only: this function never recovers authority or deletes an orphan. A controller/runner crash
  # requires destruction and deregistration of the dedicated one-run JIT VM before this evidence can be retried.
  $entries = @([BharatCode.Preliminary.PreliminaryControllerNative]::PrefixEntries($RunnerTemp, $RunId, $RunAttempt))
  if ($entries.Count -ne 0) { throw "Preliminary namespace remains; destroy and deregister the disposable run-attempt VM" }
}

function Remove-PreliminaryControllerLease {
  param([Parameter(Mandatory)][BharatCode.Preliminary.PreliminaryControllerLease]$Lease)
  $primary = $null
  try { $Lease.CloseStage() } catch { $primary = $_.Exception }
  try { $Lease.DeleteOwnedTree() }
  catch {
    if ($primary) { throw [AggregateException]::new("Preliminary job and tree cleanup failed", @($primary, $_.Exception)) }
    throw
  }
  finally { $Lease.Dispose() }
  if ($primary) { throw $primary }
}

function Get-PreliminaryNsisArguments {
  param([Parameter(Mandatory)][string]$InstallRoot)
  $root = [IO.Path]::GetFullPath($InstallRoot)
  if ($root -match '["\r\n]' -or $root.EndsWith([IO.Path]::DirectorySeparatorChar)) { throw "Preliminary NSIS install root is invalid" }
  "/S /D=$root"
}

function Get-PreliminaryControllerTransactionPaths {
  param([Parameter(Mandatory)][BharatCode.Preliminary.PreliminaryControllerLease]$Lease)
  $Lease.Validate()
  [pscustomobject]@{
    AcceptanceDirectory = Join-Path $Lease.RootPath "acceptance"
    ContractsDirectory = Join-Path $Lease.RootPath "contracts"
    EvidenceScript = Join-Path $Lease.RootPath "evidence.mjs"
    Adapter = Join-Path $Lease.RootPath "contracts\wsl-windows-preliminary-acceptance.mjs"
    Validator = Join-Path $Lease.RootPath "contracts\lean-preliminary-unsigned-wsl.mjs"
    FrozenHarness = Join-Path $Lease.RootPath "contracts\wsl-windows-acceptance.mjs"
    InputsDirectory = Join-Path $Lease.RootPath "inputs"
    RuntimeManifest = Join-Path $Lease.RootPath "inputs\bharatcode-wsl-runtime-manifest.json"
    Runtime = Join-Path $Lease.RootPath "inputs\bharatcode-runtime-linux-x64-glibc"
    ReceiptCandidate = Join-Path $Lease.RootPath "receipt-candidate.json"
  }
}

function Copy-PreliminaryPinnedInput {
  param(
    [Parameter(Mandatory)][BharatCode.Preliminary.PreliminaryControllerLease]$Lease,
    [Parameter(Mandatory)][string]$Label,
    [Parameter(Mandatory)][string]$Destination,
    [Parameter(Mandatory)][string]$DirectoryLabel,
    [hashtable]$TestHooks,
    [Parameter(Mandatory)][string]$CopiedBoundary,
    [Parameter(Mandatory)][string]$PinnedBoundary
  )
  $destinationPath = [IO.Path]::GetFullPath($Destination)
  if ([BharatCode.Preliminary.PreliminaryControllerNative]::EntryExistsNoFollow($destinationPath)) { throw "Preliminary pinned input destination already exists" }
  $Lease.CopyPinnedNew("$Label-source", $Label, $DirectoryLabel, [IO.Path]::GetFileName($destinationPath))
  Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary $CopiedBoundary -Lease $Lease
  Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary $PinnedBoundary -Lease $Lease
  $destinationPath
}

function Invoke-PreliminaryController {
  param(
    [Parameter(Mandatory)][string]$RunnerTemp,
    [Parameter(Mandatory)][string]$RunId,
    [Parameter(Mandatory)][string]$RunAttempt,
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$ExpectedVersion,
    [Parameter(Mandatory)][string]$AdapterPath,
    [Parameter(Mandatory)][string]$ValidatorPath,
    [Parameter(Mandatory)][string]$FrozenHarnessPath,
    [Parameter(Mandatory)][string]$RuntimeManifestPath,
    [Parameter(Mandatory)][string]$RuntimePath,
    [Parameter(Mandatory)][string]$EvidenceScript,
    [Parameter(Mandatory)][string]$ReceiptPath,
    [hashtable]$TestHooks
  )
  Assert-PreliminaryControllerTestHooks -TestHooks $TestHooks
  Assert-PreliminaryControllerScalars -RunnerTemp $RunnerTemp -RunId $RunId -RunAttempt $RunAttempt -Installer $Installer -ExpectedVersion $ExpectedVersion -AdapterPath $AdapterPath -ValidatorPath $ValidatorPath -FrozenHarnessPath $FrozenHarnessPath -RuntimeManifestPath $RuntimeManifestPath -RuntimePath $RuntimePath -EvidenceScript $EvidenceScript -ReceiptPath $ReceiptPath
  $publication = $null
  $pinnedFiles = $null
  $lease = $null
  $primary = $null
  $cleanup = $null
  $receiptBytes = $null
  $scriptPath = $null
  $candidatePath = $null
  $installerPath = [IO.Path]::GetFullPath($Installer)
  $adapterSourcePath = [IO.Path]::GetFullPath($AdapterPath)
  $validatorSourcePath = [IO.Path]::GetFullPath($ValidatorPath)
  $frozenHarnessSourcePath = [IO.Path]::GetFullPath($FrozenHarnessPath)
  $runtimeManifestSourcePath = [IO.Path]::GetFullPath($RuntimeManifestPath)
  $runtimeSourcePath = [IO.Path]::GetFullPath($RuntimePath)
  $harnessPin = "bun"
  $harnessArguments = $null
  $useInstalledDesktopAsHarness = Test-PreliminaryControllerHook -TestHooks $TestHooks -Name "UseInstalledDesktopAsHarness"
  $environmentNames = @(
    "INSTALLED_DESKTOP_EXE", "UNSIGNED_INSTALLER_PATH", "PRELIMINARY_RECEIPT_CANDIDATE",
    "PRELIMINARY_ACCEPTANCE_DIR", "PRELIMINARY_ADAPTER", "PRELIMINARY_VALIDATOR",
    "PRELIMINARY_FROZEN_HARNESS", "PRELIMINARY_RUNTIME_MANIFEST", "PRELIMINARY_RUNTIME",
    "PRELIMINARY_EVIDENCE_SCRIPT"
  )
  $originalEnvironment = @{}
  foreach ($name in $environmentNames) { $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process) }
  $reservationFailpoint = ""
  if ($null -ne $TestHooks -and $TestHooks.ContainsKey("Failpoint") -and $script:PreliminaryReservationFailpoints -ccontains $TestHooks["Failpoint"]) {
    $reservationFailpoint = $TestHooks["Failpoint"]
  }
  try {
    $publication = [BharatCode.Preliminary.PreliminaryControllerNative]::AcquirePublicationAuthority($ReceiptPath)
    $pinnedFiles = [BharatCode.Preliminary.PinnedFileAuthority]::new()
    $pinnedFiles.PinExternal("installer", $installerPath)
    $pinnedFiles.PinExternal("adapter-source", $adapterSourcePath)
    $pinnedFiles.PinExternal("validator-source", $validatorSourcePath)
    $pinnedFiles.PinExternal("frozen-harness-source", $frozenHarnessSourcePath)
    $pinnedFiles.PinExternal("runtime-manifest-source", $runtimeManifestSourcePath)
    $pinnedFiles.PinExternal("runtime-source", $runtimeSourcePath)
    if (-not $useInstalledDesktopAsHarness) {
      $bunPath = (Get-Command bun -CommandType Application).Source
      $pinnedFiles.PinExternal("bun", $bunPath)
    }
    $signature = Get-AuthenticodeSignature $installerPath
    if ($signature.Status -ne "NotSigned" -or $signature.SignerCertificate -or $signature.TimeStamperCertificate) { throw "Preliminary installer signature identity drift" }
    Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-installer-pin"
    $lease = New-PreliminaryControllerLease -RunnerTemp $RunnerTemp -RunId $RunId -RunAttempt $RunAttempt -TestFailpoint $reservationFailpoint
    $lease.AttachPinnedFiles($pinnedFiles)
    Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-reservation" -Lease $lease
    $paths = Get-PreliminaryControllerTransactionPaths -Lease $lease
    $installArguments = Get-PreliminaryNsisArguments -InstallRoot $lease.RootPath
    $lease.BeginStage("installer")
    try {
      $install = $lease.StartOwnedProcess("installer", $installArguments, (Test-PreliminaryControllerHook -TestHooks $TestHooks -Name "ForceInstallerAssignmentFailure"))
      Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-installer-launch" -Lease $lease
      if ($install.WaitForExit(180000) -ne 0) { throw "Preliminary NSIS install failed" }
      Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-installer-exit" -Lease $lease
    }
    finally { $lease.CloseStage() }
    $lease.AssertNoOwnedProcesses()
    Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-installer-stage" -Lease $lease
    $installed = Join-Path $lease.RootPath "BharatCode Beta.exe"
    if (-not [IO.File]::Exists($installed)) { throw "Installed preliminary Desktop is missing" }
    $lease.PinOwnedRelative("installed", "BharatCode Beta.exe")
    $installedSignature = Get-AuthenticodeSignature $installed
    if ($installedSignature.Status -ne "NotSigned" -or $installedSignature.SignerCertificate -or $installedSignature.TimeStamperCertificate) { throw "Installed preliminary Desktop must remain unsigned" }
    if ([version](Get-Item -LiteralPath $installed).VersionInfo.ProductVersion -ne [version]$ExpectedVersion) { throw "Installed preliminary Desktop version drift" }
    Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-installed-pin" -Lease $lease
    $scriptPath = $paths.EvidenceScript
    $candidatePath = $paths.ReceiptCandidate
    $lease.CreateOwnedDirectory("acceptance", "acceptance")
    Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-acceptance-directory" -Lease $lease
    $lease.CreateOwnedDirectory("contracts", "contracts")
    Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-contracts-directory" -Lease $lease
    $lease.CreateOwnedDirectory("inputs", "inputs")
    Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-inputs-directory" -Lease $lease
    $adapter = Copy-PreliminaryPinnedInput -Lease $lease -Label "adapter" -Destination $paths.Adapter -DirectoryLabel "contracts" -TestHooks $TestHooks -CopiedBoundary "after-adapter-copy" -PinnedBoundary "after-adapter-pin"
    $validator = Copy-PreliminaryPinnedInput -Lease $lease -Label "validator" -Destination $paths.Validator -DirectoryLabel "contracts" -TestHooks $TestHooks -CopiedBoundary "after-validator-copy" -PinnedBoundary "after-validator-pin"
    $frozenHarness = Copy-PreliminaryPinnedInput -Lease $lease -Label "frozen-harness" -Destination $paths.FrozenHarness -DirectoryLabel "contracts" -TestHooks $TestHooks -CopiedBoundary "after-frozen-harness-copy" -PinnedBoundary "after-frozen-harness-pin"
    $runtimeManifest = Copy-PreliminaryPinnedInput -Lease $lease -Label "runtime-manifest" -Destination $paths.RuntimeManifest -DirectoryLabel "inputs" -TestHooks $TestHooks -CopiedBoundary "after-runtime-manifest-copy" -PinnedBoundary "after-runtime-manifest-pin"
    $runtime = Copy-PreliminaryPinnedInput -Lease $lease -Label "runtime" -Destination $paths.Runtime -DirectoryLabel "inputs" -TestHooks $TestHooks -CopiedBoundary "after-runtime-copy" -PinnedBoundary "after-runtime-pin"
    $scriptBytes = [Text.UTF8Encoding]::new($false).GetBytes($EvidenceScript)
    $lease.WriteNew("evidence-script", "evidence.mjs", $scriptBytes)
    Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-evidence-write" -Lease $lease
    Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-evidence-pin" -Lease $lease
    $env:INSTALLED_DESKTOP_EXE = $installed
    $env:UNSIGNED_INSTALLER_PATH = $installerPath
    $env:PRELIMINARY_RECEIPT_CANDIDATE = $candidatePath
    $env:PRELIMINARY_ACCEPTANCE_DIR = $paths.AcceptanceDirectory
    $env:PRELIMINARY_ADAPTER = $adapter
    $env:PRELIMINARY_VALIDATOR = $validator
    $env:PRELIMINARY_FROZEN_HARNESS = $frozenHarness
    $env:PRELIMINARY_RUNTIME_MANIFEST = $runtimeManifest
    $env:PRELIMINARY_RUNTIME = $runtime
    $env:PRELIMINARY_EVIDENCE_SCRIPT = $scriptPath
    Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-environment-binding" -Lease $lease
    $harnessArguments = "`"$scriptPath`""
    if ($useInstalledDesktopAsHarness) {
      $harnessPin = "installed"
      $harnessArguments = "--harness"
    }
    Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-harness-pin" -Lease $lease
    $lease.BeginStage("harness")
    try {
      $harness = $lease.StartOwnedProcess($harnessPin, $harnessArguments, (Test-PreliminaryControllerHook -TestHooks $TestHooks -Name "ForceHarnessAssignmentFailure"))
      Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-harness-launch" -Lease $lease
      if ($harness.WaitForExit(900000) -ne 0) { throw "Preliminary WSL harness failed" }
      Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-harness-exit" -Lease $lease
    }
    finally { $lease.CloseStage() }
    $lease.AssertNoOwnedProcesses()
    Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-harness-stage" -Lease $lease
    $lease.PinOwnedRelative("receipt-candidate", "receipt-candidate.json")
    Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-receipt-pin" -Lease $lease
    $receiptBytes = $lease.PinnedBytes("receipt-candidate")
    Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-receipt-read" -Lease $lease
  }
  catch { $primary = $_.Exception }
  finally {
    $cleanupErrors = [Collections.Generic.List[Exception]]::new()
    foreach ($name in $environmentNames) {
      try { [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], [EnvironmentVariableTarget]::Process) }
      catch { [void]$cleanupErrors.Add($_.Exception) }
    }
    if ($lease) {
      try { Remove-PreliminaryControllerLease -Lease $lease }
      catch { [void]$cleanupErrors.Add($_.Exception) }
    }
    if ($cleanupErrors.Count -eq 1) { $cleanup = $cleanupErrors[0] }
    elseif ($cleanupErrors.Count -gt 1) { $cleanup = [AggregateException]::new("Preliminary cleanup failures", [Exception[]]$cleanupErrors.ToArray()) }
  }
  if ($primary -or $cleanup) {
    if ($publication) { $publication.Dispose() }
    if ($pinnedFiles) { $pinnedFiles.Dispose() }
    if ($primary -and $cleanup) { throw [AggregateException]::new("Preliminary controller and cleanup failed", @($primary, $cleanup)) }
    if ($primary) { throw $primary }
    throw $cleanup
  }
  try {
    Invoke-PreliminaryControllerBoundary -TestHooks $TestHooks -Boundary "after-cleanup-before-publication"
    $publication.PublishCreateNew($receiptBytes)
  }
  finally {
    $publication.Dispose()
    $pinnedFiles.Dispose()
  }
}
