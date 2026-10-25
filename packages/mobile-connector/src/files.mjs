import { realpath, readdir, open } from 'node:fs/promises'
import { resolve, relative, isAbsolute, sep } from 'node:path'

export async function projectFile(directory, path) {
  if (typeof path !== 'string' || path.includes('\0') || path.includes('\\') || isAbsolute(path) || path.split('/').includes('..')) throw Object.assign(new Error('Invalid project path'), { status: 400 })
  const root = await realpath(directory)
  const target = await realpath(resolve(root, path))
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw Object.assign(new Error('Path is outside the project'), { status: 403 })
  const file = await open(target, 'r')
  try {
    const stat = await file.stat()
    if (stat.isDirectory()) {
      const entries = await readdir(target, { withFileTypes: true })
      return { type: 'directory', path, truncated: entries.length > 2000, entries: entries.slice(0, 2000).map(entry => ({ name: entry.name, directory: entry.isDirectory(), symlink: entry.isSymbolicLink() })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) }
    }
    if (!stat.isFile()) throw Object.assign(new Error('Unsupported file type'), { status: 400 })
    if (stat.size > 262144) return { type: 'file', path, size: stat.size, tooLarge: true }
    const bytes = Buffer.alloc(262145)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 262144) return { type: 'file', path, tooLarge: true }
    const content = bytes.subarray(0, bytesRead)
    if (content.includes(0)) return { type: 'file', path, binary: true }
    try { return { type: 'file', path, text: new TextDecoder('utf-8', { fatal: true }).decode(content) } }
    catch { return { type: 'file', path, binary: true } }
  } finally { await file.close() }
}
