// Builds prompts.md from prompts.template.md + prompts/*.md, so the n8n Code nodes always embed exactly
// the prompt text Style Vault uses.   npm run build:prompts        (npm test checks it's up to date)
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (name) => fs.readFileSync(path.join(root, 'prompts', `${name}.md`), 'utf8').trim()

// Text -> JS template literal; {STYLE_BRIEF} becomes the STYLE_BRIEF constant.
const jsLiteral = (text) =>
  '`' + text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\{STYLE_BRIEF\}/g, '${STYLE_BRIEF}') + '`'

function build() {
  const markers = {
    STYLE_BRIEF_TEXT: read('style_brief'),
    STYLE_BRIEF_JS: jsLiteral(read('style_brief')),
    CLOSET_ITEM_TEXT: read('closet_item_vision'),
    INSPO_TEXT: read('inspo_vision'),
    STYLIST_TEXT: read('stylist'),
    STYLIST_SYSTEM_JS: jsLiteral(read('stylist')),
    AUDIT_TEXT: read('closet_audit'),
    AUDIT_SYSTEM_JS: jsLiteral(read('closet_audit')),
  }
  let out = fs.readFileSync(path.join(root, 'prompts.template.md'), 'utf8')
  for (const [k, v] of Object.entries(markers)) out = out.split(`{{${k}}}`).join(v)
  const left = out.match(/\{\{[A-Z_]+\}\}/)
  if (left) throw new Error(`Unknown marker ${left[0]} in prompts.template.md`)
  return out
}

if (require.main === module) {
  fs.writeFileSync(path.join(root, 'prompts.md'), build())
  console.log('prompts.md rebuilt')
}
module.exports = { build }
