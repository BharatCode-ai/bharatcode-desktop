import path from "node:path"
import { spawnSync } from "node:child_process"

// Same built-in PowerShell/.NET host as the Windows ownership controller. Secrets
// travel only over private stdin/stdout pipes, never argv, environment or disk scripts.
// ACL decisions and credential reads operate on the same retained file handle.
export function windowsCredentialStore(file: string, options: { spawn?: typeof spawnSync } = {}) {
  const invoke = (operation: "read" | "publish", content?: string): string | undefined => {
    if (process.platform !== "win32" || !path.win32.isAbsolute(file))
      throw new Error("Windows credential access unavailable")
    const root = process.env.SystemRoot ?? process.env.WINDIR
    if (!root || !path.win32.isAbsolute(root)) throw new Error("Windows credential access unavailable")
    const result = (options.spawn ?? spawnSync)(
      path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        input: JSON.stringify({
          operation,
          file,
          content: content === undefined ? null : Buffer.from(content).toString("base64"),
        }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 12 * 1024 * 1024,
        env: { SystemRoot: root, WINDIR: root, TEMP: process.env.TEMP, TMP: process.env.TMP },
      },
    )
    if (result.status !== 0 || result.error) {
      throw new Error(
        operation === "publish"
          ? "Windows credential publication was not confirmed. Re-read account state before retrying."
          : "Windows credential permissions or access could not be verified.",
      )
    }
    const response: unknown = JSON.parse(result.stdout)
    if (
      !response ||
      typeof response !== "object" ||
      !("ok" in response) ||
      response.ok !== true ||
      !("content" in response)
    ) {
      throw new Error("Windows credential operation was not confirmed.")
    }
    if (response.content === null) return
    if (typeof response.content !== "string") throw new Error("Windows credential response is invalid.")
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(response.content, "base64"))
  }
  return {
    read: () => invoke("read"),
    publish: (content: string) => {
      invoke("publish", content)
    },
  }
}

