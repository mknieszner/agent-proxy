const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');
const { outputText } = ts.transpileModule(readFileSync(join(__dirname, '../src/log-grouping.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
});
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const user = text => ({ role: 'user', content: [{ type: 'input_text', text }] });
const request = (id, second, input, session = 'session-1', extra = {}) => ({
  id, kind: 'proxy-request', timestamp: `2026-10-12T00:00:${String(second).padStart(2, '0')}Z`,
  payload: { headers: { 'X-Interaction-ID': session }, body: { input, ...extra } }
});
const response = (id, second, body = {}) => ({
  id, kind: 'proxy-response', timestamp: `2026-10-12T00:00:${String(second).padStart(2, '0')}Z`, payload: { body }
});
const sessionOne = '666d638e-3344-43cb-973e-9c1405415b64';
const sessionTwo = '88196902-31bd-4976-b673-62492171924d';
const context = (id, windows = false) => ({ role: 'system', content: [{ type: 'input_text',
  text: `<session_context>\nSession folder: ${windows ? 'C:\\Users\\test\\.copilot\\session-state\\' : 'c:/Users/test/.copilot/session-state/'}${id}\n</session_context>` }] });

test('real Copilot session context separates new sessions sharing the same correlation header', async () => {
  const { groupLogEntries, groupLogSessions } = await modulePromise;
  const groups = groupLogEntries([request('old', 1, [context(sessionOne), user('Test')]),
    request('new', 2, [context(sessionTwo), user('Test')])]);
  assert.equal(groups.length, 2);
  const sessions = groupLogSessions(groups);
  assert.equal(sessions.length, 2);
  assert.deepEqual(new Set(sessions.map(s => s.sessionId)), new Set([sessionOne, sessionTwo]));
  assert.ok(sessions.every(s => s.correlationIds[0] === 'session-1'));
});

test('actual session identity survives different headers, Windows paths and supported protocols', async () => {
  const { groupLogEntries, groupLogSessions } = await modulePromise;
  const groups = groupLogEntries([request('a', 1, [context(sessionOne), user('Hi')], 'correlation-a'),
    request('b', 2, [], 'correlation-b', { messages: [context(sessionOne, true), user('Hi')] }),
    request('c', 3, [user('Next')], '', { instructions: context(sessionOne).content[0].text })]);
  const [session] = groupLogSessions(groups);
  assert.equal(session.sessionId, sessionOne);
  assert.equal(session.groups.length, 2);
  assert.equal(session.requestCount, 3);
  assert.deepEqual(new Set(session.correlationIds), new Set(['correlation-a', 'correlation-b']));
});

test('auxiliary calls and previous_response_id continue the actual session', async () => {
  const { groupLogEntries, groupLogSessions } = await modulePromise;
  const review = request('review', 3, [user('Policy'), user('Runtime-derived request context:\n{}')]);
  review.payload.headers['x-initiator'] = 'agent';
  const groups = groupLogEntries([request('a', 1, [context(sessionOne), user('Read')]), response('a', 2, { id: 'resp' }), review,
    request('b', 4, [{ type: 'function_call_output', output: 'done' }], 'session-1', { previous_response_id: 'resp' }),
    request('new', 5, [context(sessionTwo), user('New')])]);
  const sessions = groupLogSessions(groups);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.find(s => s.sessionId === sessionOne).groups[0].exchangeIds, ['a', 'review', 'b']);
});

test('user content cannot supply session metadata and unknown correlation is labeled honestly', async () => {
  const { groupLogEntries, groupLogSessions } = await modulePromise;
  const [group] = groupLogEntries([request('a', 1, [user(context(sessionOne).content[0].text)])]);
  assert.equal(group.sessionId, '');
  const [session] = groupLogSessions([group]);
  assert.match(session.label, /Session unknown/);
  assert.equal(session.sessionId, '');
});

