// A scripted stand-in for the model APIs, so the real request/response loops can be tested offline.
// It answers both wire formats: Anthropic Messages (/v1/messages) and OpenAI chat completions
// (/chat/completions, as used for OpenRouter and OmniRoute). Each script entry is a function
// (requestBody) → array of Anthropic-style content blocks, consumed in order.
const http = require('http');

function start() {
  const state = { script: [], requests: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const json = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url.endsWith('/models')) {
        return json({ data: [
          { id: 'paid/model', name: 'Paid', pricing: { prompt: '0.000002', completion: '0.00001' }, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools'] },
          { id: 'free/text-only:free', name: 'Free text', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'] }, supported_parameters: [] },
          { id: 'free/vision-tools:free', name: 'Free vision', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools'] },
        ] });
      }
      const body = JSON.parse(raw || '{}');
      state.requests.push({ url: req.url, headers: req.headers, body });
      const next = state.script.shift();
      const content = next ? next(body) : [{ type: 'text', text: 'Script exhausted.' }];
      const uses = content.filter((b) => b.type === 'tool_use');
      if (req.url.includes('/chat/completions')) {
        const message = { role: 'assistant', content: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') || null };
        if (uses.length) message.tool_calls = uses.map((u) => ({ id: u.id, type: 'function', function: { name: u.name, arguments: JSON.stringify(u.input) } }));
        return json({ id: `gen_${state.requests.length}`, model: body.model, choices: [{ index: 0, message, finish_reason: uses.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
      }
      return json({
        id: `msg_${state.requests.length}`, type: 'message', role: 'assistant', model: body.model, content,
        stop_reason: uses.length ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
      });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

let n = 0;
const text = (t) => ({ type: 'text', text: t });
const use = (name, input) => ({ type: 'tool_use', id: `toolu_${++n}`, name, input });

module.exports = { start, text, use };
