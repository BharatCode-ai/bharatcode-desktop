import { StringDecoder } from 'node:string_decoder'

// Never forward the global sidecar event bus. Project only the selected
// conversation's text and invalidation signals; configuration stays local.
export async function* projectEvents(source, sessionID, options = {}) {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  const roles = new Map(), parts = new Map(), lookedUp = new Set()
  for await (const chunk of source) {
    buffer += decoder.write(chunk)
    let match
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      if (match.index > 1_048_576) throw new Error('Event frame too large')
      const frame = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
      if (!data) continue
      let event
      try { event = JSON.parse(data) } catch { continue }
      event.data ??= event.properties
      if (event.data?.sessionID !== sessionID) continue
      if (options.desktop) {
        const data = event.data
        if (event.type === 'message.part.delta' && !parts.has(data.partID) && options.resolveMessage && !lookedUp.has(data.messageID)) {
          lookedUp.add(data.messageID)
          if (lookedUp.size > 2000) lookedUp.delete(lookedUp.values().next().value)
          try {
            const message = await options.resolveMessage(data.messageID)
            if (message?.info?.id === data.messageID) {
              roles.set(message.info.id, message.info.role)
              for (const part of message.parts ?? []) parts.set(part.id, part.type)
            }
          } catch { /* History refresh recovers completed content if this lookup races removal. */ }
        }
        if (event.type === 'message.updated' && data.info?.id) roles.set(data.info.id, data.info.role)
        if (event.type === 'message.part.updated' && data.part?.id) parts.set(data.part.id, data.part.type)
        if (roles.size > 2000) roles.delete(roles.keys().next().value)
        if (parts.size > 4000) parts.delete(parts.keys().next().value)
        if (event.type === 'message.part.delta' && data.field === 'text' && parts.get(data.partID) === 'text' && roles.get(data.messageID) === 'assistant') {
          event = { id: event.id, type: 'session.next.text.delta', data: { sessionID, assistantMessageID: data.messageID, textID: data.partID, delta: data.delta } }
        } else if (event.type === 'message.part.updated' && data.part?.type === 'text' && roles.get(data.part.messageID) === 'assistant') {
          const phase = data.part.time?.end === undefined ? 'started' : 'ended'
          event = { id: event.id, type: 'session.next.text.' + phase, data: { sessionID, assistantMessageID: data.part.messageID, textID: data.part.id, text: data.part.text } }
        } else if (/^(permission|question)\.(asked|replied|rejected)$/.test(event.type)) {
          event = { id: event.id, type: event.type.replace('.', '.v2.'), data: { sessionID, id: data.id, requestID: data.requestID } }
        } else if (/^(message\.(updated|removed|part\.(updated|removed|delta))|session\.(status|error|updated))$/.test(event.type)) {
          event = { id: event.id, type: 'session.next.tool.progress', data: { sessionID } }
        } else continue
      }
      const text = /^session\.next\.text\.(started|delta|ended)$/.test(event.type)
      const invalidation = /^(permission\.v2\.(asked|replied)|question\.v2\.(asked|replied|rejected)|session\.next\.(step\.(started|ended|failed)|tool\.(called|progress|success|failed)))$/.test(event.type)
      if (!text && !invalidation) continue
      const fields = text ? ['sessionID', 'assistantMessageID', 'textID', 'delta', 'text'] : ['sessionID', 'requestID', 'id']
      yield { id: event.id, type: event.type, data: Object.fromEntries(fields.filter(key => Object.hasOwn(event.data, key)).map(key => [key, event.data[key]])) }
    }
    if (buffer.length > 1_048_576) throw new Error('Event frame too large')
  }
}