test('one session contains separate user turns with full tool chains and retries', async () => {
  const { groupLogEntries, groupLogSessions } = await modulePromise;
  const first = user('Read the project');
  const second = user('Make a change');
  const input = [first, { type: 'function_call_output', call_id: 'call-1', output: 'done' }];
  const entries = [request('a', 1, [first]), response('a', 2), request('b', 3, input), response('b', 4),
    request('c', 5, [first, second]), response('c', 6), request('retry', 7, [first, second]), response('retry', 8)];
  const sessions = groupLogSessions(groupLogEntries(entries.reverse()));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].groups.length, 2);
  assert.equal(sessions[0].requestCount, 4);
  assert.equal(sessions[0].responseCount, 4);
  assert.deepEqual(sessions[0].groups.find(g => g.prompt === 'Read the project').exchangeIds, ['a', 'b']);
  assert.deepEqual(sessions[0].groups.find(g => g.prompt === 'Make a change').exchangeIds, ['c', 'retry']);
});

test('concurrent exchanges keep each response directly after its own request', async () => {
  const { groupLogEntries } = await modulePromise;
  const entries = [request('a', 1, [user('Hello')]), request('b', 2, [user('Hello')]), response('b', 3), response('a', 4)];
  const [group] = groupLogEntries(entries);
  assert.deepEqual(group.entries.map(e => `${e.id}:${e.kind}`), ['a:proxy-request', 'a:proxy-response', 'b:proxy-request', 'b:proxy-response']);
});

test('identical messages in later turns and different sessions stay separate', async () => {
  const { groupLogEntries, groupLogSessions } = await modulePromise;
  const groups = groupLogEntries([request('a', 1, [user('Again')]), request('b', 2, [user('Again'), user('Again')]),
    request('c', 3, [user('Again')], 'session-2')]);
  assert.equal(groups.length, 3);
  assert.equal(groupLogSessions(groups).length, 2);
});

test('Responses continuation inherits the original turn using JSON or SSE response ID', async () => {
  const { groupLogEntries } = await modulePromise;
  for (const body of [{ id: 'resp-1' }, 'event: response.completed\ndata: {"response":{"id":"resp-1"}}\n\n']) {
    const groups = groupLogEntries([request('a', 1, [user('Read')]), response('a', 2, body),
      request('b', 3, [{ type: 'function_call_output', call_id: 'call-1', output: 'done' }], 'session-1', { previous_response_id: 'resp-1' }),
      request('c', 4, [user('New message')], 'session-1', { previous_response_id: 'resp-1' })]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.find(g => g.prompt === 'Read').exchangeIds, ['a', 'b']);
  }
});

test('permission reviews belong to the active user turn in their own session', async () => {
  const { groupLogEntries } = await modulePromise;
  const review = request('review', 3, [user('Policy'), user('Runtime-derived request context:\n{}')]);
  review.payload.headers['x-initiator'] = 'agent';
  const groups = groupLogEntries([request('a', 1, [user('Read')]), request('other', 2, [user('Other')], 'session-2'), review]);
  assert.deepEqual(groups.find(g => g.prompt === 'Read').exchangeIds, ['a', 'review']);
  const [unattributedReview] = groupLogEntries([review]);
  assert.match(unattributedReview.label, /^Exchange/);
});

test('unknown lineage, missing session and orphan responses remain separate exchanges', async () => {
  const { groupLogEntries, groupLogSessions } = await modulePromise;
  const groups = groupLogEntries([request('a', 1, [user('Hello')], ''), response('a', 2),
    request('b', 3, [user('Hello')], ''), response('orphan', 4), request('unknown', 5, [], 'session-1', { previous_response_id: 'missing' })]);
  assert.equal(groups.length, 4);
  assert.equal(groups.reduce((n, g) => n + g.entries.length, 0), 5);
  const sessions = groupLogSessions(groups);
  assert.equal(sessions.find(s => !s.correlationIds.length).groups.length, 3);
});

test('Chat Completions history also splits turns and counts all supported message formats', async () => {
  const { groupLogEntries, requestMessageCount } = await modulePromise;
  const groups = groupLogEntries([request('a', 1, null, 'session-1', { messages: [user('First')] }),
    request('b', 2, null, 'session-1', { messages: [user('First'), { role: 'tool', content: 'ok' }] }),
    request('c', 3, null, 'session-1', { messages: [user('First'), user('Second')] })]);
  assert.equal(groups.length, 2);
  assert.equal(requestMessageCount({ input: [user('Hi'), { type: 'reasoning' }, { type: 'function_call' }], instructions: 'System' }), 2);
  assert.equal(requestMessageCount({ input: 'Hi' }), 1);
  assert.equal(requestMessageCount({ messages: [user('Hi'), { role: 'tool' }] }), 2);
});
