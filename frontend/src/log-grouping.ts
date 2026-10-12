export type LogGrouping = 'turn' | 'exchange';

export interface LogEntryGroup {
  key: string;
  correlationId: string;
  sessionId: string;
  label: string;
  prompt: string;
  entries: any[];
  exchangeIds: string[];
  latestTimestamp: string;
}

export interface LogSession<T extends LogEntryGroup = LogEntryGroup> {
  key: string;
  label: string;
  sessionId: string;
  correlationIds: string[];
  groups: T[];
  requestCount: number;
  responseCount: number;
  latestTimestamp: string;
}

const array = (value: any): any[] => Array.isArray(value) ? value : [];
const timestamp = (value: any): number => Date.parse(value ?? '') || 0;

function header(entry: any, name: string): string {
  const pair = Object.entries(entry?.payload?.headers ?? {}).find(([key]) => key.toLowerCase() === name);
  const value = pair?.[1];
  return String(Array.isArray(value) ? value[0] ?? '' : value ?? '');
}

function messages(body: any): any[] {
  if (Array.isArray(body?.messages)) return body.messages;
  return typeof body?.input === 'string' ? [{ role: 'user', content: body.input }] : array(body?.input);
}

export function requestMessageCount(body: any): number {
  return messages(body).filter(item => typeof item?.role === 'string').length + (body?.instructions ? 1 : 0);
}

function contentText(content: any): string {
  if (typeof content === 'string') return content;
  return array(content).map(part => typeof part === 'string' ? part : part?.text ?? (part?.type === 'input_image' ? '[image]' : '')).join('\n');
}

function copilotSessionId(body: any): string {
  // Only inspect the runtime's system/developer context, never the user's text.
  const systemText = [body?.instructions, ...messages(body)
    .filter(item => item?.role === 'system' || item?.role === 'developer')
    .map(item => contentText(item.content))].filter(value => typeof value === 'string').join('\n');
  for (const section of systemText.matchAll(/<session_context>([\s\S]*?)<\/session_context>/gi)) {
    const match = section[1].match(/Session folder:\s*[^\r\n<>]*[\\/]\.copilot[\\/]session-state[\\/]([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})(?=[\\/\s]|$)/i);
    if (match) return match[1].toLowerCase();
  }
  return '';
}

function responseId(entry: any): string {
  const body = entry?.payload?.body;
  if (typeof body !== 'string') return body?.id ?? '';
  try { return JSON.parse(body)?.id ?? ''; } catch { /* SSE below. */ }
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      const event = JSON.parse(line.slice(5).trim());
      if (event?.response?.id) return event.response.id;
    } catch { /* Non-JSON events have no response ID. */ }
  }
  return '';
}

