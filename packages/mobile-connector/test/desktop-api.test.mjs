import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDesktopAPI } from '../src/desktop-api.mjs'

test('stored admission is acknowledged while the upstream async HTTP acknowledgement is still pending', async t => {
  const root = await mkdtemp(join(tmpdir(),'bc-admission-early-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  let release, forwarded=0, posted=false
  const acknowledgement=new Promise(resolve=>{release=resolve})
  const request=async(path,method,_body)=>{
    if(path==='/session/ses_one') return {data:{id:'ses_one',directory:'/fixture'}}
    if(path.includes('/prompt_async')) { forwarded++; posted=true; await acknowledgement; return {data:{}} }
    if(path.includes('/message/msg_early')) {
      if(!posted) throw Object.assign(new Error('Not stored'),{status:404})
      return {data:{info:{id:'msg_early',role:'user'},parts:[{type:'text',text:'Only once'}]}}
    }
    throw new Error('Unexpected route '+path)
  }
  const api=await createDesktopAPI({request,storePath:join(root,'admissions.json')})
  const sending=api.handle('POST','/api/session/ses_one/prompt',{id:'msg_early',prompt:{text:'Only once'}})
  try {
    const early=await Promise.race([sending.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),150))])
    assert.equal(early,true,'A stored Desktop message should be admitted without waiting for its HTTP acknowledgement')
    assert.equal(forwarded,1)
  } finally { release(); await sending }
  const reopened=await createDesktopAPI({request,storePath:join(root,'admissions.json')})
  await reopened.handle('POST','/api/session/ses_one/prompt',{id:'msg_early',prompt:{text:'Only once'}})
  assert.equal(forwarded,1)
})

