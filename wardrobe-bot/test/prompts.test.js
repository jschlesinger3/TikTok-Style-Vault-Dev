// Executes the n8n Code nodes exactly as written in prompts.md and checks the Claude requests they build.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const md = fs.readFileSync(path.join(__dirname, '..', 'prompts.md'), 'utf8')
// The first ```js block after a heading/line that names the node.
const find = (name) => {
  const at = md.indexOf(name)
  assert.ok(at >= 0, `${name} not found in prompts.md`)
  const m = /```js\n([\s\S]*?)```/.exec(md.slice(at))
  assert.ok(m, `no code block after ${name}`)
  return m[1]
}
// n8n Code node: top-level `return`, $input.first().json, $('Node').first().json
function runNode(code, input, nodes = {}) {
  const $input = { first: () => ({ json: input }) }
  const $ = (name) => ({ first: () => ({ json: nodes[name] }) })
  return new Function('$input', '$', code)($input, $)
}

const profile = { skin_tone: 'olive, warm undertone', build: 'athletic', target_aesthetics: ['old-money tailoring'], color_rules: { best_colors: ['camel'] } }
const closet = [
  { id: '11111111-2222-4333-8444-555555555555', category: 'tailoring', sub_category: 'double-breasted blazer', primary_color: 'navy', secondary_color: null, fabric: 'wool', silhouette: 'structured', aesthetic_tags: ['old-money tailoring'], versatility_score: 9, wear_count: 3, last_worn: '2026-10-01', detailed_desc: 'x' },
  { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', category: 'footwear', sub_category: 'leather loafers', primary_color: 'brown', secondary_color: null, fabric: 'leather', silhouette: 'penny', aesthetic_tags: [], versatility_score: 8, wear_count: 0, last_worn: null, detailed_desc: 'y' },
]
const ctx = { chat_id: 42, profile, closet, inspo: [{ formula: 'trouser + hoodie + loafer' }], recent_wears: [] }

// Structured-output schema rules (unsupported keywords would 400 or be ignored).
function checkSchema(node, where = '$') {
  if (!node || typeof node !== 'object') return
  for (const bad of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'multipleOf', 'pattern']) {
    assert.ok(!(bad in node), `${where}: unsupported keyword ${bad}`)
  }
  if (node.type === 'object') {
    assert.equal(node.additionalProperties, false, `${where}: additionalProperties must be false`)
    assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${where}: every property should be required`)
    for (const [k, v] of Object.entries(node.properties)) checkSchema(v, `${where}.${k}`)
  }
  if (node.items) checkSchema(node.items, `${where}[]`)
  for (const v of node.anyOf || []) checkSchema(v, where)
}

function checkBody(body, { effort }) {
  assert.equal(body.model, 'claude-sonnet-5-5')
  assert.equal(body.fallbacks, 'default')
  assert.ok(body.max_tokens >= 8000)
  assert.equal(body.output_config.effort, effort)
  assert.equal(body.output_config.format.type, 'json_schema')
  assert.ok(!('thinking' in body) || body.thinking.type !== 'disabled')
  assert.ok(!('tool_choice' in body), 'forced tool use is rejected on this model')
  assert.ok(!('temperature' in body))
  const sys = body.system[0].text
  assert.match(sys, /STYLE BRIEF/)
  assert.match(sys, /tough, not sloppy/)
  assert.doesNotMatch(sys, /paste the Style Brief|\{STYLE_BRIEF\}/)
  checkSchema(body.output_config.format.schema)
  JSON.parse(JSON.stringify(body)) // serialisable
}

test('ingest request: base64 image + caption', () => {
  const [{ json }] = runNode(find('Code node: "Build ingest request"'), { image_b64: 'QUJD', mime_type: 'image/png', caption: 'new blazer', profile })
  checkBody(json.body, { effort: 'medium' })
  const [img, txt] = json.body.messages[0].content
  assert.deepEqual(img.source, { type: 'base64', media_type: 'image/png', data: 'QUJD' })
  assert.match(txt.text, /new blazer/)
  assert.match(json.body.system[0].text, /olive, warm undertone/)
  assert.deepEqual(json.body.output_config.format.schema.properties.items.items.properties.versatility_score.enum, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
})

test('inspo request: with image, and link-only', () => {
  const withImg = runNode(find('Code node: "Build inspo request"'), { ...ctx, image_b64: 'QUJD', photo: { mime_type: 'image/jpeg' }, notes: 'love it', source_url: null })[0].json.body
  checkBody(withImg, { effort: 'medium' })
  assert.equal(withImg.messages[0].content[0].type, 'image')
  assert.match(withImg.messages[0].content[1].text, /double-breasted blazer[\s\S]*love it/)
  const linkOnly = runNode(find('Code node: "Build inspo request"'), { ...ctx, photo: null, source_url: 'https://pin.it/x', notes: null })[0].json.body
  assert.equal(linkOnly.messages[0].content.length, 1)
  assert.match(linkOnly.messages[0].content[0].text, /cannot open it[\s\S]*No image was provided/)
})

test('fit request includes event, closet ids, inspo and wears', () => {
  const body = runNode(find('Code node: "Build fit request"'), { ...ctx, event_context: 'rooftop dinner' })[0].json.body
  checkBody(body, { effort: 'high' })
  const t = body.messages[0].content
  assert.match(t, /Event: rooftop dinner/)
  assert.match(t, /11111111-2222-4333-8444-555555555555/)
  assert.match(t, /trouser \+ hoodie \+ loafer/)
  assert.deepEqual(Object.keys(body.output_config.format.schema.properties.outfit.properties), ['top', 'bottom', 'footwear', 'statement'])
})

test('audit request', () => {
  const body = runNode(find('Code node: "Build audit request"'), { ...ctx, focus: 'shoes' })[0].json.body
  checkBody(body, { effort: 'high' })
  assert.equal(body.max_tokens, 16000)
  assert.match(body.messages[0].content, /focus on: shoes/)
  assert.deepEqual(body.output_config.format.schema.properties.verdicts.items.properties.verdict.enum, ['keep', 'tailor', 'restyle', 'purge'])
})

test('parse node: extracts JSON text, skips thinking/fallback blocks, surfaces errors', () => {
  const parse = find('Add this **Code node right after every HTTP Request node**')
  const ok = runNode(parse, { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"a":1}' }], usage: {} })
  assert.deepEqual(ok[0].json.result, { a: 1 })
  assert.throws(() => runNode(parse, { stop_reason: 'refusal', content: [] }), /declined/)
  assert.throws(() => runNode(parse, { stop_reason: 'max_tokens', content: [] }), /cut off/)
  assert.throws(() => runNode(parse, { type: 'error', error: { message: 'bad key' } }), /bad key/)
})

test('fit validator: formats reply, rejects invented ids', () => {
  const validate = find('Code node: "Validate + format fit"')
  const result = {
    event_read: { formality: 3, summary: 'smart-casual evening' }, look_name: 'Rooftop Navy',
    outfit: {
      top: { item_id: null, why: 'no knit polo yet' },
      bottom: { item_id: null, why: 'needs pleated trouser' },
      footwear: { item_id: closet[1].id, why: 'loafers dress it up' },
      statement: { item_id: closet[0].id, why: 'navy DB blazer' },
    },
    styling_instructions: ['Leave the blazer unbuttoned'], why_it_works_for_you: 'Shows the V.',
    inspo_reference: 'trouser + hoodie + loafer', swap_option: null, missing_piece_suggestion: 'ecru knit polo',
  }
  const [{ json }] = runNode(validate, { result }, { 'Build fit request': ctx })
  assert.equal(json.chat_id, 42)
  assert.deepEqual(json.item_ids, [closet[1].id, closet[0].id])
  assert.match(json.text, /Rooftop Navy[\s\S]*Top: — nothing suitable[\s\S]*Footwear: brown leather loafers[\s\S]*Statement: navy double-breasted blazer[\s\S]*\/worn aaaaaaaa/)
  const bad = structuredClone(result); bad.outfit.top.item_id = '99999999-9999-4999-8999-999999999999'
  assert.throws(() => runNode(validate, { result: bad }, { 'Build fit request': ctx }), /unknown item ids/)
})
