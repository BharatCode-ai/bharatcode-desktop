import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createMobileAccess } from '../src/desktop-access.mjs'

test('Desktop starts no tunnel until enabled, and disabling closes both resources', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bc-access-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let connects = 0, closes = 0
  const access = await createMobileAccess({
    userDataPath: directory,
    getConnection: () => ({ url: 'http://127.0.0.1:4096', username: 'opencode', password: 'private' }),
    tunnelFactory: async () => { connects++; return { origin: 'https://unit.tunnel.bharatcode.ai', close: async () => { closes++ }, events: (async function* () {})() } },
  })
  t.after(() => access.close())
  await access.restore()
  assert.equal(access.snapshot().errorKey, undefined)
  assert.equal(connects, 0)
  await access.action({ type: 'pair' })
  assert.equal(connects, 1)
  assert.ok(access.snapshot().qrImage.startsWith('data:image/png;base64,'))
  assert.equal(new URL(access.snapshot().pairing).hostname, 'pair')
  await access.action({ type: 'disable' })
  assert.equal(closes, 1)
  assert.equal(access.snapshot().enabled, false)
  assert.equal(access.snapshot().pairing, undefined)
  await assert.rejects(access.action({ type: 'approve', id: 'unknown' }))
})

test('Desktop refuses a remote or unprotected sidecar without creating a tunnel', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bc-access-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const access = await createMobileAccess({ userDataPath: directory, getConnection: () => ({ url: 'https://other.example', password: '' }), tunnelFactory: () => { throw new Error('must not connect') } })
  t.after(() => access.close())
  await assert.rejects(access.action({ type: 'pair' }))
  assert.equal(access.snapshot().enabled, false)
})

test('provisioning reports progress while status stays readable and disconnect cancels startup', {timeout:2000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bc-access-'))
  t.after(() => rm(directory, {recursive:true,force:true}))
  let began
  const ready = new Promise(resolve => began = resolve)
  const access = await createMobileAccess({userDataPath:directory,getConnection:()=>({url:'http://127.0.0.1:4096',password:'private'}), tunnelFactory:async ({signal,onProgress})=>{
    onProgress('waiting-certificate'); began()
    await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}))
  }})
  t.after(()=>access.close())
  const pairing = access.action({type:'pair'}).catch(()=>{})
  await ready
  const snapshot = await access.action({type:'state'})
  assert.equal(snapshot.status,'provisioning')
  assert.equal(snapshot.progress,'waiting-certificate')
  await access.action({type:'disable'})
  await pairing
  assert.equal(access.snapshot().status,'off')
})

test('Desktop emits credential-free links, restores enabled identity and clears revoked phones on reset', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bc-access-'))
  t.after(() => rm(directory, {recursive:true,force:true}))
  let connects=0, removed=0
  const options = {userDataPath:directory,getConnection:()=>({url:'http://127.0.0.1:4096',password:'private'}), tunnelFactory:async()=>{
    connects++; return {origin:'https://pc.tunnel.bharatcode.ai',events:(async function*(){})(),close:async()=>{}}
  },removeTunnel:async()=>{removed++}}
  const first=await createMobileAccess(options)
  await first.action({type:'pair'})
  const link=new URL(first.snapshot().pairing)
  assert.equal(link.protocol,'bharatcode:')
  assert.deepEqual([...link.searchParams.keys()].sort(),['desktopID','origin'])
  assert.equal(first.snapshot().status,'connected')
  await first.close()
  const second=await createMobileAccess(options)
  t.after(()=>second.close())
  await second.restore()
  assert.equal(connects,2)
  assert.equal(second.snapshot().enabled,true)
  await second.action({type:'reset'})
  assert.equal(removed,1)
  assert.deepEqual(second.snapshot().devices,[])
  assert.equal(second.snapshot().enabled,false)
})

test('Desktop status reflects a phone unpairing itself immediately', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bc-access-'))
  t.after(() => rm(directory, {recursive:true,force:true}))
  let target
  const access = await createMobileAccess({userDataPath:directory,getConnection:()=>({url:'http://127.0.0.1:4096',password:'private'}),tunnelFactory:async options=>{
    target=options.target; return {origin:'https://pc.tunnel.bharatcode.ai',events:(async function*(){})(),close:async()=>{}}
  }})
  t.after(()=>access.close())
  await access.action({type:'pair'})
  const link=new URL(access.snapshot().pairing)
  const post=(path,body)=>fetch(target+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  const claim=await (await post('/mobile/v1/claim',{desktopID:link.searchParams.get('desktopID'),deviceName:'Phone'})).json()
  await access.action({type:'approve',id:claim.claimID})
  const paired=await (await post('/mobile/v1/claim/status',claim)).json()
  assert.equal((await access.action({type:'state'})).devices.length,1)
  assert.equal((await fetch(target+'/mobile/v1/device',{method:'DELETE',headers:{authorization:'Bearer '+paired.token}})).status,200)
  assert.equal((await access.action({type:'state'})).devices.length,0)
})

test('self-hosted identities use a service-specific store, never the old upstream token', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bc-access-'))
  t.after(() => rm(directory, {recursive:true,force:true}))
  let actual
  const access = await createMobileAccess({userDataPath:directory,getConnection:()=>({url:'http://127.0.0.1:4096',password:'private'}),tunnelFactory:async ({storePath})=>{
    actual=storePath; return {origin:'https://pc.tunnel.bharatcode.ai',events:(async function*(){})(),close:async()=>{}}
  }})
  t.after(()=>access.close())
  await access.action({type:'pair'})
  assert.equal(actual,join(directory,'mobile-access','tunnel-bharatcode-ai'))
})