export function groupLogEntries(entries: any[], grouping: LogGrouping = 'turn'): LogEntryGroup[] {
  const exchanges = new Map<string, any[]>();
  for (const entry of entries) {
    if (!entry?.id) continue;
    const id = String(entry.id);
    exchanges.set(id, [...(exchanges.get(id) ?? []), entry]);
  }
  const ordered = [...exchanges.entries()].map(([id, values]) => {
    const request = values.find(entry => entry.kind === 'proxy-request');
    const rest = values.filter(entry => entry !== request).sort((a, b) => timestamp(a.timestamp) - timestamp(b.timestamp));
    return { id, request, values: request ? [request, ...rest] : rest };
  }).sort((a, b) => timestamp(a.values[0]?.timestamp) - timestamp(b.values[0]?.timestamp) || a.id.localeCompare(b.id));

  const groups = new Map<string, LogEntryGroup>();
  const responseGroups = new Map<string, string>();
  const activeTurns = new Map<string, string>();
  for (const exchange of ordered) {
    const body = exchange.request?.payload?.body ?? {};
    const correlationId = header(exchange.request, 'x-interaction-id');
    const explicitSessionId = copilotSessionId(body);
    const users = messages(body).filter(item => item?.role === 'user');
    const lastUser = users.at(-1);
    const inheritedKey = responseGroups.get(JSON.stringify([correlationId, body.previous_response_id]));
    const auxiliary = header(exchange.request, 'x-initiator') === 'agent'
      && !array(body.tools).length
      && contentText(lastUser?.content).startsWith('Runtime-derived request context:');
    let parentKey = auxiliary
      ? activeTurns.get(explicitSessionId ? `session:${explicitSessionId}` : `correlation:${correlationId}`)
      : !lastUser ? inheritedKey : undefined;
    if (explicitSessionId && parentKey && groups.get(parentKey)?.sessionId !== explicitSessionId) parentKey = undefined;
    const sessionId = explicitSessionId || (parentKey ? groups.get(parentKey)?.sessionId : '') || '';
    const scope = sessionId ? `session:${sessionId}` : correlationId ? `correlation:${correlationId}` : `exchange:${exchange.id}`;
    const key = grouping === 'turn' && (sessionId || correlationId)
      ? parentKey ?? (lastUser && !auxiliary
        ? JSON.stringify([scope, users.length, lastUser.content])
        : `exchange:${exchange.id}`)
      : `exchange:${exchange.id}`;
    if (grouping === 'turn' && lastUser && !auxiliary) {
      if (correlationId) activeTurns.set(`correlation:${correlationId}`, key);
      if (sessionId) activeTurns.set(`session:${sessionId}`, key);
    }
    const prompt = contentText(lastUser?.content).replace(/<current_datetime>.*?<\/current_datetime>/gs, '')
      .replace(/\s+/g, ' ').trim().slice(0, 160);
    const group = groups.get(key) ?? {
      key, correlationId, sessionId,
      label: `${grouping === 'turn' && (sessionId || correlationId) && ((lastUser && !auxiliary) || parentKey) ? 'Interaction' : 'Exchange'} ${exchange.id.slice(0, 8)}`,
      prompt, entries: [], exchangeIds: [], latestTimestamp: ''
    };
    group.entries.push(...exchange.values);
    group.exchangeIds.push(exchange.id);
    for (const entry of exchange.values) {
      if (timestamp(entry.timestamp) >= timestamp(group.latestTimestamp)) group.latestTimestamp = entry.timestamp;
      if (entry.kind === 'proxy-response') {
        const id = responseId(entry);
        if (id) responseGroups.set(JSON.stringify([correlationId, id]), key);
      }
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => timestamp(b.latestTimestamp) - timestamp(a.latestTimestamp));
}

export function groupLogSessions<T extends LogEntryGroup>(groups: T[]): LogSession<T>[] {
  const sessions = new Map<string, LogSession<T>>();
  for (const group of groups) {
    const key = group.sessionId ? `session:${group.sessionId}` : group.correlationId ? `correlation:${group.correlationId}` : 'unattributed';
    const session = sessions.get(key) ?? {
      key, sessionId: group.sessionId, correlationIds: [],
      label: group.sessionId ? `Session ${group.sessionId.slice(0, 8)}`
        : group.correlationId ? `Session unknown · correlation ${group.correlationId.slice(0, 8)}` : 'Without session ID',
      groups: [], requestCount: 0, responseCount: 0, latestTimestamp: ''
    };
    session.groups.push(group);
    for (const entry of group.entries) {
      const id = header(entry, 'x-interaction-id');
      if (id && !session.correlationIds.includes(id)) session.correlationIds.push(id);
    }
    session.requestCount += group.entries.filter(entry => entry.kind === 'proxy-request').length;
    session.responseCount += group.entries.filter(entry => entry.kind === 'proxy-response').length;
    if (timestamp(group.latestTimestamp) >= timestamp(session.latestTimestamp)) session.latestTimestamp = group.latestTimestamp;
    sessions.set(key, session);
  }
  return [...sessions.values()].sort((a, b) => timestamp(b.latestTimestamp) - timestamp(a.latestTimestamp));
}
