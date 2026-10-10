// Registers this server's URL + secret with Telegram. Run once after deploying: npm run set-webhook
'use strict'
const token = process.env.TELEGRAM_BOT_TOKEN
const secret = process.env.TELEGRAM_WEBHOOK_SECRET
const domain = process.env.PUBLIC_URL || (process.env.DOMAIN && `https://${process.env.DOMAIN}`)
const api = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'
if (!token || !secret || !domain) {
  console.error('Need TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and DOMAIN (or PUBLIC_URL) in the environment / .env')
  process.exit(1)
}
const call = (method, body) => fetch(`${api}/bot${token}/${method}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json())

;(async () => {
  const url = `${domain.replace(/\/$/, '')}/telegram/webhook`
  const set = await call('setWebhook', { url, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true })
  if (!set.ok) throw new Error(set.description)
  await call('setMyCommands', { commands: [
    { command: 'fit', description: 'Outfit for an event, e.g. /fit rooftop dinner' },
    { command: 'worn', description: 'Log what you wore: /worn <ids> 8/10 notes' },
    { command: 'inspo', description: 'Save an inspo link (or send a photo captioned inspo)' },
    { command: 'audit', description: 'Full closet rework plan' },
    { command: 'purge', description: 'What to clear out' },
    { command: 'help', description: 'How to use the stylist' },
  ] })
  const info = await call('getWebhookInfo', {})
  console.log(`Webhook set to ${info.result.url}`)
  if (info.result.last_error_message) console.log(`Last delivery error: ${info.result.last_error_message}`)
})().catch((err) => { console.error('setWebhook failed:', err.message); process.exit(1) })
