import test from 'node:test'
import assert from 'node:assert/strict'
import { allowed, tunnelOrigin } from '../src/policy.mjs'

test('project directory query encoding is allowed without allowing encoded API path traversal', () => {
  for (const directory of ['/work/fixture project', 'C:\\Projects\\Mobile']) {
    const query = new URLSearchParams({ 'location[directory]': directory })
    assert.equal(allowed('GET', '/api/question/request?' + query), true)
    assert.equal(allowed('GET', '/api/permission/request?' + query), true)
  }
  for (const path of ['/api/session/ses_one%2Fmessage', '/api/session/%2e%2e/model', '/api/session/ses_one%5cmessage']) {
    assert.equal(allowed('GET', path), false)
  }
  assert.equal(allowed('GET', '/api/question/request?location%5Bdirectory%5D=%00'), false)
  assert.equal(allowed('GET', '/api/question/request?unexpected=%2Fwork'), false)
})

test('only well-formed self-hosted HTTPS tenant origins are accepted', () => {
  assert.equal(tunnelOrigin('https://pc.tunnel.bharatcode.ai:443/'), 'https://pc.tunnel.bharatcode.ai')
  for (const value of ['https://pc.opentunnel.xyz', 'https://tunnel.bharatcode.ai', 'https://pc..tunnel.bharatcode.ai', 'https://-pc.tunnel.bharatcode.ai', 'https://pc.tunnel.bharatcode.ai/../', 'https://pc.tunnel.bharatcode.ai#', ' https://pc.tunnel.bharatcode.ai', 'https://pc.tunnel.bharatcode.ai\\@evil.com']) assert.throws(() => tunnelOrigin(value), value)
})
