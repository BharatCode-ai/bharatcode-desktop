import { posix } from "node:path"
import { StoragePaths } from "../../../../core/src/storage-paths"
import { parseWslRuntimeManifest, type WslRuntimeManifest } from "./artifact"

export type WslExecute = (distro: string, args: string[], user?: string) => Promise<string>
export type WslIdentity = { user: string; uid: number; home: string }

export function validateWslDistro(distro: string) {
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,127}$/u.test(distro)) throw new Error("Invalid WSL distribution")
}

function line(output: string) {
  const value = output.replace(/\r?\n$/, "")
  if (!value || /[\u0000\r\n]/u.test(value)) throw new Error("Malformed WSL identity output")
  return value
}

function linuxPath(value: string) {
  if (!posix.isAbsolute(value) || posix.normalize(value) !== value || /[\u0000\r\n]/u.test(value)) {
    throw new Error("Invalid WSL absolute path")
  }
  return value
}

export async function resolveWslIdentity(execute: WslExecute, distro: string): Promise<WslIdentity> {
  validateWslDistro(distro)
  const rawUid = line(await execute(distro, ["/usr/bin/id", "-u"]))
  if (!/^[1-9][0-9]*$/.test(rawUid)) throw new Error("WSL requires a non-root user")
  const uid = Number(rawUid)
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error("WSL requires a non-root user")
  const user = line(await execute(distro, ["/usr/bin/id", "-un"]))
  if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(user)) throw new Error("Invalid WSL username")
  const passwd = line(await execute(distro, ["/usr/bin/getent", "passwd", user], user)).split(":")
  if (passwd.length !== 7 || passwd[0] !== user || passwd[2] !== String(uid)) throw new Error("WSL user changed")
  return { user, uid, home: linuxPath(passwd[5]) }
}

// Shell receives only positional arguments, never interpolated source. A runtime
// lives at a content-addressed path, so upgrading cannot overwrite a running
// executable. Existing storage permissions are checked, never relaxed/repaired.
// This is a same-user namespace boundary, not protection from a hostile user who
// can replace their own directory concurrently; the launch handshake rechecks the
// actual executable digest before Desktop grants that runtime request authority.
const install = `set -eu
umask 077
bin=$1
source=$2
name=$3
digest=$4
bytes=$5
uid=$6
mode=$7
home=$8
target="$bin/$digest"
verify() {
  test ! -L "$target"
  test "$(realpath -e -- "$target")" = "$target"
  test "$(stat -c %u -- "$target")" = "$uid"
  test "$(stat -c %a -- "$target")" = 700
  test -f "$target/$name"
  test ! -L "$target/$name"
  test "$(stat -c %h -- "$target/$name")" = 1
  test "$(stat -c %u -- "$target/$name")" = "$uid"
  test "$(stat -c %a -- "$target/$name")" = 500
  test "$(stat -c %s -- "$target/$name")" = "$bytes"
  test "$(sha256sum --binary -- "$target/$name")" = "$digest *$target/$name"
}
test -d "$home"
ensure_directory() {
  case "$1" in "$home"|"$home"/*) ;; *) return 1 ;; esac
  if test "$1" != "$home"; then ensure_directory "$(dirname -- "$1")"; fi
  if test ! -e "$1" && test ! -L "$1"; then
    test "$mode" = install
    mkdir -- "$1"
  fi
  test -d "$1"
  test ! -L "$1"
  test "$(realpath -e -- "$1")" = "$1"
  test "$(stat -c %u -- "$1")" = "$uid"
  permissions=$(stat -c %a -- "$1")
  test $((0$permissions & 0022)) = 0
}
ensure_directory "$bin"
if test -e "$target" || test -L "$target"; then
  verify
elif test "$mode" = install; then
  stage=$(mktemp -d "$bin/.wsl-stage.XXXXXXXX")
  trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
  /usr/bin/install --mode=0500 -- "$source" "$stage/$name"
  test "$(stat -c %s -- "$stage/$name")" = "$bytes"
  test "$(sha256sum --binary -- "$stage/$name")" = "$digest *$stage/$name"
  mv -T --no-clobber -- "$stage" "$target"
  verify
else
  exit 1
fi
printf '%s\\n' "$target/$name"
`

export async function provisionWslRuntime(input: {
  execute: WslExecute
  distro: string
  identity: WslIdentity
  channel: string
  sourcePath: string
  manifest: WslRuntimeManifest
  install: boolean
}) {
  validateWslDistro(input.distro)
  const identity = input.identity
  if (!Number.isSafeInteger(identity.uid) || identity.uid <= 0 || !/^[a-z_][a-z0-9_-]{0,31}$/u.test(identity.user)) {
    throw new Error("Invalid non-root WSL identity")
  }
  const manifest = parseWslRuntimeManifest(input.manifest)
  const bin = StoragePaths.resolve({
    platform: "linux",
    channel: input.channel,
    home: linuxPath(identity.home),
    temp: "/tmp",
    env: {},
  }).bin
  const expected = posix.join(bin, manifest.sha256, manifest.filename)
  const output = await input.execute(
    input.distro,
    [
      "/bin/sh",
      "-c",
      install,
      "bharatcode-wsl-runtime",
      bin,
      linuxPath(input.sourcePath),
      manifest.filename,
      manifest.sha256,
      String(manifest.bytes),
      String(identity.uid),
      input.install ? "install" : "verify",
      identity.home,
    ],
    identity.user,
  )
  if (line(output) !== expected) throw new Error("Unexpected installed WSL path")
  return expected
}
