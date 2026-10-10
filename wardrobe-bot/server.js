// Telegram webhook receiver -> n8n forwarder for the wardrobe stylist bot.
//
// Telegram POSTs every update here. We verify it really came from Telegram, answer 200 at once
// (so Telegram never retries), then normalise the update and forward it to the matching n8n webhook:
//   photo / image file          -> N8N_INGEST_URL   (adds a closet item)
//   photo captioned "inspo ..." -> N8N_INSPO_URL    (inspiration board)
//   /inspo <link> [notes]       -> N8N_INSPO_URL
//   /fit [context]              -> N8N_FIT_URL
//   /worn <item ids> [8/10] [notes] -> N8N_WORN_URL
//   /purge [item ids]           -> N8N_PURGE_URL
//   /audit [focus]              -> N8N_AUDIT_URL    (full closet rework plan)
// n8n does the AI + database work and replies to the user itself (it gets chat_id in every payload).
'use strict'

const crypto = require('node:crypto')
const express = require('express')

const env = (name, fallback) => process.env[name] ?? fallback

const config = {
  port: Number(env('PORT', 3000)),
  botToken: env('TELEGRAM_BOT_TOKEN', ''),
  webhookSecret: env('TELEGRAM_WEBHOOK_SECRET', ''),
  allowedChatIds: new Set(env('ALLOWED_CHAT_IDS', '').split(',').map((s) => s.trim()).filter(Boolean)),
  telegramApi: env('TELEGRAM_API_BASE', 'https://api.telegram.org'),
  n8nSecret: env('N8N_SHARED_SECRET', ''),
  n8n: {
    ingest: env('N8N_INGEST_URL', ''),
    inspo: env('N8N_INSPO_URL', ''),
    fit: env('N8N_FIT_URL', ''),
    worn: env('N8N_WORN_URL', ''),
    purge: env('N8N_PURGE_URL', ''),
    audit: env('N8N_AUDIT_URL', ''),
  },
  forwardTimeoutMs: Number(env('FORWARD_TIMEOUT_MS', 15000)),
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const RATING_RE = /(?:^|\s)(10|[1-9])\s*\/\s*10\b/
const URL_RE = /https?:\/\/[^\s<>"]+/i
const INSPO_CAPTION_RE = /^\s*#?inspo\b[\s:,-]*/i

const HELP = [
  'Wardrobe stylist commands:',
  '📸 Send a photo of one of your pieces to add it to your closet.',
  '✨ Send a photo captioned "inspo" (or /inspo <link>) to save inspiration.',
  '/fit <event> — outfit for an occasion, e.g. /fit rooftop dinner, 18°C',
  '/worn <item ids> [8/10] [notes] — log what you wore (+ optional rating)',
  '/audit [focus] — full closet rework: keep / tailor / purge + what to buy',
  '/purge — suggestions for what to clear out · /purge <ids> — mark as purged',
].join('\n')

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

async function telegram(method, body) {
  const res = await fetch(`${config.telegramApi}/bot${config.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  const data = await res.json().catch(() => ({}))
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || res.status}`)
  return data.result
}

function reply(chatId, text, replyTo) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text,
    ...(replyTo && { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
  }).catch((err) => console.error(err.message))
}

/** Resolve a file_id to its download path. The full URL embeds the bot token: only hand it to n8n. */
async function resolveFile(fileId) {
  const file = await telegram('getFile', { file_id: fileId })
  if (!file.file_path) throw new Error('Telegram returned no file_path (file may be over 20 MB)')
  return {
    file_path: file.file_path,
    file_url: `${config.telegramApi}/file/bot${config.botToken}/${file.file_path}`,
    file_size: file.file_size,
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** "/fit@MyBot  rooftop dinner" -> { command: "fit", args: "rooftop dinner" } */
function parseCommand(text) {
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec((text || '').trim())
  return m ? { command: m[1].toLowerCase(), args: (m[2] || '').trim() } : null
}

/** Pull UUIDs out of free text; whatever is left over becomes notes. */
function splitIds(args) {
  const ids = [...new Set((args.match(UUID_RE) || []).map((s) => s.toLowerCase()))]
  const notes = args.replace(UUID_RE, ' ').replace(/[,;|]+/g, ' ').replace(/\s+/g, ' ').trim()
  return { ids, notes: notes || null }
}

/** Largest photo size, or an image sent "as file" (uncompressed). */
function pickImage(message) {
  if (Array.isArray(message.photo) && message.photo.length) {
    const p = message.photo.reduce((a, b) => ((b.width * b.height) > (a.width * a.height) ? b : a))
    return { file_id: p.file_id, file_unique_id: p.file_unique_id, width: p.width, height: p.height, mime_type: 'image/jpeg' }
  }
  const d = message.document
  if (d && /^image\//.test(d.mime_type || '')) {
    return { file_id: d.file_id, file_unique_id: d.file_unique_id, mime_type: d.mime_type, file_name: d.file_name }
  }
  return null
}

function baseFields(update, message) {
  return {
    update_id: update.update_id,
    chat_id: message.chat.id,
    user_id: message.from?.id ?? null,
    username: message.from?.username ?? null,
    message_id: message.message_id,
    sent_at: new Date(message.date * 1000).toISOString(),
  }
}

/**
 * Turn a Telegram update into { route, payload } for n8n, or { reply } for things we answer directly.
 * Exported for tests.
 */
async function buildForward(update) {
  const message = update.message
  if (!message) return null // edits, reactions, etc. are ignored

  const base = baseFields(update, message)
  const image = pickImage(message)
  if (image) {
    const file = await resolveFile(image.file_id)
    const caption = message.caption?.trim() || ''
    if (INSPO_CAPTION_RE.test(caption)) {
      const notes = caption.replace(INSPO_CAPTION_RE, '').trim()
      return {
        route: 'inspo',
        payload: { type: 'inspo', ...base, photo: { ...image, ...file }, source_url: notes.match(URL_RE)?.[0] || null, notes: notes || null },
      }
    }
    return {
      route: 'ingest',
      payload: { type: 'ingest', ...base, photo: { ...image, ...file }, caption: caption || null },
    }
  }

  const cmd = parseCommand(message.text)
  if (!cmd) {
    if (message.document || message.video || message.animation) {
      return { reply: 'Please send clothing photos as a photo (or an image file).' }
    }
    return { reply: HELP }
  }

  switch (cmd.command) {
    case 'start':
    case 'help':
      return { reply: HELP }
    case 'fit':
      return {
        route: 'fit',
        payload: { type: 'fit', ...base, event_context: cmd.args || 'everyday — no specific occasion given' },
      }
    case 'worn': {
      const { ids, notes } = splitIds(cmd.args)
      if (!ids.length) return { reply: 'Usage: /worn <item ids> [8/10] [notes]\nTip: copy the ids from a /fit suggestion.' }
      const rating = notes?.match(RATING_RE)
      const cleanNotes = rating ? notes.replace(RATING_RE, ' ').replace(/\s+/g, ' ').trim() || null : notes
      return {
        route: 'worn',
        payload: {
          type: 'worn', ...base, item_ids: ids, worn_date: base.sent_at.slice(0, 10),
          feedback_rating: rating ? Number(rating[1]) : null, feedback_notes: cleanNotes,
        },
      }
    }
    case 'inspo': {
      const url = cmd.args.match(URL_RE)?.[0]
      if (!url) return { reply: 'Send an inspo photo with the caption "inspo", or: /inspo <link> [what you like about it]' }
      const notes = cmd.args.replace(url, ' ').replace(/\s+/g, ' ').trim() || null
      return { route: 'inspo', payload: { type: 'inspo', ...base, photo: null, source_url: url, notes } }
    }
    case 'audit':
      return { route: 'audit', payload: { type: 'audit', ...base, focus: cmd.args || null } }
    case 'purge': {
      const { ids, notes } = splitIds(cmd.args)
      return {
        route: 'purge',
        payload: { type: 'purge', ...base, mode: ids.length ? 'mark' : 'suggest', item_ids: ids, notes },
      }
    }
    default:
      return { reply: `Unknown command /${cmd.command}\n\n${HELP}` }
  }
}

// ---------------------------------------------------------------------------
// Forwarding to n8n
// ---------------------------------------------------------------------------

async function forwardToN8n(route, payload) {
  const url = config.n8n[route]
  if (!url) throw new Error(`N8N_${route.toUpperCase()}_URL is not configured`)
  const headers = { 'Content-Type': 'application/json' }
  if (config.n8nSecret) headers['X-Bot-Secret'] = config.n8nSecret

  let lastErr
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(config.forwardTimeoutMs),
      })
      if (res.ok) return
      lastErr = new Error(`n8n ${route} webhook returned ${res.status}`)
      if (res.status < 500) break // config problem (404 wrong URL, 401/403 secret) - retrying won't help
    } catch (err) {
      lastErr = err
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, 1000))
  }
  throw lastErr
}

