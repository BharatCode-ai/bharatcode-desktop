import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { OpenTunnelStorage } from '@opentunnel/client/effect'
import { removeTunnel, connectTunnel } from '../src/tunnel.mjs'

test('reset removes a pending identity through the explicit API without waiting for a certificate', {timeout:2000}, async t => {
  const root = await mkdtemp(join(tmpdir(),'bc-tunnel-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const storage=OpenTunnelStorage.xdg({env:{XDG_DATA_HOME:root}})
  await Effect.runPromise(storage.savePending('bharatcode-mobile',{id:'tun_pending',hostname:'pc.tunnel.bharatcode.ai',token:'pending-private-token',privateKey:'pending-private-key',csr:'pending-csr'}))
  const requests=[]
  // This is the SDK's external fetch boundary; never mock its storage/provisioning logic.
  t.mock.method(globalThis,'fetch',async (input, init)=>{
    const request = input instanceof Request ? input : new Request(input, init)
    requests.push({url:request.url,method:request.method,authorization:request.headers.get('authorization')})
    if(request.method==='DELETE') return new Response(null,{status:204})
    return new Response(JSON.stringify({id:'tun_pending',state:{type:'pending'}}),{headers:{'content-type':'application/json'}})
  })
  await removeTunnel({storePath:root})
  assert.deepEqual(requests,[{url:'https://tunnel.bharatcode.ai/api/tunnel/tun_pending',method:'DELETE',authorization:'Bearer pending-private-token'}])
  assert.equal(await Effect.runPromise(storage.loadPending('bharatcode-mobile')),undefined)
  assert.equal((await stat(root)).mode & 0o777,0o700)
})

test('invalid targets and already-cancelled connections never create a tunnel', async t => {
  const root=await mkdtemp(join(tmpdir(),'bc-tunnel-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const intercepted=t.mock.method(globalThis,'fetch',()=>{throw new Error('must not contact API')})
  for(const target of ['http://example.com:1234','http://user:pass@127.0.0.1:1234','http://127.0.0.1:1234/path']) await assert.rejects(connectTunnel({target,storePath:root}))
  await assert.rejects(connectTunnel({target:'http://127.0.0.1:1234',storePath:root,signal:AbortSignal.abort()}))
  assert.equal(intercepted.mock.callCount(),0)
})
