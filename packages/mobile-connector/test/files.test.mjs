import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { projectFile } from '../src/files.mjs'

test('project reader confines files to the resolved project including symlinks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bc-files-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'project'))
  await writeFile(join(root, 'project', 'app.ts'), 'export const app = true')
  await writeFile(join(root, 'secret'), 'private')
  await symlink(join(root, 'secret'), join(root, 'project', 'escape'))
  assert.equal((await projectFile(join(root, 'project'), 'app.ts')).text, 'export const app = true')
  assert.equal((await projectFile(join(root, 'project'), '')).entries.length, 2)
  await assert.rejects(projectFile(join(root, 'project'), '../secret'), /outside|Invalid/)
  await assert.rejects(projectFile(join(root, 'project'), 'escape'), /outside/)
  await writeFile(join(root, 'project', 'binary'), Buffer.from([0, 255]))
  assert.equal((await projectFile(join(root, 'project'), 'binary')).binary, true)
  await writeFile(join(root, 'project', 'large'), Buffer.alloc(262145, 97))
  assert.equal((await projectFile(join(root, 'project'), 'large')).tooLarge, true)
})
