export function buildLabRequest(model: string, prompt: string): { path: string; body: any } {
  const modelId = model.trim();
  if (!modelId) throw new Error('Select a model before sending a request.');
  if (!prompt.trim()) throw new Error('Enter a prompt before sending a request.');
  return { path: '/v1/responses', body: { model: modelId, input: prompt, stream: false, store: false } };
}

export function requestErrorMessage(error: any): string {
  let body = error?.error;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* Plain text errors are also useful. */ }
  }
  const detail = body?.error?.message || body?.message || (typeof body === 'string' ? body : '')
    || error?.message || 'Request failed';
  return `${error?.status ? `HTTP ${error.status}: ` : ''}${detail}`;
}
