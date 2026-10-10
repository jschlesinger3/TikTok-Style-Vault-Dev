// Runs server.js against fake Telegram + n8n servers.
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const received = { n8n: [], telegram: [] }
let n8nStatus = 200

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => handler(req, body ? JSON.parse(body) : null, res))
    }).listen(0, () => resolve(srv))
  })
}

let tg, n8n, app, base
const SECRET = 'tg-secret'
const ID1 = '11111111-2222-4333-8444-555555555555'
const ID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

test.before(async () => {
  tg = await listen((req, body, res) => {
    received.telegram.push({ path: req.url, body })
    const result = req.url.endsWith('/getFile') ? { file_id: body.file_id, file_path: 'photos/file_7.jpg', file_size: 1234 } : { message_id: 1 }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, result }))
  })
  n8n = await listen((req, body, res) => {
    received.n8n.push({ path: req.url, body, secret: req.headers['x-bot-secret'] })
    res.statusCode = n8nStatus
    res.end('{}')
  })
  const n8nUrl = `http://127.0.0.1:${n8n.address().port}`
  Object.assign(process.env, {
    TELEGRAM_BOT_TOKEN: '123:ABC', TELEGRAM_WEBHOOK_SECRET: SECRET, ALLOWED_CHAT_IDS: '42',
    TELEGRAM_API_BASE: `http://127.0.0.1:${tg.address().port}`, N8N_SHARED_SECRET: 'n8n-secret',
    N8N_INGEST_URL: `${n8nUrl}/ingest`, N8N_INSPO_URL: `${n8nUrl}/inspo`, N8N_FIT_URL: `${n8nUrl}/fit`,
    N8N_WORN_URL: `${n8nUrl}/worn`, N8N_PURGE_URL: `${n8nUrl}/purge`, N8N_AUDIT_URL: `${n8nUrl}/audit`,
    FORWARD_TIMEOUT_MS: '2000',
  })
  const { createApp } = require('../server.js')
  app = await new Promise((resolve) => { const s = createApp().listen(0, () => resolve(s)) })
  base = `http://127.0.0.1:${app.address().port}`
})
test.after(() => { tg.close(); n8n.close(); app.close() })

