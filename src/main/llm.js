// One call() for every model provider. The rest of the app speaks Anthropic's message format
// (content blocks, tool_use / tool_result); OpenAI-compatible providers are translated here.
//  - openrouter: https://openrouter.ai — free models (ids ending ":free", or the "openrouter/free" router)
//  - omniroute:  a local OmniRoute gateway (http://localhost:20128/v1) that pools free tiers
//  - anthropic:  Claude through the official SDK
const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.default || sdk;
const store = require('./store');

const NAMES = { openrouter: 'OpenRouter', omniroute: 'OmniRoute', anthropic: 'Anthropic' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stopped = () => Object.assign(new Error('Stopped.'), { aborted: true });

function ready() {
  const p = store.getSettings().provider;
  return p === 'omniroute' || !!store.getSecret(p); // a local OmniRoute can run without a key
}
function describe() {
  const s = store.getSettings();
  return { provider: s.provider, name: NAMES[s.provider], model: s.provider === 'anthropic' ? s.model : s.providers[s.provider].model, ready: ready() };
}

// ---- Anthropic ----------------------------------------------------------------
const FALLBACK_MODELS = /^claude-(fable-5-[12]|opus-5(-5)?|sonnet-5-5)$/; // models that accept server-side refusal fallbacks
let fallbacksOk = true;

async function anthropicCall({ system, messages, tools, effort = 'low', model, signal }) {
  const apiKey = store.getSecret('anthropic');
  if (!apiKey) throw new Error('No Anthropic API key yet. Add one in Settings, or switch the provider to OpenRouter / OmniRoute free models.');
  const c = new Anthropic({ apiKey });
  const m = model || store.getSettings().model;
  const params = { model: m, max_tokens: 16000, system, messages, output_config: { effort } };
  if (tools && tools.length) params.tools = tools;
  try {
    if (fallbacksOk && FALLBACK_MODELS.test(m)) {
      try {
        return await c.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal });
      } catch (e) {
        if (!(e instanceof Anthropic.BadRequestError) || !/fallback/i.test(e.message)) throw e;
        fallbacksOk = false; // this account/platform does not take the fallbacks parameter
      }
    }
    return await c.messages.create(params, { signal });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key. Check it in Settings.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Rate limited by the Anthropic API. Give it a moment and try again.');
    if (e instanceof Anthropic.APIUserAbortError) throw stopped();
    if (e instanceof Anthropic.APIError) throw new Error(`Claude API error${e.status ? ` ${e.status}` : ''}: ${e.message}`);
    throw e;
  }
}

// ---- OpenAI-compatible (OpenRouter, OmniRoute) ----------------------------------
function part(b) {
  if (b.type === 'text') return { type: 'text', text: b.text };
  if (b.type === 'image') return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
  if (b.type === 'document' && b.source.type === 'text') return { type: 'text', text: `[Attached file: ${b.title || 'document'}]\n${b.source.data}` };
  if (b.type === 'document') return { type: 'file', file: { filename: b.title || 'document.pdf', file_data: `data:${b.source.media_type};base64,${b.source.data}` } };
  return { type: 'text', text: '' };
}

function toOpenAI(system, messages, keepImages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      out.push(calls.length ? { role: 'assistant', content: text || null, tool_calls: calls } : { role: 'assistant', content: text });
      continue;
    }
    const parts = [], images = [];
    for (const b of m.content) {
      if (b.type !== 'tool_result') { parts.push(part(b)); continue; }
      const blocks = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : b.content || [];
      out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: blocks.filter((x) => x.type === 'text').map((x) => x.text).join('\n') || 'ok' });
      images.push(...blocks.filter((x) => x.type === 'image').map(part)); // tool messages can't carry images in this format
    }
    if (images.length) out.push({ role: 'user', content: [{ type: 'text', text: 'Current screenshot:' }, ...images] });
    if (parts.length) out.push({ role: 'user', content: parts });
  }
  if (keepImages) { // long agent loops: older screenshots are dead weight on small free-model contexts
    let seen = 0;
    for (let i = out.length - 1; i >= 0; i--) {
      if (!Array.isArray(out[i].content)) continue;
      out[i].content = out[i].content.map((p) => (p.type === 'image_url' && ++seen > keepImages ? { type: 'text', text: '[older screenshot removed]' } : p));
    }
  }
  return out;
}

