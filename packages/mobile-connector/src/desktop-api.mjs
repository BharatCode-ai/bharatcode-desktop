import { writeFile, rename } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { openAdmissions } from './admissions.mjs'

const fail = (status, message) => Object.assign(new Error(message), { status })
const normalizedPermission = item => ({ ...item, action: item.permission, resources: item.patterns ?? [] })
export function desktopMessage(item) {
  const info = item.info, parts = item.parts ?? []
  const texts = parts.filter(p => p.type === 'text').map(p => ({id:p.id,type:'text',text:p.text ?? ''}))
  const error = info.error?.data?.message ?? info.error?.message
  if (error) texts.push({id:info.id + '_error',type:'text',text:`The computer reported: ${error}`})
  return {id:info.id,type:info.role,time:info.time,
    ...(info.role === 'user' ? {text:texts.map(p=>p.text).join('\n\n')} : {content:[...texts,...parts.filter(p=>p.type==='tool').map(p=>({id:p.id,type:'tool',name:p.tool,state:{...p.state,content:p.state?.output ? [{type:'text',text:p.state.output}] : []}}))]})}
}

// Desktop's default runtime serves native session metadata but continues chats
// through its compatibility engine. Keep that same engine and message tables.
export async function createDesktopAPI({ request, storePath }) {
  const { state, recovered } = await openAdmissions(storePath)
  let writes = Promise.resolve()
  const save = () => {
    const json = JSON.stringify(state)
    const operation = writes.then(async()=>{await writeFile(storePath+'.tmp',json,{mode:0o600});await rename(storePath+'.tmp',storePath)})
    writes = operation.catch(()=>{})
    return operation
  }
  const locations = new Set([''])
  const pending = new Map()
  const located = (path, directory) => path + (path.includes('?') ? '&' : '?') + new URLSearchParams({directory})
  async function session(id, signal) {
    const value = (await request('/session/'+id,'GET',undefined,signal)).data
    if (!value || typeof value.directory !== 'string') throw fail(502,'Desktop session location unavailable')
    locations.add(value.directory)
    return value
  }
  async function stored(id, body, directory, signal) {
    let message
    try { message = (await request(located(`/session/${id}/message/${body.id}`, directory), 'GET', undefined, signal)).data }
    catch (error) { if (error.status !== 404) throw error; return false }
    return message?.info?.id === body.id && message.info.role === 'user' &&
      (message.parts ?? []).filter(p => p.type === 'text').map(p => p.text).join('') === body.prompt.text
  }
  async function handle(method, raw, body, signal) {
    const url = new URL(raw,'http://localhost'), path = url.pathname
    if (method === 'POST' && path === '/api/session' && recovered) {
      // Session creation can adopt a caller-supplied identity. During recovery
      // only our own fresh random identity proves that a session has no lost
      // admissions. Wall-clock timestamps cannot prove this after clock changes.
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.id !== undefined)
        throw fail(400,'A fresh conversation identity is required after mobile history recovery')
      if ((state.recoverySessions?.length ?? 0) >= 10000) throw fail(507,'Mobile recovery conversation history is full')
      const id = 'ses_' + randomUUID().replaceAll('-','')
      const result = await request(raw,'POST',{...body,id},signal)
      if (result.data?.data?.id !== id) throw fail(502,'Desktop did not create the requested conversation')
      state.recoverySessions = [...(state.recoverySessions ?? []),id]
      await save()
      return result
    }
    const match = /^\/api\/session\/([A-Za-z0-9_-]+)\/(message|prompt|interrupt|permission|question|model|agent)$/.exec(path)
    if (method==='GET' && path==='/api/session') {
      const result = await request(raw,'GET',undefined,signal)
      for(const item of result.data.data ?? []) if(item.location?.directory) locations.add(item.location.directory)
      return {data:result.data}
    }
    if (method==='GET' && path==='/api/session/active') {
      const data={}
      for(const directory of locations) {
        const result=await request(located('/session/status',directory),'GET',undefined,signal)
        for(const [id,value] of Object.entries(result.data ?? {})) if(value.type!=='idle') data[id]={type:'running'}
      }
      return {data:{data}}
    }
    if(method==='GET' && (path==='/api/model' || path==='/api/agent')) {
      const directory=url.searchParams.get('location[directory]') ?? ''
      const result=await request(located(path==='/api/model'?'/provider':'/agent',directory),'GET',undefined,signal)
      const data=path==='/api/agent' ? (result.data ?? []).filter(a=>!a.hidden).map(a=>({id:a.name,name:a.name,description:a.description,mode:a.mode}))
        : (result.data.all ?? []).filter(p=>(result.data.connected ?? []).includes(p.id)).flatMap(p=>Object.values(p.models ?? {}).map(m=>({id:m.id,providerID:p.id,name:m.name,enabled:true})))
      return {data:{data}}
    }
    if(method==='GET' && /^\/api\/(permission|question)\/request$/.test(path)) {
      const kind=path.split('/')[2], directory=url.searchParams.get('location[directory]') ?? ''
      const result=await request(located('/'+kind,directory),'GET',undefined,signal)
      return {data:{data:kind==='permission' ? (result.data ?? []).map(normalizedPermission) : result.data ?? []}}
    }
    const reply=/^\/api\/session\/([A-Za-z0-9_-]+)\/(permission|question)\/([A-Za-z0-9_-]+)\/reply$/.exec(path)
    if(method==='POST' && reply) {
      const [,id,kind,requestID]=reply, info=await session(id,signal)
      const requests=(await request(located('/'+kind,info.directory),'GET',undefined,signal)).data ?? []
      if(!requests.some(item=>item.id===requestID && item.sessionID===id)) throw fail(404,'Request resolved or unavailable')
      const result=await request(located(`/${kind}/${requestID}/reply`,info.directory),'POST',body,signal)
      return {data:{data:result.data}}
    }
    if(!match) return
    const [,id,kind]=match
    const info=await session(id,signal)
    if(method==='GET' && kind==='message') {
      const params=new URLSearchParams({limit:url.searchParams.get('limit') ?? '50',directory:info.directory})
      const cursor=url.searchParams.get('cursor'); if(cursor) params.set('before',cursor)
      const result=await request(`/session/${id}/message?${params}`,'GET',undefined,signal)
      return {data:{data:(result.data ?? []).map(desktopMessage).reverse(),cursor:{next:result.cursor}}}
    }
    if(method==='GET' && (kind==='permission' || kind==='question')) {
      const result=await request(located('/'+kind,info.directory),'GET',undefined,signal)
      const data=(result.data ?? []).filter(item=>item.sessionID===id)
      return {data:{data:kind==='permission'?data.map(normalizedPermission):data}}
    }
    if(method==='POST' && (kind==='model' || kind==='agent')) {
      if(kind==='agent' ? typeof body?.agent!=='string' : typeof body?.model?.id!=='string' || typeof body?.model?.providerID!=='string') throw fail(400,'Invalid session configuration')
      state.selections[id]={...state.selections[id],...body}; await save(); return {data:{}}
    }
    if(method==='POST' && kind==='interrupt') {
      await request(located(`/session/${id}/abort`,info.directory),'POST',undefined,signal)
      return {data:{}}
    }
    if(method==='POST' && kind==='prompt') {
      if(!body || !/^msg_[A-Za-z0-9_-]+$/.test(body.id ?? '') || typeof body.prompt?.text!=='string') throw fail(400,'Invalid prompt')
      const key=id+'.'+body.id, hash=createHash('sha256').update(JSON.stringify(body)).digest('hex')
      const previous=state.admissions[key]
      if(previous && previous.hash!==hash) throw fail(409,'Message identity was used for a different prompt')
      if(pending.has(key)) { await pending.get(key); return {data:{data:{id:body.id}}} }
      if(previous?.state==='admitted') return {data:{data:{id:body.id}}}
      if(previous) {
        // A crash or lost upstream acknowledgement is ambiguous. A matching
        // stored Desktop message proves admission; never blindly execute again.
        if (await stored(id,body,info.directory,signal)) {
          state.admissions[key]={hash,state:'admitted'};
          if(JSON.stringify(state.selections[id])===JSON.stringify(previous.selection)) delete state.selections[id];
          await save(); return {data:{data:{id:body.id}}}
        }
        throw fail(409,'Desktop delivery is unconfirmed. Check the conversation on your computer before continuing.')
      }
      if (recovered && !state.recoverySessions?.includes(id)) {
        // With the old journal lost, absence in Desktop is not proof that an
        // old request was never forwarded. Only our durably recorded fresh
        // conversation identities can submit without that lost history.
        if (await stored(id,body,info.directory,signal)) {
          state.admissions[key]={hash,state:'admitted'}; await save()
          return {data:{data:{id:body.id}}}
        }
        throw fail(409,'Mobile delivery history was recovered. Check this conversation on your computer; start a new conversation on your phone to send safely.')
      }
      if(Object.keys(state.admissions).length>=10000) throw fail(507,'Mobile admission history is full')
      const operation=(async()=>{
        const selection=state.selections[id], model=selection?.model ?? info.model
        state.admissions[key]={hash,state:'forwarding',selection}; await save()
        let confirmed = false
        try {
          let submissionError
          // The compatibility engine may keep its async HTTP response open
          // after storing the message. Durable identity is the admission proof.
          const submission = request(located(`/session/${id}/prompt_async`,info.directory),'POST',{
            messageID:body.id, agent:selection?.agent ?? info.agent,
            ...(model ? {model:{providerID:model.providerID,modelID:model.id},variant:model.variant} : {}),
            parts:[{type:'text',text:body.prompt.text}],
          },signal).catch(error => { submissionError = error })
          for (let attempt = 0; attempt < 30; attempt++) {
            if (await stored(id, body, info.directory, signal)) { confirmed = true; break }
            if (submissionError) throw submissionError
            await delay(100, undefined, { signal })
          }
          // Keep the rejection handler attached even when stored admission
          // lets this response finish before the upstream request does.
          void submission
        } catch (error) {
          // The engine can store and execute the message before its HTTP
          // acknowledgement or admission probe fails. Confirm it without ever
          // forwarding the prompt again; otherwise preserve the original error.
          confirmed = await stored(id, body, info.directory, signal).catch(() => false)
          if (!confirmed) throw error
        }
        if (!confirmed) throw fail(409, 'Desktop delivery is unconfirmed. Keep this draft and check your computer.')
        state.admissions[key]={hash,state:'admitted'};
        if (state.selections[id] === selection) delete state.selections[id];
        await save()
      })()
      pending.set(key,operation)
      try { await operation } finally { pending.delete(key) }
      return {data:{data:{id:body.id}}}
    }
  }
  return {handle}
}
