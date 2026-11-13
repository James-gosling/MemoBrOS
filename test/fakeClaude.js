// A scripted stand-in for the Anthropic Messages API, so the real request/response loop can be tested offline.
// Each script entry is a function (requestBody) → array of content blocks, consumed in order per test.
const http = require('http');

function start() {
  const state = { script: [], requests: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      state.requests.push({ url: req.url, headers: req.headers, body });
      const next = state.script.shift();
      const content = next ? next(body) : [{ type: 'text', text: 'Script exhausted.' }];
      const usesTool = content.some((b) => b.type === 'tool_use');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `msg_${state.requests.length}`, type: 'message', role: 'assistant', model: body.model, content,
        stop_reason: usesTool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

let n = 0;
const text = (t) => ({ type: 'text', text: t });
const use = (name, input) => ({ type: 'tool_use', id: `toolu_${++n}`, name, input });

module.exports = { start, text, use };