function fromOpenAI(json, model) {
  const msg = json.choices?.[0]?.message;
  if (!msg) throw new Error(json.error?.message || 'The model returned an empty response.');
  const content = [];
  let text = Array.isArray(msg.content) ? msg.content.map((p) => p.text || '').join('') : msg.content || '';
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim(); // some open models inline their reasoning
  if (text) content.push({ type: 'text', text });
  for (const c of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(c.function?.arguments || '{}'); } catch { input = { __invalid_json: String(c.function?.arguments).slice(0, 200) }; }
    content.push({ type: 'tool_use', id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.function?.name, input });
  }
  return { role: 'assistant', model: json.model || model, content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' };
}

function headersFor(provider) {
  const key = store.getSecret(provider);
  if (!key && provider === 'openrouter') throw new Error('No OpenRouter API key yet. Create a free one at openrouter.ai/keys and paste it in Settings.');
  return { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

async function openaiCall({ system, messages, tools, model, signal, keepImages }, provider) {
  const cfg = store.getSettings().providers[provider];
  const base = cfg.baseUrl.replace(/\/$/, '');
  const body = { model: model || cfg.model, messages: toOpenAI(system, messages, keepImages), max_tokens: 4096 };
  if (tools && tools.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  // Parse attached PDFs with OpenRouter's free text extractor rather than a paid OCR engine.
  if (provider === 'openrouter' && body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'file'))) body.plugins = [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }];
  const name = NAMES[provider];
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${base}/chat/completions`, { method: 'POST', headers: headersFor(provider), body: JSON.stringify(body), signal });
    } catch (e) {
      if (signal?.aborted) throw stopped();
      throw new Error(provider === 'omniroute' ? `Can't reach OmniRoute at ${base}. Start it (npx omniroute) or change the URL in Settings.` : `Can't reach ${name}: ${e.message}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) { await sleep(2000 * (attempt + 1)); if (signal?.aborted) throw stopped(); continue; }
    const raw = await res.text();
    let json = {};
    try { json = JSON.parse(raw); } catch { /* non-JSON error body */ }
    if (res.ok) return fromOpenAI(json, body.model);
    const detail = json.error?.message || raw.slice(0, 200);
    if (res.status === 401) throw new Error(`${name} rejected the API key. Check it in Settings.`);
    if (res.status === 402) throw new Error(`${name} says "${body.model}" needs credits. Pick a free model in Settings to stay at zero cost.`);
    if (res.status === 429) throw new Error(`The free model is rate-limited right now (${name}). Wait a minute, or pick another free model in Settings.`);
    if (res.status === 404) throw new Error(`${name} has no model "${body.model}". Use "Find free models" in Settings to pick one.`);
    throw new Error(`${name} error ${res.status}: ${detail}`);
  }
}

// params: { system, messages, tools, effort, model, signal, keepImages } → { content: [...], stop_reason }
function call(params) {
  const p = store.getSettings().provider;
  return p === 'anthropic' ? anthropicCall(params) : openaiCall(params, p);
}

// Models the provider offers, best zero-cost candidates first (free, sees images, calls tools).
async function listModels(provider) {
  const cfg = store.getSettings().providers[provider];
  if (!cfg) return [];
  const key = store.getSecret(provider);
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  if (!res.ok) throw new Error(`${NAMES[provider]} model list failed (${res.status}).`);
  const models = ((await res.json()).data || []).map((m) => ({
    id: m.id, name: m.name || m.id,
    free: m.pricing ? Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0 : provider === 'omniroute',
    vision: (m.architecture?.input_modalities || []).includes('image'),
    tools: (m.supported_parameters || []).includes('tools'),
  }));
  const score = (m) => (m.free ? 4 : 0) + (m.vision ? 2 : 0) + (m.tools ? 1 : 0);
  return models.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
}

module.exports = { call, ready, describe, listModels, toOpenAI, fromOpenAI };
