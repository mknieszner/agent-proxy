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
  assert.throws(() => buildLabRequest(' ', 'Hello'), /Select a model/);
  assert.throws(() => buildLabRequest('gpt-5.6-terra', ' '), /Enter a prompt/);
});

test('Responses sends an explicit model and preserve the prompt', async () => {
  const { buildLabRequest } = await lab;
  const prompt = 'Hello\n  world';
  const response = buildLabRequest(' gpt-5.6-terra ', prompt);
  assert.equal(response.path, '/v1/responses');
  assert.equal(response.body.model, 'gpt-5.6-terra');
  assert.equal(response.body.input, prompt);
  assert.equal(response.body.store, false);
  assert.equal(response.body.stream, false);

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
