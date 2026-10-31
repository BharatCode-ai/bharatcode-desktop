import test from 'node:test'
import assert from 'node:assert/strict'
import { projectEvents } from '../src/live.mjs'

test('live stream selects the conversation and excludes credentials and unrelated activity', async () => {
  async function* source() {
    const events = [
      { id: 'evt_1', type: 'session.next.text.delta', data: { sessionID: 'ses_one', assistantMessageID: 'msg_one', textID: 'txt_one', delta: 'Hi' } },
      { id: 'evt_2', type: 'session.next.text.delta', data: { sessionID: 'ses_other', delta: 'private' } },
      { id: 'evt_3', type: 'provider.updated', data: { sessionID: 'ses_one', key: 'secret' } },
      { id: 'evt_4', type: 'permission.v2.asked', data: { sessionID: 'ses_one', id: 'per_one' } },
    ]
    const bytes = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''))
    yield bytes.subarray(0, 15); yield bytes.subarray(15)
  }
  const events = []
  for await (const event of projectEvents(source(), 'ses_one')) events.push(event)
  assert.deepEqual(events.map(event => event.id), ['evt_1', 'evt_4'])
  assert.equal(JSON.stringify(events).includes('secret'), false)
})
test('live stream bounds unterminated frames', async () => {
  async function* source() { yield Buffer.alloc(1_048_577, 97) }
  await assert.rejects(async () => { for await (const _ of projectEvents(source(), 'ses_one')) {} }, /too large/)
})
test('Desktop compatibility events become selected-chat text and request signals', async () => {
  async function* source() {
    for(const event of [
      {id:'evt_message',type:'message.updated',data:{sessionID:'ses_one',info:{id:'msg_one',role:'assistant'}}},
      {id:'evt_part',type:'message.part.updated',data:{sessionID:'ses_one',part:{id:'prt_one',messageID:'msg_one',type:'text',text:''}}},
      {id:'evt_1',type:'message.part.delta',data:{sessionID:'ses_one',messageID:'msg_one',partID:'prt_one',field:'text',delta:'Continued'}},
      {id:'evt_2',type:'permission.asked',data:{sessionID:'ses_one',id:'per_one',metadata:{private:'not a notification field'}}},
      {id:'evt_3',type:'message.part.delta',data:{sessionID:'ses_other',messageID:'msg_other',field:'text',delta:'Other chat'}},
    ]) yield Buffer.from(`data: ${JSON.stringify(event)}\n\n`)
  }
  const events=[];for await(const event of projectEvents(source(),'ses_one',{desktop:true}))events.push(event)
  assert.deepEqual(events.map(e=>e.type),['session.next.tool.progress','session.next.text.started','session.next.text.delta','permission.v2.asked'])
  assert.equal(events[2].data.assistantMessageID,'msg_one')
  assert.equal(JSON.stringify(events).includes('private'),false)
})

test('attachment after text creation resolves unknown metadata once and streams deltas',async()=>{
  async function* source(){for(let i=0;i<2;i++)yield Buffer.from(`data: ${JSON.stringify({id:'evt_'+i,type:'message.part.delta',data:{sessionID:'ses_one',messageID:'msg_one',partID:'prt_one',field:'text',delta:'live'}})}\n\n`)}
  let lookups=0;const events=[]
  for await(const event of projectEvents(source(),'ses_one',{desktop:true,resolveMessage:async()=>{lookups++;return {info:{id:'msg_one',role:'assistant'},parts:[{id:'prt_one',type:'text'}]}}}))events.push(event)
  assert.equal(lookups,1);assert.deepEqual(events.map(e=>e.type),['session.next.text.delta','session.next.text.delta'])
})

test('Desktop text creation starts a part and only the completed snapshot ends it', async () => {
  async function* source() {
    for (const event of [
      { type: 'message.updated', properties: { sessionID: 'ses_one', info: { id: 'msg_one', role: 'assistant' } } },
      { type: 'message.part.updated', properties: { sessionID: 'ses_one', part: { id: 'txt_one', messageID: 'msg_one', type: 'text', text: '', time: { start: 100 } } } },
      { type: 'message.part.delta', properties: { sessionID: 'ses_one', messageID: 'msg_one', partID: 'txt_one', field: 'text', delta: 'Live answer' } },
      { type: 'message.part.updated', properties: { sessionID: 'ses_one', part: { id: 'txt_one', messageID: 'msg_one', type: 'text', text: 'Live answer', time: { start: 100, end: 200 } } } },
    ]) yield Buffer.from(`data: ${JSON.stringify(event)}\n\n`)
  }
  const events = []
  for await (const event of projectEvents(source(), 'ses_one', { desktop: true })) events.push(event)
  assert.deepEqual(events.map(event => event.type), ['session.next.tool.progress', 'session.next.text.started', 'session.next.text.delta', 'session.next.text.ended'])
  assert.equal(events.at(-1).data.text, 'Live answer')
})
