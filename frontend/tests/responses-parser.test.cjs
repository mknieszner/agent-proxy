const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

const source = readFileSync(join(__dirname, '../src/responses-parser.ts'), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
});
const parser = import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const sse = events => events.map(event => `event: ${event.type}\r\ndata:${JSON.stringify(event)}\r\n\r\n`).join('');

test('JSON Responses shows text, tool call IDs, lifecycle and usage', async () => {
  const { parseResponsesBody } = await parser;
  const result = parseResponsesBody({
    object: 'response', id: 'resp-1', model: 'gpt-5.6-terra', status: 'completed',
    output: [
      { type: 'reasoning', encrypted_content: 'opaque', summary: [] },
      { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' },
      { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }
    ],
    usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 }
  });
  assert.equal(result.assistantText, 'Hello');
  assert.equal(result.toolCalls[0].id, 'call-1');
  assert.equal(result.toolCalls[0].argumentsText, '{"path":"README.md"}');
  assert.equal(result.usage.input_tokens, 20);
  assert.deepEqual(result.finishReasons, ['completed']);
  assert.equal(result.responseId, 'resp-1');
});

test('SSE deltas and final snapshots do not duplicate text or arguments', async () => {
  const { parseResponsesBody } = await parser;
  const item = { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read_file', arguments: '{}' };
  const result = parseResponsesBody(sse([
    { type: 'response.created', response: { id: 'resp-1', model: 'gpt-5.6-terra', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 1, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '}' },
    { type: 'response.output_item.done', output_index: 1, item },
    { type: 'response.output_text.delta', output_index: 2, content_index: 0, delta: 'Hel' },
    { type: 'response.output_text.delta', output_index: 2, content_index: 0, delta: 'lo' },
    { type: 'response.output_text.done', output_index: 2, content_index: 0, text: 'Hello' },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 20, output_tokens: 8 }, output: [
      { type: 'reasoning', summary: [] }, item, { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }
    ] } }
  ]));
  assert.equal(result.assistantText, 'Hello');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].argumentsText, '{}');
  assert.equal(result.toolCalls[0].id, 'call-1');
  assert.equal(result.toolArgumentChunkCount, 2);
  assert.equal(result.usage.output_tokens, 8);
});

test('partial stream previews retain tool calls and text before final event', async () => {
  const { parseResponsesBody } = await parser;
  const result = parseResponsesBody(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-2', name: 'read_file', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{' },
    { type: 'response.output_text.delta', output_index: 1, delta: 'Partial' }
  ]));
  assert.equal(result.assistantText, 'Partial');
  assert.equal(result.toolCalls[0].argumentsText, '{');
  assert.deepEqual(result.finishReasons, []);
});

test('failed and incomplete Responses statuses remain visible', async () => {
  const { parseResponsesBody } = await parser;
  for (const status of ['failed', 'incomplete']) {
    const result = parseResponsesBody(JSON.stringify({ object: 'response', status, output: [] }));
    assert.deepEqual(result.finishReasons, [status]);
    assert.equal(result.assistantText, '');
  }
});

test('unknown and malformed payloads remain available as raw logs without a Responses preview', async () => {
  const { parseResponsesBody } = await parser;
  assert.equal(parseResponsesBody({ error: { message: 'Invalid parameter' } }), null);
  assert.equal(parseResponsesBody('data: invalid-json\n\n'), null);
});