// Telegram may deliver the same update twice if a response is slow; remember recent ids.
const seen = new Set()
function isDuplicate(updateId) {
  if (seen.has(updateId)) return true
  seen.add(updateId)
  if (seen.size > 1000) seen.delete(seen.values().next().value)
  return false
}

async function handleUpdate(update) {
  const message = update.message
  if (!message?.chat) return
  const chatId = String(message.chat.id)

  // Locked until ALLOWED_CHAT_IDS is set, so nobody else can spend your API credits.
  if (!config.allowedChatIds.has(chatId)) {
    console.warn(`Ignoring message from non-allowed chat ${chatId}`)
    return reply(message.chat.id, `This is a private bot. Your chat ID is ${chatId} — add it to ALLOWED_CHAT_IDS if this is you.`)
  }

  let action
  try {
    action = await buildForward(update)
  } catch (err) {
    console.error('Could not process update', update.update_id, err.message)
    return reply(message.chat.id, "⚠️ Couldn't fetch that photo from Telegram. Please try again.", message.message_id)
  }
  if (!action) return
  if (action.reply) return reply(message.chat.id, action.reply, message.message_id)

  try {
    await forwardToN8n(action.route, action.payload)
    console.log(`update ${update.update_id} -> n8n ${action.route}`)
  } catch (err) {
    console.error(`Forward to n8n ${action.route} failed:`, err.message)
    await reply(message.chat.id, '⚠️ The stylist engine is unreachable right now. Please try again in a minute.', message.message_id)
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))

  app.get('/healthz', (_req, res) => res.json({ ok: true }))

  app.post('/telegram/webhook', (req, res) => {
    if (!config.webhookSecret || !safeEqual(req.get('X-Telegram-Bot-Api-Secret-Token') || '', config.webhookSecret)) {
      return res.sendStatus(401)
    }
    const update = req.body
    if (!update || typeof update.update_id !== 'number') return res.sendStatus(400)
    res.sendStatus(200) // ack immediately; Telegram retries slow responses
    if (isDuplicate(update.update_id)) return
    handleUpdate(update).catch((err) => console.error('Unhandled update error', err))
  })

  return app
}

function checkConfig() {
  const missing = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'N8N_INGEST_URL', 'N8N_INSPO_URL', 'N8N_FIT_URL',
    'N8N_WORN_URL', 'N8N_PURGE_URL', 'N8N_AUDIT_URL']
    .filter((k) => !process.env[k])
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')} (see .env.example)`)
    process.exit(1)
  }
  if (!config.allowedChatIds.size) {
    console.warn('ALLOWED_CHAT_IDS is empty: the bot will only reply with chat IDs until you set it.')
  }
}

if (require.main === module) {
  checkConfig()
  createApp().listen(config.port, () => console.log(`Wardrobe bot webhook listening on :${config.port}`))
}

module.exports = { createApp, buildForward, parseCommand, splitIds, pickImage, handleUpdate, config }
