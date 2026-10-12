const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');
const { outputText } = ts.transpileModule(readFileSync(join(__dirname, '../src/request-lab.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
});
const lab = import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('missing model or empty prompt cannot reach the upstream', async () => {
  const { buildLabRequest } = await lab;
  for (const api of ['responses', 'chat-completions']) {
    assert.throws(() => buildLabRequest(api, ' ', 'Hello'), /Select a model/);
    assert.throws(() => buildLabRequest(api, 'gpt-5.6-terra', ' '), /Enter a prompt/);
  }
});

test('both protocols send an explicit model and preserve the prompt', async () => {
  const { buildLabRequest } = await lab;
  const prompt = 'Hello\n  world';
  const response = buildLabRequest('responses', ' gpt-5.6-terra ', prompt);
  assert.equal(response.path, '/v1/responses');
  assert.equal(response.body.model, 'gpt-5.6-terra');
  assert.equal(response.body.input, prompt);
  assert.equal(response.body.store, false);
  assert.equal(response.body.stream, false);
  assert.equal(response.body.messages, undefined);
  const chat = buildLabRequest('chat-completions', 'gpt-5.6-terra', prompt);
  assert.equal(chat.path, '/v1/chat/completions');
  assert.equal(chat.body.model, 'gpt-5.6-terra');
  assert.deepEqual(chat.body.messages, [{ role: 'user', content: prompt }]);
  assert.equal(chat.body.input, undefined);
});

test('OpenAI error is shown instead of the generic HTTP message', async () => {
  const { requestErrorMessage } = await lab;
  const body = { error: { message: 'you must provide a model parameter' } };
  for (const error of [body, JSON.stringify(body)]) {
    assert.equal(requestErrorMessage({ status: 400, error, message: 'Http failure response: 400 OK' }),
      'HTTP 400: you must provide a model parameter');
  }
  assert.equal(requestErrorMessage({ status: 502, error: 'Upstream unavailable' }), 'HTTP 502: Upstream unavailable');
  assert.equal(requestErrorMessage({ error: { message: 'Transport failed' } }), 'Transport failed');
});
