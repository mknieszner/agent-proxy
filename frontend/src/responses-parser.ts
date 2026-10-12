export interface ResponsesToolCall {
  index: number;
  id: string;
  type: string;
  name: string;
  argumentsText: string;
}

// Parse log previews only; request and response bodies remain untouched in the proxy.
export function parseResponsesBody(body: any) {
  let value = body;
  let chunks: any[] = [];
  if (typeof body === 'string') {
    try {
      value = JSON.parse(body);
    } catch {
      value = null;
      for (const block of body.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        try {
          if (data) chunks.push(JSON.parse(data));
        } catch {
          // The raw log still contains malformed or unknown events.
        }
      }
    }
  }
  const isResponse = value?.object === 'response' || Array.isArray(value?.output);
  if (!isResponse && !chunks.some(chunk => String(chunk?.type ?? '').startsWith('response.'))) return null;
  if (isResponse) chunks = [value];

  const text = new Map<string, string>();
  const tools = new Map<number, ResponsesToolCall>();
  const finishReasons: string[] = [];
  let model = '';
  let responseId = '';
  let usage: any = null;
  let contentChunkCount = 0;
  let toolArgumentChunkCount = 0;
  let finishChunkCount = 0;
  let usageChunkCount = 0;

  const acceptItem = (item: any, index: number) => {
    if (item?.type === 'message') {
      (item.content ?? []).forEach((part: any, contentIndex: number) => {
        if (part.type === 'output_text' || part.type === 'refusal') {
          text.set(`${index}:${contentIndex}`, part.text ?? part.refusal ?? '');
        }
      });
    } else if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
      const current = tools.get(index);
      tools.set(index, {
        index,
        id: item.call_id ?? current?.id ?? item.id ?? '',
        type: item.type,
        name: item.name ?? current?.name ?? '',
        argumentsText: item.arguments ?? item.input ?? current?.argumentsText ?? ''
      });
    }
  };

  for (const chunk of chunks) {
    const response = isResponse ? chunk : chunk.response;
    if (response) {
      model = response.model ?? model;
      responseId = response.id ?? responseId;
      if (response.usage) {
        usage = response.usage;
        usageChunkCount++;
      }
      if (Array.isArray(response.output)) response.output.forEach(acceptItem);
      if (response.status && response.status !== 'in_progress') {
        finishReasons.push(response.status);
        finishChunkCount++;
      }
    }
    const index = Number(chunk.output_index ?? 0);
    if (chunk.type === 'response.output_text.delta') {
      const key = `${index}:${chunk.content_index ?? 0}`;
      text.set(key, (text.get(key) ?? '') + (chunk.delta ?? ''));
      contentChunkCount++;
    } else if (chunk.type === 'response.output_text.done') {
      text.set(`${index}:${chunk.content_index ?? 0}`, chunk.text ?? '');
    } else if (chunk.type === 'response.output_item.added' || chunk.type === 'response.output_item.done') {
      acceptItem(chunk.item, index);
    } else if (chunk.type === 'response.function_call_arguments.delta' || chunk.type === 'response.custom_tool_call_input.delta') {
      const current = tools.get(index) ?? { index, id: chunk.item_id ?? '', type: 'function_call', name: '', argumentsText: '' };
      current.argumentsText += chunk.delta ?? '';
      tools.set(index, current);
      toolArgumentChunkCount++;
    } else if (chunk.type === 'response.function_call_arguments.done' || chunk.type === 'response.custom_tool_call_input.done') {
      const current = tools.get(index);
      if (current) current.argumentsText = chunk.arguments ?? chunk.input ?? current.argumentsText;
    }
  }

  return {
    assistantText: [...text.entries()].sort(([a], [b]) => {
      const [aOutput, aContent] = a.split(':').map(Number);
      const [bOutput, bContent] = b.split(':').map(Number);
      return aOutput - bOutput || aContent - bContent;
    }).map(([, value]) => value).join(''),
    chunks, finishReasons, model, responseId, toolCalls: [...tools.values()], usage,
    contentChunkCount, toolArgumentChunkCount, finishChunkCount, usageChunkCount
  };
}