const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public static class BharatCodeCredentialFile {
  const uint READ_CONTROL = 0x20000, SYNCHRONIZE = 0x100000, DELETE = 0x10000;
  const uint READ = 0x80000000, WRITE = 0x40000000, SHARE_READ = 1, SHARE_WRITE = 2, SHARE_DELETE = 4;
  const uint REPARSE = 0x400, DIRECTORY = 0x10;
  const int MAX_BYTES = 8 * 1024 * 1024;
  [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
  [StructLayout(LayoutKind.Sequential)] struct Unicode { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct Attributes { public int Length; public IntPtr Root, Name; public uint Flags; public IntPtr Security, Quality; }
  [StructLayout(LayoutKind.Sequential)] struct IOStatus { public IntPtr Status; public UIntPtr Information; }
  [StructLayout(LayoutKind.Sequential)] struct RenameInfo { public uint Flags; public IntPtr Root; public uint Length; public char Name; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder name, uint length, uint flags);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref Attributes attributes, out IOStatus status, IntPtr size, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle handle, out IOStatus status, IntPtr information, uint length, int informationClass);

  static string Full(string path) {
    var full = Path.GetFullPath(path);
    if (full.Length < 4 || full[1] != ':' || full[2] != '\\' || full.IndexOf(':', 2) >= 0 || full.IndexOf('\0') >= 0) throw new IOException("Invalid credential path");
    return full.TrimEnd('\\');
  }
  static Info Inspect(SafeFileHandle handle, bool directory) {
    Info info;
    if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & REPARSE) != 0 || ((info.Attributes & DIRECTORY) != 0) != directory || (!directory && info.Links != 1)) throw new IOException("Unsafe held credential object");
    return info;
  }
  static string Final(SafeFileHandle handle) {
    var value = new StringBuilder(32768);
    var length = GetFinalPathNameByHandleW(handle, value, (uint)value.Capacity, 0);
    if (length == 0 || length >= value.Capacity) throw new IOException("Unverifiable credential path");
    return value.ToString().Replace(@"\\?\", "").TrimEnd('\\');
  }
  static byte[] Security(SafeFileHandle handle) {
    IntPtr owner, group, dacl, sacl, descriptor;
    if (GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor) != 0) throw new IOException("Credential security unavailable");
    try {
      var bytes = new byte[GetSecurityDescriptorLength(descriptor)];
      Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      var security = new RawSecurityDescriptor(bytes, 0);
      var sid = WindowsIdentity.GetCurrent().User;
      if (security.Owner == null || !security.Owner.Equals(sid) || security.DiscretionaryAcl == null) throw new IOException("Credential owner or DACL invalid");
      // SYSTEM and local Administrators are trusted OS principals, not ordinary
      // users. CREATOR OWNER is not independently trusted for effective access.
      foreach (GenericAce entry in security.DiscretionaryAcl) {
        if ((entry.AceFlags & AceFlags.InheritOnly) != 0) continue;
        var ace = entry as QualifiedAce;
        if (ace == null || ace.IsCallback) throw new IOException("Unsupported credential ACE");
        if (ace.AceQualifier == AceQualifier.AccessDenied) continue;
        if (ace.AceQualifier != AceQualifier.AccessAllowed) throw new IOException("Unsupported credential ACE");
        if (ace.AccessMask == 0) continue;
        var identity = ace.SecurityIdentifier.Value;
        if (identity != sid.Value && identity != "S-1-5-18" && identity != "S-1-5-32-544") throw new IOException("Credential grants unrelated access");
      }
      return bytes;
    } finally { LocalFree(descriptor); }
  }
  static void Unchanged(byte[] before, byte[] after) {
    if (before.Length != after.Length) throw new IOException("Credential security changed");
    for (int i=0; i<before.Length; i++) if (before[i] != after[i]) throw new IOException("Credential security changed");
  }
  static DirectorySecurity PrivateDirectory() {
    var result = new DirectorySecurity();
    result.SetSecurityDescriptorSddlForm("O:" + WindowsIdentity.GetCurrent().User.Value + "D:P(A;OICI;FA;;;" + WindowsIdentity.GetCurrent().User.Value + ")(A;OICI;FA;;;SY)");
    return result;
  }
  sealed class Chain : IDisposable {
    public readonly List<SafeFileHandle> Handles = new List<SafeFileHandle>();
    public SafeFileHandle Parent { get { return Handles[Handles.Count - 1]; } }
    public bool Missing;
    public void Dispose() { for(int i=Handles.Count-1;i>=0;i--) Handles[i].Dispose(); }
  }
  static Chain PinParent(string file, bool create) {
    var chain = new Chain();
    try {
      var parent = Path.GetDirectoryName(file);
      var current = Path.GetPathRoot(file);
      foreach (var component in new[]{""}.ConcatParts(parent.Substring(current.Length))) {
        if (component.Length != 0) current = Path.Combine(current, component);
        var handle = CreateFileW(current, READ_CONTROL | 0x80, SHARE_READ | SHARE_WRITE, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
        if (handle.IsInvalid) {
          var error = Marshal.GetLastWin32Error(); handle.Dispose();
          if (error != 2 && error != 3) throw new IOException("Credential ancestor unavailable");
          if (!create) { chain.Missing = true; return chain; }
          Directory.CreateDirectory(current, PrivateDirectory());
          handle = CreateFileW(current, READ_CONTROL | 0x80, SHARE_READ | SHARE_WRITE, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
          if (handle.IsInvalid) { handle.Dispose(); throw new IOException("Credential parent creation failed"); }
        }
        chain.Handles.Add(handle);
        Inspect(handle, true);
        if (!String.Equals(Final(handle), current.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw new IOException("Credential ancestor changed");
      }
      return chain;
    } catch { chain.Dispose(); throw; }
  }
  static IEnumerable<string> ConcatParts(this string[] initial, string remaining) {
    foreach(var item in initial) yield return item;
    foreach(var item in remaining.Split(new[]{'\\'}, StringSplitOptions.RemoveEmptyEntries)) yield return item;
  }
  static SafeFileHandle Open(string file, uint share, out bool missing) {
    var handle = CreateFileW(file, READ | READ_CONTROL, share, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
    missing = false;
    if (handle.IsInvalid) {
      var error = Marshal.GetLastWin32Error(); handle.Dispose();
      if (error == 2) { missing = true; return null; }
      throw new IOException("Credential file unavailable");
    }
    Inspect(handle, false);
    if (!String.Equals(Final(handle), file, StringComparison.OrdinalIgnoreCase)) { handle.Dispose(); throw new IOException("Credential leaf changed"); }
    return handle;
  }
  public static string Read(string input) {
    var file = Full(input);
    using (var parent = PinParent(file, false)) {
      if (parent.Missing) return null;
      bool missing;
      using (var handle = Open(file, SHARE_READ, out missing)) {
        if (missing) return null;
        var parentSecurity = Security(parent.Parent);
        var security = Security(handle);
        using (var stream = new FileStream(handle, FileAccess.Read)) {
          if (stream.Length > MAX_BYTES) throw new IOException("Credential store too large");
          var bytes = new byte[(int)stream.Length];
          int offset = 0;
          while (offset < bytes.Length) { int n = stream.Read(bytes, offset, bytes.Length-offset); if (n == 0) throw new IOException("Credential read incomplete"); offset += n; }
          Inspect(handle, false);
          Unchanged(security, Security(handle));
          Unchanged(parentSecurity, Security(parent.Parent));
          return Convert.ToBase64String(bytes);
        }
      }
    }
  }
  static SafeFileHandle CreateRelative(SafeFileHandle parent, string name) {
    var sid = WindowsIdentity.GetCurrent().User.Value;
    var security = new RawSecurityDescriptor("O:" + sid + "D:P(A;;FA;;;" + sid + ")(A;;FA;;;SY)");
    var bytes = new byte[security.BinaryLength]; security.GetBinaryForm(bytes, 0);
    var pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
    var text = Marshal.StringToHGlobalUni(name);
    var unicode = new Unicode { Length = checked((ushort)(name.Length*2)), MaximumLength = checked((ushort)((name.Length+1)*2)), Buffer = text };
    var pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Unicode)));
    try {
      Marshal.StructureToPtr(unicode, pointer, false);
      var attributes = new Attributes { Length=Marshal.SizeOf(typeof(Attributes)), Root=parent.DangerousGetHandle(), Name=pointer, Flags=0x40, Security=pinned.AddrOfPinnedObject() };
      IOStatus status; SafeFileHandle result;
      // Exclusive private creation; synchronous write-through regular file, not a directory fsync.
      var code = NtCreateFile(out result, READ | WRITE | READ_CONTROL | DELETE | SYNCHRONIZE, ref attributes, out status, IntPtr.Zero, 0, SHARE_READ, 2, 0x40 | 0x20 | 0x2 | 0x00200000, IntPtr.Zero, 0);
      if (code < 0 || result.IsInvalid) { if(result != null)result.Dispose(); throw new IOException("Credential creation failed"); }
      return result;
    } finally { pinned.Free(); Marshal.FreeHGlobal(pointer); Marshal.FreeHGlobal(text); }
  }
  static void RenameRelative(SafeFileHandle file, SafeFileHandle parent, string name) {
    // Reuse the controller's retained-handle NtSetInformationFile rename boundary.
    // The file is opened WRITE_THROUGH and flushed before and after publication.
    var offset = Marshal.OffsetOf(typeof(RenameInfo), "Name").ToInt32();
    var bytes = Encoding.Unicode.GetBytes(name);
    var size = offset + bytes.Length;
    var pointer = Marshal.AllocHGlobal(size);
    try {
      for(int i=0;i<size;i++)Marshal.WriteByte(pointer,i,0);
      Marshal.WriteInt32(pointer, 0, 3); // REPLACE_IF_EXISTS | POSIX_SEMANTICS: the pinned previous handle retains its old object.
      Marshal.WriteIntPtr(pointer, Marshal.OffsetOf(typeof(RenameInfo), "Root").ToInt32(), parent.DangerousGetHandle());
      Marshal.WriteInt32(pointer, Marshal.OffsetOf(typeof(RenameInfo), "Length").ToInt32(), bytes.Length);
      Marshal.Copy(bytes, 0, IntPtr.Add(pointer, offset), bytes.Length);
      IOStatus status;
      if (NtSetInformationFile(file, out status, pointer, (uint)size, 65) < 0) throw new IOException("Credential activation failed");
    } finally { Marshal.FreeHGlobal(pointer); }
  }
  public static void Publish(string input, string content) {
    var file = Full(input);
    var bytes = Convert.FromBase64String(content);
    if (bytes.Length > MAX_BYTES) throw new IOException("Credential store too large");
    using (var parent = PinParent(file, true)) {
      var parentSecurity = Security(parent.Parent);
      bool missing;
      using (var previous = Open(file, SHARE_READ | SHARE_DELETE, out missing)) {
        if (!missing) Security(previous);
        var name = ".auth-" + Guid.NewGuid().ToString("N") + ".tmp";
        bool activated = false;
        using (var handle = CreateRelative(parent.Parent, name))
        using (var stream = new FileStream(handle, FileAccess.ReadWrite)) {
          try {
              Security(handle); Inspect(handle, false);
              stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
              Unchanged(parentSecurity, Security(parent.Parent));
              if (!missing) Security(previous);
              RenameRelative(handle, parent.Parent, Path.GetFileName(file));
              activated = true;
              stream.Flush(true);
              Inspect(handle, false); Security(handle);
              if (!String.Equals(Final(handle), file, StringComparison.OrdinalIgnoreCase)) throw new IOException("Credential publication identity changed");
              Unchanged(parentSecurity, Security(parent.Parent));
          } catch {
            // Never erase an activated record or roll it back after uncertain completion.
            // Failed pre-publication private temp is removed only if its owned handle still exists.
            if (!activated && !handle.IsClosed) {
              var memory = Marshal.AllocHGlobal(1);
              try { Marshal.WriteByte(memory, 1); IOStatus status; if (NtSetInformationFile(handle, out status, memory, 1, 13) < 0) throw new IOException("Private credential staging cleanup was not confirmed"); }
              finally { Marshal.FreeHGlobal(memory); }
            }
            throw;
          }
        }
      }
    }
  }
}
'@
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.operation -eq 'read') { $content = [BharatCodeCredentialFile]::Read([string]$request.file) }
  elseif ($request.operation -eq 'publish') { [BharatCodeCredentialFile]::Publish([string]$request.file, [string]$request.content); $content = $null }
  else { throw 'Invalid operation' }
  [Console]::Out.Write((@{ok=$true;content=$content} | ConvertTo-Json -Compress))
} catch { exit 1 }
`
