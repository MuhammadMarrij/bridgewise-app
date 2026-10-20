// P0 model-access check: one minimal, non-sensitive structured-output call.
// Proves the application has a usable runtime API credential. A coding-tool
// subscription is NOT such a credential.
// Prints status only, never the key.
const key = process.env.MODEL_API_KEY;
const model = process.env.MODEL_NAME;
const provider = process.env.MODEL_PROVIDER ?? 'anthropic';

if (!key || !model) {
  console.log('BLOCKED: MODEL_API_KEY and/or MODEL_NAME not configured.');
  console.log('Live-agent evidence (P4) stays blocked until a human supplies them.');
  process.exit(2); // 2 = explicit external blocker, distinct from 1 = failure
}

if (provider !== 'anthropic') {
  console.log(`BLOCKED: no adapter implemented for provider "${provider}" yet.`);
  process.exit(2);
}

const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model,
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply with only this JSON: {"ok":true}' }],
  }),
});

if (!res.ok) {
  console.log(`FAIL: HTTP ${res.status} ${res.statusText}`);
  process.exit(1);
}
const body = await res.json();
const text = body?.content?.[0]?.text ?? '';
console.log(`PASS: model=${body.model ?? model} reply=${text.trim().slice(0, 40)}`);
console.log(`usage: in=${body.usage?.input_tokens ?? '?'} out=${body.usage?.output_tokens ?? '?'}`);