let nextUpdate = 1
const msg = (fields, chatId = 42) => ({
  update_id: nextUpdate++,
  message: { message_id: 7, date: 1791600000, chat: { id: chatId }, from: { id: chatId, username: 'me' }, ...fields },
})
const post = (update, secret = SECRET) => fetch(`${base}/telegram/webhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update),
})
async function settle(ms = 150) { await new Promise((r) => setTimeout(r, ms)) }
function reset() { received.n8n.length = 0; received.telegram.length = 0; n8nStatus = 200 }
const replies = () => received.telegram.filter((t) => t.path.endsWith('/sendMessage')).map((t) => t.body.text)

test('rejects requests without the Telegram secret', async () => {
  reset()
  assert.equal((await post(msg({ text: '/fit x' }), 'wrong')).status, 401)
  assert.equal((await post(msg({ text: '/fit x' }), '')).status, 401)
  await settle()
  assert.equal(received.n8n.length, 0)
})

test('photo -> ingest with largest size and file URL', async () => {
  reset()
  const r = await post(msg({ photo: [
    { file_id: 'small', file_unique_id: 's', width: 90, height: 90 },
    { file_id: 'big', file_unique_id: 'b', width: 1280, height: 960 },
  ], caption: 'new blazer' }))
  assert.equal(r.status, 200)
  await settle()
  const [f] = received.n8n
  assert.equal(f.path, '/ingest')
  assert.equal(f.secret, 'n8n-secret')
  assert.equal(f.body.type, 'ingest')
  assert.equal(f.body.chat_id, 42)
  assert.equal(f.body.photo.file_id, 'big')
  assert.match(f.body.photo.file_url, /\/file\/bot123:ABC\/photos\/file_7\.jpg$/)
  assert.equal(f.body.caption, 'new blazer')
})

test('image sent as a file is ingested too', async () => {
  reset()
  await post(msg({ document: { file_id: 'doc1', file_unique_id: 'd', mime_type: 'image/png', file_name: 'x.png' } }))
  await settle()
  assert.equal(received.n8n[0].path, '/ingest')
  assert.equal(received.n8n[0].body.photo.mime_type, 'image/png')
})

test('photo captioned inspo -> inspo route with notes and link', async () => {
  reset()
  await post(msg({ photo: [{ file_id: 'p', file_unique_id: 'u', width: 10, height: 10 }], caption: '#inspo: love the loafers https://vm.tiktok.com/abc/' }))
  await settle()
  const [f] = received.n8n
  assert.equal(f.path, '/inspo')
  assert.equal(f.body.source_url, 'https://vm.tiktok.com/abc/')
  assert.match(f.body.notes, /love the loafers/)
})

test('/inspo <link> without a photo', async () => {
  reset()
  await post(msg({ text: '/inspo https://pin.it/xyz the trouser drape' }))
  await settle()
  assert.deepEqual(
    { path: received.n8n[0].path, photo: received.n8n[0].body.photo, url: received.n8n[0].body.source_url, notes: received.n8n[0].body.notes },
    { path: '/inspo', photo: null, url: 'https://pin.it/xyz', notes: 'the trouser drape' })
})

test('/fit with bot-name suffix and context', async () => {
  reset()
  await post(msg({ text: '/fit@StylistBot rooftop dinner, 18°C' }))
  await settle()
  assert.equal(received.n8n[0].path, '/fit')
  assert.equal(received.n8n[0].body.event_context, 'rooftop dinner, 18°C')
})

test('/worn parses ids, rating and notes', async () => {
  reset()
  await post(msg({ text: `/worn ${ID1.toUpperCase()}, ${ID2} 8/10 felt sharp` }))
  await settle()
  const b = received.n8n[0].body
  assert.deepEqual(b.item_ids, [ID1, ID2])
  assert.equal(b.feedback_rating, 8)
  assert.equal(b.feedback_notes, 'felt sharp')
  assert.equal(b.worn_date, new Date(1791600000 * 1000).toISOString().slice(0, 10))
})

test('/worn without ids replies with usage instead of forwarding', async () => {
  reset()
  await post(msg({ text: '/worn the blue one' }))
  await settle()
  assert.equal(received.n8n.length, 0)
  assert.match(replies()[0], /Usage: \/worn/)
})

test('/purge suggest vs mark, /audit focus', async () => {
  reset()
  await post(msg({ text: '/purge' }))
  await post(msg({ text: `/purge ${ID1}` }))
  await post(msg({ text: '/audit shoes and outerwear' }))
  await settle()
  const byPath = Object.fromEntries(received.n8n.map((f) => [f.path + (f.body.mode || ''), f.body]))
  assert.deepEqual(byPath['/purgesuggest'].item_ids, [])
  assert.deepEqual(byPath['/purgemark'].item_ids, [ID1])
  assert.equal(byPath['/audit'].focus, 'shoes and outerwear')
})

test('help / unknown text answered locally', async () => {
  reset()
  await post(msg({ text: 'hello' }))
  await post(msg({ text: '/dance' }))
  await settle()
  assert.equal(received.n8n.length, 0)
  const r = replies()
  assert.ok(r.some((t) => t.startsWith('Wardrobe stylist commands')))
  assert.ok(r.some((t) => t.startsWith('Unknown command /dance')))
})

test('chats not on the allowlist are refused and told their id', async () => {
  reset()
  await post(msg({ text: '/fit x' }, 999))
  await settle()
  assert.equal(received.n8n.length, 0)
  assert.match(replies()[0], /private bot.*999/)
})

test('duplicate update ids are processed once', async () => {
  reset()
  const u = msg({ text: '/fit gym' })
  await post(u); await post(u)
  await settle()
  assert.equal(received.n8n.length, 1)
})

test('n8n 5xx is retried once, then the user is told', async () => {
  reset()
  n8nStatus = 500
  await post(msg({ text: '/fit wedding' }))
  await settle(1500)
  assert.equal(received.n8n.length, 2)
  assert.match(replies()[0], /unreachable/)
})

test('n8n 4xx is not retried', async () => {
  reset()
  n8nStatus = 404
  await post(msg({ text: '/fit wedding' }))
  await settle(400)
  assert.equal(received.n8n.length, 1)
})
