param(
  [ValidateSet("Library", "CrashProbe")][string]$Mode = "Library",
  [string]$RunnerTemp = "",
  [string]$RunId = "",
  [string]$RunAttempt = "",
  [string]$ReadyPath = "",
  [string]$ReceiptPath = ""
)

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
      if (wait == PreliminaryControllerNative.WAIT_TIMEOUT) throw new TimeoutException("Preliminary owned process timed out");
      if (wait != PreliminaryControllerNative.WAIT_OBJECT_0) throw new InvalidOperationException("Preliminary owned process wait failed");
      uint exitCode;
      if (!PreliminaryControllerNative.GetExitCodeProcess(processHandle, out exitCode)) throw new InvalidOperationException("Preliminary owned process result is unavailable");
      return unchecked((int)exitCode);
    }
    public void Dispose() { if (processHandle != null) processHandle.Dispose(); processHandle = null; }
  }

  internal sealed class PinnedFile : IDisposable {
    internal readonly SafeFileHandle Handle;
    internal readonly ulong VolumeSerialNumber;
    internal readonly byte[] FileId;
    internal readonly string FinalPath;
    internal readonly string SourcePath;
    internal readonly byte[] ContentIdentity;
    internal PinnedFile(SafeFileHandle handle, PreliminaryControllerNative.FILE_ID_INFO identity, string finalPath, string sourcePath) {
      Handle = handle;
      VolumeSerialNumber = identity.VolumeSerialNumber;
      FileId = identity.FileId.ToByteArray();
      FinalPath = finalPath;
      SourcePath = sourcePath;
      ContentIdentity = PreliminaryControllerNative.ContentIdentity(sourcePath);
    }
    internal void Validate() {
      var identity = PreliminaryControllerNative.Identity(Handle);
      if (identity.VolumeSerialNumber != VolumeSerialNumber || !PreliminaryControllerNative.FixedEquals(identity.FileId.ToByteArray(), FileId)) throw new InvalidOperationException("Preliminary pinned file ID drift");
      if (!String.Equals(PreliminaryControllerNative.FinalPath(Handle), FinalPath, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Preliminary pinned file final path drift");
      if ((PreliminaryControllerNative.Attributes(Handle) & PreliminaryControllerNative.FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw new InvalidOperationException("Preliminary pinned file became a reparse point");
      if (!PreliminaryControllerNative.FixedEquals(PreliminaryControllerNative.ContentIdentity(SourcePath), ContentIdentity)) throw new InvalidOperationException("Preliminary pinned file content drift");
    }
    public void Dispose() { Handle.Dispose(); }
  }

  public sealed class PreliminaryControllerLease : IDisposable {
    private readonly SafeFileHandle parentHandle;
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
    private readonly Dictionary<string, PinnedFile> pins = new Dictionary<string, PinnedFile>(StringComparer.Ordinal);
    private readonly List<PreliminaryOwnedProcess> processes = new List<PreliminaryOwnedProcess>();
    private bool deleted;
    private bool jobClosed;
    public string RootPath { get; private set; }
    public string RootLeaf { get; private set; }

    internal PreliminaryControllerLease(string rootPath, SafeFileHandle parent, SafeFileHandle root, PreliminaryControllerNative.FILE_ID_INFO parentIdentity, PreliminaryControllerNative.FILE_ID_INFO rootIdentity, SecurityIdentifier owner, byte[] securityDigest, byte[] secret) {
      RootPath = rootPath;
      RootLeaf = Path.GetFileName(rootPath);
      parentHandle = parent;
      rootHandle = root;
      expectedParentFinalPath = PreliminaryControllerNative.FinalPath(parent);
      expectedParentVolumeSerial = parentIdentity.VolumeSerialNumber;
      expectedParentFileId = parentIdentity.FileId.ToByteArray();
      expectedFinalPath = PreliminaryControllerNative.FinalPath(root);
      expectedVolumeSerial = rootIdentity.VolumeSerialNumber;
      expectedFileId = rootIdentity.FileId.ToByteArray();
      expectedOwner = owner;
      expectedSecurityDigest = securityDigest;
      capability = secret;
      sealedCapability = (byte[])secret.Clone();
      jobHandle = PreliminaryControllerNative.CreateKillOnCloseJob();
    }

    public void Validate() {
      if (deleted || rootHandle == null || rootHandle.IsInvalid || rootHandle.IsClosed || !PreliminaryControllerNative.FixedEquals(capability, sealedCapability)) throw new InvalidOperationException("Preliminary controller capability is unavailable");
      PreliminaryControllerNative.ValidateHeldDirectory(parentHandle, expectedParentFinalPath, expectedParentVolumeSerial, expectedParentFileId);
      PreliminaryControllerNative.ValidateHeldDirectory(rootHandle, expectedFinalPath, expectedVolumeSerial, expectedFileId);
      var security = PreliminaryControllerNative.ValidateSecurity(RootPath, expectedOwner);
      if (!PreliminaryControllerNative.FixedEquals(security, expectedSecurityDigest)) throw new InvalidOperationException("Preliminary root DACL drift");
    }

    public void PinInstaller(string path) { Pin(path, "installer", false); }
    public void PinInstalledDesktop(string path) { Pin(path, "installed", true); }
    private void Pin(string path, string label, bool requireRoot) {
      Validate();
      if (pins.ContainsKey(label)) throw new InvalidOperationException("Preliminary pin already exists");
      pins.Add(label, PreliminaryControllerNative.PinFile(path, requireRoot ? RootPath : null));
    }

    public PreliminaryOwnedProcess StartOwnedProcess(string application, string arguments) {
      Validate();
      if (jobClosed || jobHandle == null || jobHandle.IsClosed || jobHandle.IsInvalid) throw new InvalidOperationException("Preliminary job is unavailable");
      var process = PreliminaryControllerNative.StartSuspendedInJob(jobHandle, application, arguments);
      processes.Add(process);
      return process;
    }

    public int JobProcessCount { get { return jobClosed ? 0 : PreliminaryControllerNative.JobProcessCount(jobHandle); } }
    public int[] JobProcessIds { get { return jobClosed ? new int[0] : PreliminaryControllerNative.JobProcessIds(jobHandle); } }

    public void CloseJob() {
      if (jobClosed) return;
      if (!PreliminaryControllerNative.TerminateJobObject(jobHandle, 1)) throw new InvalidOperationException("Preliminary job termination failed");
      var deadline = DateTime.UtcNow.AddSeconds(20);
      while (PreliminaryControllerNative.JobProcessIds(jobHandle).Length != 0 && DateTime.UtcNow < deadline) Thread.Sleep(50);
      if (PreliminaryControllerNative.JobProcessIds(jobHandle).Length != 0 || PreliminaryControllerNative.JobProcessCount(jobHandle) != 0) throw new InvalidOperationException("Preliminary job children survived termination");
      foreach (var process in processes) process.Dispose();
      processes.Clear();
      jobHandle.Dispose();
      jobClosed = true;
    }

    public void DeleteOwnedTree() {
      Validate();
      if (!jobClosed || JobProcessCount != 0) throw new InvalidOperationException("Preliminary job is not empty");
      foreach (var pin in pins.Values) pin.Validate();
      foreach (var pin in pins.Values) pin.Dispose();
      pins.Clear();
      PreliminaryControllerNative.DeleteChildrenHandleRelative(rootHandle);
      PreliminaryControllerNative.DeleteByHandle(rootHandle);
      rootHandle.Dispose();
      rootHandle = null;
      deleted = true;
      if (PreliminaryControllerNative.ParentContainsName(parentHandle, RootLeaf)) throw new InvalidOperationException("Preliminary root child survived cleanup");
    }

    public void Dispose() {
      foreach (var pin in pins.Values) pin.Dispose();
      pins.Clear();
      foreach (var process in processes) process.Dispose();
      processes.Clear();
      if (jobHandle != null) jobHandle.Dispose();
      if (rootHandle != null) rootHandle.Dispose();
      parentHandle.Dispose();
    }
  }

  public static class PreliminaryControllerNative {
    public const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_LIST_DIRECTORY = 0x00000001;
    private const uint READ_CONTROL = 0x00020000;
    private const uint DELETE = 0x00010000;
    private const uint GENERIC_ALL = 0x10000000;
    private const uint GENERIC_READ = 0x80000000;
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
    private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
    private const uint FILE_OPEN_REPARSE_POINT = 0x00200000;
    private const uint OBJ_CASE_INSENSITIVE = 0x00000040;
    private const int FILE_ID_INFO_CLASS = 18;
    private const int FILE_ATTRIBUTE_TAG_INFO_CLASS = 9;
    private const int FILE_DIRECTORY_INFORMATION = 1;
    private const int FILE_DISPOSITION_INFORMATION_EX = 64;
    private const uint FILE_DISPOSITION_FLAG_DELETE = 0x00000001;
    private const uint FILE_DISPOSITION_FLAG_POSIX_SEMANTICS = 0x00000002;
    private const uint FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE = 0x00000010;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
    private const int JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
    private const int JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
    private const uint DRIVE_FIXED = 3;
    internal const uint WAIT_OBJECT_0 = 0;
    internal const uint WAIT_TIMEOUT = 258;
    private const int STATUS_NO_MORE_FILES = unchecked((int)0x80000006);

    [StructLayout(LayoutKind.Sequential)] internal struct UNICODE_STRING { internal ushort Length; internal ushort MaximumLength; internal IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] internal struct OBJECT_ATTRIBUTES { internal int Length; internal IntPtr RootDirectory; internal IntPtr ObjectName; internal uint Attributes; internal IntPtr SecurityDescriptor; internal IntPtr SecurityQualityOfService; }
    [StructLayout(LayoutKind.Sequential)] internal struct IO_STATUS_BLOCK { internal IntPtr Status; internal UIntPtr Information; }
    [StructLayout(LayoutKind.Sequential)] internal struct FILE_DISPOSITION_INFO_EX { internal uint Flags; }
    [StructLayout(LayoutKind.Sequential)] internal struct FILE_ATTRIBUTE_TAG_INFO { internal uint FileAttributes; internal uint ReparseTag; }
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

    public static PreliminaryControllerLease Reserve(string runnerTemp, string runId, string runAttempt, string testNonce, string testFailpoint) {
      var parentPath = ValidateRunnerTemp(runnerTemp);
      ValidatePositiveDecimal(runId);
      ValidatePositiveDecimal(runAttempt);
      var nonce = String.IsNullOrEmpty(testNonce) ? Hex(RandomBytes(32)) : testNonce;
      if (!System.Text.RegularExpressions.Regex.IsMatch(nonce, "^[0-9a-f]{64}$")) throw new InvalidOperationException("Preliminary namespace nonce is invalid");
      var leaf = "bharatcode-preliminary-unsigned-" + runId + "-" + runAttempt + "-" + nonce;
      SafeFileHandle parent = null;
      SafeFileHandle root = null;
      try {
        parent = OpenDirectory(parentPath, true);
        var parentIdentity = Identity(parent);
        var owner = WindowsIdentity.GetCurrent().User;
        if (owner == null) throw new InvalidOperationException("Preliminary controller owner is unavailable");
        root = CreateDirectoryRelative(parent, leaf, SecurityDescriptor(owner));
        ThrowTestFailpoint(testFailpoint, "after-create");
        var rootPath = Path.Combine(parentPath, leaf);
        var security = ValidateSecurity(rootPath, owner);
        ThrowTestFailpoint(testFailpoint, "after-dacl");
        var rootIdentity = Identity(root);
        ValidateHeldDirectory(root, Path.GetFullPath(rootPath), rootIdentity.VolumeSerialNumber, rootIdentity.FileId.ToByteArray());
        ThrowTestFailpoint(testFailpoint, "after-file-id");
        return new PreliminaryControllerLease(rootPath, parent, root, parentIdentity, rootIdentity, owner, security, RandomBytes(32));
      }
      catch {
        if (root != null && !root.IsInvalid && !root.IsClosed) {
          try { DeleteChildrenHandleRelative(root); DeleteByHandle(root); } finally { root.Dispose(); }
        }
        if (parent != null) parent.Dispose();
        throw;
      }
    }

    private static string ValidateRunnerTemp(string input) {
      if (String.IsNullOrWhiteSpace(input) || input.StartsWith("\\\\", StringComparison.Ordinal) || input.StartsWith("\\\\?\\", StringComparison.Ordinal) || input.StartsWith("\\\\.\\", StringComparison.Ordinal)) throw new InvalidOperationException("Preliminary controller requires a non-device local path");
      var full = Path.GetFullPath(input).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
      if (full.IndexOf(':', 2) >= 0) throw new InvalidOperationException("Preliminary controller path contains an alternate data stream");
      var volume = Path.GetPathRoot(full);
      if (String.IsNullOrEmpty(volume) || GetDriveTypeW(volume) != DRIVE_FIXED) throw new InvalidOperationException("Preliminary controller requires DRIVE_FIXED");
      foreach (var ancestor in Ancestors(full)) {
        using (var handle = OpenDirectory(ancestor, false)) {
          if ((Attributes(handle) & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw new InvalidOperationException("Preliminary controller ancestor is a reparse point");
          if (!String.Equals(FinalPath(handle), Normalize(ancestor), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Preliminary controller ancestor final path drift");
        }
      }
      return full;
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

    private static SafeFileHandle OpenRelative(SafeFileHandle parent, string name, uint access, uint disposition, uint options, byte[] securityDescriptor) {
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
        var fileAttributes = disposition == FILE_CREATE ? FILE_ATTRIBUTE_DIRECTORY : 0u;
        var result = NtCreateFile(out handle, access, ref attributes, out status, IntPtr.Zero, fileAttributes, FILE_SHARE_READ | FILE_SHARE_WRITE, disposition, options, IntPtr.Zero, 0);
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
      ValidateRunnerTemp(Path.GetDirectoryName(full));
      var handle = CreateFileW(full, GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
      if (handle == null || handle.IsInvalid) { if (handle != null) handle.Dispose(); throw new InvalidOperationException("Preliminary pinned file is unavailable"); }
      try {
        if ((Attributes(handle) & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) throw new InvalidOperationException("Preliminary pinned file identity is invalid");
        var finalPath = FinalPath(handle);
        if (!String.Equals(finalPath, Normalize(full), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Preliminary pinned file final path drift");
        return new PinnedFile(handle, Identity(handle), finalPath, full);
      }
      catch { handle.Dispose(); throw; }
    }

    internal static byte[] ContentIdentity(string path) {
      using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
      using (var hash = SHA256.Create()) {
        stream.Position = 0;
        var digest = hash.ComputeHash(stream);
        var value = new byte[8 + digest.Length];
        Buffer.BlockCopy(BitConverter.GetBytes(stream.Length), 0, value, 0, 8);
        Buffer.BlockCopy(digest, 0, value, 8, digest.Length);
        return value;
      }
    }

    internal static SafeFileHandle CreateKillOnCloseJob() {
      var job = CreateJobObjectW(IntPtr.Zero, null);
      if (job == null || job.IsInvalid) throw new InvalidOperationException("Preliminary unnamed job creation failed");
      var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if (!SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ref information, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) { job.Dispose(); throw new InvalidOperationException("Preliminary kill-on-close job configuration failed"); }
      return job;
    }

    internal static PreliminaryOwnedProcess StartSuspendedInJob(SafeFileHandle job, string application, string arguments) {
      var executable = Path.GetFullPath(application);
      using (var pin = PinFile(executable, null)) {
        var startup = new STARTUPINFO { cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO)) };
        PROCESS_INFORMATION process;
        var command = new StringBuilder("\"" + executable.Replace("\"", "\\\"") + "\"" + (String.IsNullOrWhiteSpace(arguments) ? "" : " " + arguments));
        if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, null, ref startup, out process)) throw new InvalidOperationException("Preliminary suspended process creation failed");
        var processHandle = new SafeFileHandle(process.Process, true);
        var threadHandle = new SafeFileHandle(process.Thread, true);
        try {
          if (!AssignProcessToJobObject(job, processHandle)) { TerminateProcess(processHandle, 1); throw new InvalidOperationException("Preliminary process job assignment failed"); }
          if (ResumeThread(threadHandle) == UInt32.MaxValue) { TerminateProcess(processHandle, 1); throw new InvalidOperationException("Preliminary process resume failed"); }
          return new PreliminaryOwnedProcess(processHandle, checked((int)process.ProcessId));
        }
        catch { processHandle.Dispose(); throw; }
        finally { threadHandle.Dispose(); }
      }
    }


    internal static int JobProcessCount(SafeFileHandle job) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information;
      if (!QueryInformationJobObject(job, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION, out information, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) throw new InvalidOperationException("Preliminary job membership is unavailable");
      return checked((int)information.ActiveProcesses);
    }

    internal static int[] JobProcessIds(SafeFileHandle job) {
      var capacity = 256;
      var length = checked(8 + capacity * IntPtr.Size);
      var buffer = Marshal.AllocHGlobal(length);
      try {
        if (!QueryInformationJobObject(job, JOB_OBJECT_BASIC_PROCESS_ID_LIST, buffer, checked((uint)length), IntPtr.Zero)) throw new InvalidOperationException("Preliminary job process identity list is unavailable");
        var assigned = Marshal.ReadInt32(buffer, 0);
        var present = Marshal.ReadInt32(buffer, 4);
        if (assigned != present || present < 0 || present > capacity) throw new InvalidOperationException("Preliminary job process identity list is incomplete");
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
        if (NtSetInformationFile(handle, out status, pointer, (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO_EX)), FILE_DISPOSITION_INFORMATION_EX) < 0) throw new InvalidOperationException("Preliminary handle-relative deletion failed");
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

    internal static bool ParentContainsName(SafeFileHandle parent, string name) { return DirectoryEntries(parent).Any(entry => String.Equals(entry.Name, name, StringComparison.Ordinal)); }

    public static string[] PrefixEntries(string runnerTemp, string runId, string runAttempt) {
      var parent = ValidateRunnerTemp(runnerTemp);
      ValidatePositiveDecimal(runId);
      ValidatePositiveDecimal(runAttempt);
      var prefix = "bharatcode-preliminary-unsigned-" + runId + "-" + runAttempt + "-";
      using (var handle = OpenDirectory(parent, false)) return DirectoryEntries(handle).Where(entry => entry.Name.StartsWith(prefix, StringComparison.Ordinal)).Select(entry => entry.Name).ToArray();
    }

    public static bool EntryExistsNoFollow(string path) {
      var handle = CreateFileW(Path.GetFullPath(path), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
      if (handle != null && !handle.IsInvalid) { handle.Dispose(); return true; }
      if (handle != null) handle.Dispose();
      var error = Marshal.GetLastWin32Error();
      if (error == 2 || error == 3) return false;
      throw new InvalidOperationException("Preliminary no-follow entry observation failed");
    }

    private static IEnumerable<string> Ancestors(string path) {
      var full = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
      var root = Path.GetPathRoot(full);
      var values = new List<string> { root };
      var current = root;
      foreach (var segment in full.Substring(root.Length).Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries)) { current = Path.Combine(current, segment); values.Add(current); }
      return values;
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
    private static string Hex(byte[] value) { return BitConverter.ToString(value).Replace("-", "").ToLowerInvariant(); }
    private static void ValidatePositiveDecimal(string value) { long parsed; if (String.IsNullOrEmpty(value) || value[0] == '0' || !Int64.TryParse(value, out parsed) || parsed <= 0 || value.Any(character => character < '0' || character > '9')) throw new InvalidOperationException("Preliminary run identity is invalid"); }
    private static void ThrowTestFailpoint(string actual, string expected) { if (!String.IsNullOrEmpty(actual) && String.Equals(actual, expected, StringComparison.Ordinal)) throw new InvalidOperationException("Injected preliminary controller failure"); }
  }
}
'@
}

function Assert-TestAuthority {
  if ($env:BHARATCODE_PRELIMINARY_CONTROLLER_TEST -ne "1") { throw "Preliminary controller test authority is unavailable" }
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
  try { $Lease.CloseJob() } catch { $primary = $_.Exception }
  try { $Lease.DeleteOwnedTree() }
  catch {
    if ($primary) { throw [AggregateException]::new("Preliminary job and tree cleanup failed", @($primary, $_.Exception)) }
    throw
  }
  finally { $Lease.Dispose() }
  if ($primary) { throw $primary }
}

function Invoke-PreliminaryControllerTestScenario {
  param(
    [Parameter(Mandatory)][string]$RunnerTemp,
    [Parameter(Mandatory)][string]$RunId,
    [Parameter(Mandatory)][string]$RunAttempt,
    [Parameter(Mandatory)][string]$ReceiptPath,
    [string]$Failpoint = ""
  )
  Assert-TestAuthority
  $lease = $null
  $primary = $null
  $cleanup = $null
  $receiptBytes = $null
  try {
    $lease = New-PreliminaryControllerLease -RunnerTemp $RunnerTemp -RunId $RunId -RunAttempt $RunAttempt
    [IO.File]::WriteAllText((Join-Path $lease.RootPath "installed.test"), "installed")
    if ($Failpoint -eq "after-install") { throw "Injected after-install failure" }
    ([IO.File]::OpenRead((Join-Path $lease.RootPath "installed.test"))).Dispose()
    if ($Failpoint -eq "after-app-open") { throw "Injected after-app-open failure" }
    [IO.File]::WriteAllText((Join-Path $lease.RootPath "harness.test"), "harness")
    if ($Failpoint -eq "after-harness") { throw "Injected after-harness failure" }
    $receiptBytes = [Text.UTF8Encoding]::new($false).GetBytes("{`"cleanup_complete`":true}`n")
    if ($Failpoint -eq "after-receipt-construction") { throw "Injected after-receipt-construction failure" }
  }
  catch { $primary = $_.Exception }
  finally {
    if ($lease) {
      try { Remove-PreliminaryControllerLease -Lease $lease }
      catch { $cleanup = $_.Exception }
    }
  }
  if ($primary -or $cleanup) {
    if ($primary -and $cleanup) { throw [AggregateException]::new("Preliminary test transaction and cleanup failed", @($primary, $cleanup)) }
    if ($primary) { throw $primary }
    throw $cleanup
  }
  $output = [IO.File]::Open($ReceiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $output.Write($receiptBytes, 0, $receiptBytes.Length); $output.Flush($true) } finally { $output.Dispose() }
}

function Invoke-PreliminaryController {
  param(
    [Parameter(Mandatory)][string]$RunnerTemp,
    [Parameter(Mandatory)][string]$RunId,
    [Parameter(Mandatory)][string]$RunAttempt,
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$ExpectedVersion,
    [Parameter(Mandatory)][string]$EvidenceScript,
    [Parameter(Mandatory)][string]$ReceiptPath
  )
  $lease = $null
  $primary = $null
  $cleanup = $null
  $receiptBytes = $null
  $scriptPath = $null
  $candidatePath = $null
  try {
    $lease = New-PreliminaryControllerLease -RunnerTemp $RunnerTemp -RunId $RunId -RunAttempt $RunAttempt
    $installerPath = [IO.Path]::GetFullPath($Installer)
    $signature = Get-AuthenticodeSignature $installerPath
    if ($signature.Status -ne "NotSigned" -or $signature.SignerCertificate -or $signature.TimeStamperCertificate) { throw "Preliminary installer signature identity drift" }
    $lease.PinInstaller($installerPath)
    $install = $lease.StartOwnedProcess($installerPath, "/S /D=`"$($lease.RootPath)`"")
    if ($install.WaitForExit(180000) -ne 0) { throw "Preliminary NSIS install failed" }
    $installed = Join-Path $lease.RootPath "BharatCode Beta.exe"
    if (-not [IO.File]::Exists($installed)) { throw "Installed preliminary Desktop is missing" }
    $lease.PinInstalledDesktop($installed)
    $installedSignature = Get-AuthenticodeSignature $installed
    if ($installedSignature.Status -ne "NotSigned" -or $installedSignature.SignerCertificate -or $installedSignature.TimeStamperCertificate) { throw "Installed preliminary Desktop must remain unsigned" }
    if ([version](Get-Item -LiteralPath $installed).VersionInfo.ProductVersion -ne [version]$ExpectedVersion) { throw "Installed preliminary Desktop version drift" }
    $scriptPath = Join-Path $RunnerTemp ".$($lease.RootLeaf)-evidence.mjs"
    $candidatePath = Join-Path $RunnerTemp ".$($lease.RootLeaf)-receipt-candidate.json"
    $script = [IO.File]::Open($scriptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $scriptBytes = [Text.UTF8Encoding]::new($false).GetBytes($EvidenceScript)
      $script.Write($scriptBytes, 0, $scriptBytes.Length)
      $script.Flush($true)
    }
    finally { $script.Dispose() }
    $env:INSTALLED_DESKTOP_EXE = $installed
    $env:UNSIGNED_INSTALLER_PATH = $installerPath
    $env:PRELIMINARY_RECEIPT_CANDIDATE = $candidatePath
    $bun = (Get-Command bun -CommandType Application).Source
    $harness = $lease.StartOwnedProcess($bun, "`"$scriptPath`"")
    if ($harness.WaitForExit(900000) -ne 0) { throw "Preliminary WSL harness failed" }
    if (-not [IO.File]::Exists($candidatePath)) { throw "Preliminary receipt candidate is missing" }
    $receiptBytes = [IO.File]::ReadAllBytes($candidatePath)
  }
  catch { $primary = $_.Exception }
  finally {
    $cleanupErrors = [Collections.Generic.List[Exception]]::new()
    if ($lease) {
      try { Remove-PreliminaryControllerLease -Lease $lease }
      catch { [void]$cleanupErrors.Add($_.Exception) }
    }
    foreach ($temporary in @($candidatePath, $scriptPath)) {
      try {
        if ($temporary -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
      }
      catch { [void]$cleanupErrors.Add($_.Exception) }
    }
    if ($cleanupErrors.Count -eq 1) { $cleanup = $cleanupErrors[0] }
    elseif ($cleanupErrors.Count -gt 1) { $cleanup = [AggregateException]::new("Preliminary cleanup failures", [Exception[]]$cleanupErrors.ToArray()) }
  }
  if ($primary -or $cleanup) {
    if ($primary -and $cleanup) { throw [AggregateException]::new("Preliminary controller and cleanup failed", @($primary, $cleanup)) }
    if ($primary) { throw $primary }
    throw $cleanup
  }
  $output = [IO.File]::Open($ReceiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $output.Write($receiptBytes, 0, $receiptBytes.Length); $output.Flush($true) } finally { $output.Dispose() }
}

if ($Mode -eq "CrashProbe") {
  Assert-TestAuthority
  $lease = New-PreliminaryControllerLease -RunnerTemp $RunnerTemp -RunId $RunId -RunAttempt $RunAttempt
  $ready = [IO.File]::Open($ReadyPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($lease.RootPath)
    $ready.Write($bytes, 0, $bytes.Length)
    $ready.Flush($true)
  }
  finally { $ready.Dispose() }
  while ($true) { Start-Sleep -Seconds 60 }
}