test('Desktop history uses legacy parts, preserves cursor and never switches execution engine', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bc-desktop-api-')); t.after(() => rm(root, {recursive:true,force:true}))
  const calls = []
  const request = async (path, method, body) => {
    calls.push({path,method,body})
    if (path === '/session/ses_one') return {data: {directory:'/project',agent:'build'}}
    if (path.startsWith('/session/ses_one/message?')) return {data: [{info:{id:'msg_one',role:'assistant'},parts:[{id:'part_one',type:'text',text:'Existing Desktop response'}]}],cursor:'older'}
    if (path.includes('/prompt_async')) return {data:undefined}
    if (path.includes('/message/msg_stable?')) return {data:{info:{id:'msg_stable',role:'user'},parts:[{type:'text',text:'Continue the same work'}]}}
    throw new Error(path)
  }
  const api = await createDesktopAPI({request, storePath:join(root,'admissions.json')})
  const page = await api.handle('GET','/api/session/ses_one/message?limit=50&order=desc')
  assert.equal(page.data.data[0].content[0].text,'Existing Desktop response')
  assert.equal(page.data.cursor.next,'older')
  const prompt = {id:'msg_stable',prompt:{text:'Continue the same work'}}
  await api.handle('POST','/api/session/ses_one/prompt',prompt)
  const reopened = await createDesktopAPI({request, storePath:join(root,'admissions.json')})
  await reopened.handle('POST','/api/session/ses_one/prompt',prompt)
  assert.equal(calls.filter(c=>c.path.includes('/prompt_async')).length,1)
  assert.equal(calls.find(c=>c.path.includes('/prompt_async')).body.messageID,'msg_stable')
  await assert.rejects(reopened.handle('POST','/api/session/ses_one/prompt',{...prompt,prompt:{text:'Different'}}), /identity/)
})
test('an uncertain Desktop admission is never automatically executed a second time', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bc-desktop-api-')); t.after(() => rm(root, {recursive:true,force:true}))
  let submissions=0
  const request = async path => {
    if(path === '/session/ses_one') return {data:{directory:'/project'}}
    if(path.includes('prompt_async')) { submissions++; throw new Error('connection lost') }
    throw Object.assign(new Error('not found'),{status:404})
  }
  const api=await createDesktopAPI({request,storePath:join(root,'admissions.json')})
  const prompt={id:'msg_one',prompt:{text:'Run tests'}}
  await assert.rejects(api.handle('POST','/api/session/ses_one/prompt',prompt))
  await assert.rejects(api.handle('POST','/api/session/ses_one/prompt',prompt),/unconfirmed/)
  assert.equal(submissions,1)
})
test('stored Desktop admission wins when the async acknowledgement fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bc-desktop-api-')); t.after(() => rm(root, {recursive:true,force:true}))
  let submissions=0, stored=false
  const request = async path => {
    if(path === '/session/ses_one') return {data:{directory:'/project'}}
    if(path.includes('prompt_async')) { submissions++; stored=true; throw Object.assign(new Error('acknowledgement failed'),{status:500}) }
    if(stored && path.includes('/message/msg_one?')) return {data:{info:{id:'msg_one',role:'user'},parts:[{type:'text',text:'Run tests'}]}}
    throw Object.assign(new Error('not found'),{status:404})
  }
  const storePath=join(root,'admissions.json')
  const api=await createDesktopAPI({request,storePath})
  const prompt={id:'msg_one',prompt:{text:'Run tests'}}
  assert.equal((await api.handle('POST','/api/session/ses_one/prompt',prompt)).data.data.id,'msg_one')
  const reopened=await createDesktopAPI({request,storePath})
  assert.equal((await reopened.handle('POST','/api/session/ses_one/prompt',prompt)).data.data.id,'msg_one')
  assert.equal(submissions,1)
})
test('an admission probe failure is reconciled without resending the prompt', async t => {
  const root=await mkdtemp(join(tmpdir(),'bc-desktop-api-'));t.after(()=>rm(root,{recursive:true,force:true}))
  let submissions=0, reads=0
  const request=async path=>{
    if(path==='/session/ses_one')return {data:{directory:'/project'}}
    if(path.includes('/prompt_async')){submissions++;return {data:undefined}}
    if(++reads===1)throw Object.assign(new Error('temporary read failure'),{status:500})
    return {data:{info:{id:'msg_one',role:'user'},parts:[{type:'text',text:'Run tests'}]}}
  }
  const api=await createDesktopAPI({request,storePath:join(root,'admissions.json')})
  const result=await api.handle('POST','/api/session/ses_one/prompt',{id:'msg_one',prompt:{text:'Run tests'}})
  assert.equal(result.data.data.id,'msg_one');assert.equal(submissions,1)
})
test('Desktop provider and agent choices exclude secrets and hidden agents', async t => {
  const root=await mkdtemp(join(tmpdir(),'bc-desktop-api-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const request=async path=>({data:path.startsWith('/provider')?{connected:['provider_one'],all:[{id:'provider_one',key:'private',models:{model_one:{id:'model_one',name:'Model',api:{key:'private'}}}},{id:'unconfigured',models:{unused:{id:'unused'}}}]}:[{name:'build',permission:{secret:'private'}},{name:'internal',hidden:true}]})
  const api=await createDesktopAPI({request,storePath:join(root,'admissions.json')})
  const models=await api.handle('GET','/api/model')
  assert.deepEqual(models.data.data,[{id:'model_one',providerID:'provider_one',name:'Model',enabled:true}])
  assert.equal(JSON.stringify(models).includes('private'),false)
  const agents=await api.handle('GET','/api/agent')
  assert.deepEqual(agents.data.data.map(a=>a.id),['build'])
  assert.equal(JSON.stringify(agents).includes('private'),false)
})
test('Desktop request decisions verify session ownership before reply',async t=>{
  const root=await mkdtemp(join(tmpdir(),'bc-desktop-api-'));t.after(()=>rm(root,{recursive:true,force:true}))
  let replies=0
  const request=async(path,method)=>{if(method==='POST')replies++;return {data:path==='/session/ses_one'?{directory:'/work'}:[{id:'per_one',sessionID:'ses_other'}]}}
  const api=await createDesktopAPI({request,storePath:join(root,'admissions.json')})
  await assert.rejects(api.handle('POST','/api/session/ses_one/permission/per_one/reply',{reply:'once'}),/resolved|unavailable/)
  assert.equal(replies,0)
})

test('a successful async acknowledgement without a stored message stays unresolved',async t=>{
  const root=await mkdtemp(join(tmpdir(),'bc-desktop-api-'));t.after(()=>rm(root,{recursive:true,force:true}))
  let submissions=0, reads=0
  const request=async(path)=>{
    if(path==='/session/ses_one')return {data:{directory:'/work'}}
    if(path.includes('/prompt_async')){submissions++;return {data:undefined}}
    reads++;throw Object.assign(new Error('not stored'),{status:404})
  }
  const api=await createDesktopAPI({request,storePath:join(root,'admissions.json')})
  const prompt={id:'msg_one',prompt:{text:'Keep this draft'}}
  await assert.rejects(api.handle('POST','/api/session/ses_one/prompt',prompt),/unconfirmed/)
  const reopened=await createDesktopAPI({request,storePath:join(root,'admissions.json')})
  await assert.rejects(reopened.handle('POST','/api/session/ses_one/prompt',prompt),/unconfirmed/)
  assert.equal(submissions,1);assert.ok(reads>0)
})
test('confirmed mobile selections are consumed and a later Desktop choice wins',async t=>{
  const root=await mkdtemp(join(tmpdir(),'bc-desktop-api-'));t.after(()=>rm(root,{recursive:true,force:true}))
  let current={directory:'/work',agent:'build',model:{id:'desktop_A',providerID:'provider'}}
  const prompts=[]
  const request=async(path,method,body)=>{
    if(path==='/session/ses_one')return {data:current}
    if(path.includes('/prompt_async')){prompts.push(body);return {data:undefined}}
    const id=/message\/(msg_[a-z]+)\?/.exec(path)?.[1]
    return {data:{info:{id,role:'user'},parts:[{type:'text',text:'Run'}]}}
  }
  const api=await createDesktopAPI({request,storePath:join(root,'admissions.json')})
  await api.handle('POST','/api/session/ses_one/model',{model:{id:'mobile_A',providerID:'provider'}})
  await api.handle('POST','/api/session/ses_one/prompt',{id:'msg_first',prompt:{text:'Run'}})
  current={...current,agent:'plan',model:{id:'desktop_B',providerID:'provider'}}
  await api.handle('POST','/api/session/ses_one/prompt',{id:'msg_second',prompt:{text:'Run'}})
  assert.equal(prompts[0].model.modelID,'mobile_A');assert.equal(prompts[1].model.modelID,'desktop_B');assert.equal(prompts[1].agent,'plan')
})
