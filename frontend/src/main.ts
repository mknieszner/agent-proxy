import { bootstrapApplication, DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Component, ElementRef, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Dialog, DialogModule, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { Overlay } from '@angular/cdk/overlay';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { parseResponsesBody } from './responses-parser';
import { groupLogEntries, groupLogSessions, requestMessageCount, LogEntryGroup, LogSession } from './log-grouping';
import { buildLabRequest, requestErrorMessage } from './request-lab';

type Tab = 'status' | 'request' | 'logs';

interface LogGroup extends LogEntryGroup {
  requestCount: number;
  responseCount: number;
  toolsCount: number;
  toolCallIds: string[];
  toolCallNames: string[];
  tokenUsage: TokenUsageSummary;
}

interface TokenUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  maxPromptTokens: number;
  estimatedMaxPromptTokens: number;
  contextLimit: number;
  hasReportedUsage: boolean;
  hasReportedPromptTokens: boolean;
}

interface ModelProviderModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface ModelProviderModelsResponse {
  object: string;
  data: ModelProviderModel[];
}

interface ProxyStatus {
  baseUrl: string;
  apiKeyConfigured: boolean;
  logDirectory: string;
}

interface MessageDetail {
  index: number;
  label: string;
  role: string;
  content: string;
  extra: any | null;
}

interface HighlightedTextSegment {
  text: string;
  xmlTag: boolean;
}

interface ParamDetail {
  label: string;
  value: string;
}

interface ToolDetail {
  index: number;
  name: string;
  description: string;
  descriptionHtml: SafeHtml;
  json: string;
}

interface ResponseToolCallDetail {
  index: number;
  id: string;
  type: string;
  name: string;
  argumentsText: string;
  argumentsJson: any | null;
  argumentsFields: ParamDetail[];
}

interface ResponseDetail {
  overview: ParamDetail[];
  assistantText: string;
  toolCalls: ResponseToolCallDetail[];
  usage: ParamDetail[];
  streaming: ParamDetail[];
  parsedChunksJson: string;
  rawBody: string;
}

interface ParsedResponse {
  assistantText: string;
  chunks: any[];
  finishReasons: string[];
  model: string;
  responseId: string;
  toolCalls: ResponseToolCallDetail[];
  usage: any | null;
  contentChunkCount: number;
  toolArgumentChunkCount: number;
  finishChunkCount: number;
  usageChunkCount: number;
}

interface EntryDetailsHost {
  flowLabel(entry: any): string;
  entryTitle(entry: any): string;
  entryParams(entry: any): ParamDetail[];
  entryMessages(entry: any): MessageDetail[];
  entryTools(entry: any): ToolDetail[];
  toggleJsonPanel(panel: string): void;
  isJsonPanelOpen(panel: string): boolean;
  highlightXml(value: string): HighlightedTextSegment[];
}

interface EntryDetailsDialogData {
  entry: any;
  response: ResponseDetail | null;
  host: EntryDetailsHost;
}

@Component({
  selector: 'app-entry-details-dialog',
  standalone: true,
  imports: [CommonModule],
  template: `
    <section class="entry-modal" role="dialog" aria-modal="true" aria-labelledby="entry-details-title">
      <header class="entry-modal-header">
        <div>
          <h2 id="entry-details-title">{{ flowLabel(entry) }}</h2>
          <p>{{ entryTitle(entry) }}</p>
        </div>
        <button type="button" class="compact" (click)="close()">Close</button>
      </header>

      <div class="entry-modal-content">
        <aside class="entry-modal-meta">
          <div class="modal-context">
            <div>
              <span class="label">Exchange id</span>
              <code>{{ entry.id }}</code>
            </div>
            <div>
              <span class="label">Kind</span>
              <strong>{{ entry.kind }}</strong>
            </div>
            <div *ngIf="entry.payload?.method">
              <span class="label">Request</span>
              <strong>{{ entry.payload.method }} {{ entry.payload.path }}</strong>
            </div>
            <div *ngIf="entry.payload?.status">
              <span class="label">Status</span>
              <strong>{{ entry.payload.status }}</strong>
            </div>
          </div>

          <nav class="modal-nav" aria-label="Entry details navigation">
            <ng-container *ngIf="entry.kind === 'proxy-response'; else requestNavigation">
              <button type="button" (click)="scrollModalSection('overview')">Overview</button>
              <button type="button" (click)="scrollModalSection('assistant-output')">Assistant Output</button>
              <button type="button" (click)="scrollModalSection('tool-calls')">Tool Calls</button>
              <button type="button" (click)="scrollModalSection('usage')">Usage</button>
              <button type="button" (click)="scrollModalSection('streaming')">Streaming Anatomy</button>
              <button type="button" (click)="scrollModalSection('raw-response')">Raw Response</button>
            </ng-container>
            <ng-template #requestNavigation>
              <div class="modal-nav-group">
                <div class="modal-nav-heading">Request</div>
                <button class="modal-nav-row" type="button" (click)="scrollModalSection('params')">
                  <span>Parameters</span>
                  <span class="modal-nav-count">{{ params.length }}</span>
                </button>
              </div>

              <div class="modal-nav-group" *ngIf="messages.length">
                <div class="modal-nav-heading">
                  <span>Messages</span>
                  <span>{{ messages.length }}</span>
                </div>
                <button class="modal-nav-message" type="button" *ngFor="let message of messages" (click)="scrollModalSection('message-' + message.index)">
                  <span>{{ message.label }}</span>
                  <span class="modal-nav-role">{{ message.role }}</span>
                </button>
              </div>

              <div class="modal-nav-group">
                <div class="modal-nav-heading">Capabilities</div>
                <button class="modal-nav-row" type="button" (click)="scrollModalSection('tools')">
                  <span>Tools</span>
                  <span class="modal-nav-count">{{ tools.length }}</span>
                </button>
              </div>

              <div class="modal-nav-group">
                <div class="modal-nav-heading">Payload</div>
                <button type="button" (click)="scrollModalSection('raw-json')">Client request</button>
              </div>
            </ng-template>
          </nav>
        </aside>

        <section class="entry-modal-main" *ngIf="entry.kind === 'proxy-response' && selectedResponse; else requestDetails">
          <details id="modal-section-overview" class="detail-section" open>
            <summary>Overview</summary>
            <div class="param-grid">
              <div *ngFor="let param of selectedResponse.overview">
                <span class="label">{{ param.label }}</span>
                <code>{{ param.value }}</code>
              </div>
            </div>
          </details>

          <details id="modal-section-assistant-output" class="detail-section" open>
            <summary>Assistant Output</summary>
            <div class="empty-state" *ngIf="!selectedResponse.assistantText">No assistant text in this response.</div>
            <pre class="assistant-output" *ngIf="selectedResponse.assistantText">{{ selectedResponse.assistantText }}</pre>
          </details>

          <details id="modal-section-tool-calls" class="detail-section" open>
            <summary>Tool Calls ({{ selectedResponse.toolCalls.length }})</summary>
            <div class="empty-state" *ngIf="!selectedResponse.toolCalls.length">No tool calls returned by the model.</div>

            <article class="tool-call-card" *ngFor="let toolCall of selectedResponse.toolCalls">
              <header>
                <strong>{{ toolCall.name || 'unnamed tool' }}</strong>
                <code>{{ toolCall.id || ('tool-call-' + (toolCall.index + 1)) }}</code>
              </header>
              <div class="param-grid compact-grid" *ngIf="toolCall.argumentsFields.length">
                <div *ngFor="let field of toolCall.argumentsFields">
                  <span class="label">{{ field.label }}</span>
                  <code>{{ field.value }}</code>
                </div>
              </div>
              <section class="json-panel">
                <button type="button" (click)="toggleJsonPanel('response-tool-' + toolCall.index)">
                  Arguments JSON
                  <span>{{ isJsonPanelOpen('response-tool-' + toolCall.index) ? 'Hide' : 'Show' }}</span>
                </button>
                <pre *ngIf="isJsonPanelOpen('response-tool-' + toolCall.index)">{{ toolCall.argumentsJson ? (toolCall.argumentsJson | json) : toolCall.argumentsText }}</pre>
              </section>
            </article>
          </details>

          <details id="modal-section-usage" class="detail-section" open>
            <summary>Usage</summary>
            <div class="empty-state" *ngIf="!selectedResponse.usage.length">Provider did not report token usage for this response.</div>
            <div class="param-grid" *ngIf="selectedResponse.usage.length">
              <div *ngFor="let param of selectedResponse.usage">
                <span class="label">{{ param.label }}</span>
                <code>{{ param.value }}</code>
              </div>
            </div>
          </details>

          <details id="modal-section-streaming" class="detail-section">
            <summary>Streaming Anatomy</summary>
            <div class="param-grid">
              <div *ngFor="let param of selectedResponse.streaming">
                <span class="label">{{ param.label }}</span>
                <code>{{ param.value }}</code>
              </div>
            </div>
            <details class="nested-detail">
              <summary>Parsed SSE chunks</summary>
              <pre>{{ selectedResponse.parsedChunksJson }}</pre>
            </details>
          </details>

          <details id="modal-section-raw-response" class="detail-section">
            <summary>Response returned to agent</summary>
            <pre>{{ selectedResponse.rawBody }}</pre>
          </details>

        </section>

        <ng-template #requestDetails>
          <section class="entry-modal-main">
            <details id="modal-section-params" class="detail-section" open>
              <summary>Params</summary>
              <div class="empty-state" *ngIf="!params.length">No request or response parameters found.</div>
              <div class="param-grid" *ngIf="params.length">
                <div *ngFor="let param of params">
                  <span class="label">{{ param.label }}</span>
                  <code>{{ param.value }}</code>
                </div>
              </div>
            </details>

            <div class="empty-state standalone" *ngIf="!messages.length">No model messages found in this exchange.</div>

            <article class="message-card detail-section" *ngFor="let message of messages" [attr.id]="'modal-section-message-' + message.index">
              <details open>
                <summary>
                  <strong>{{ message.label }} · {{ message.role }}</strong>
                  <span class="muted">{{ message.content.length }} chars</span>
                </summary>
                <pre class="message-content"><ng-container *ngFor="let segment of highlightXml(message.content)"><span [class.xml-tag]="segment.xmlTag">{{ segment.text }}</span></ng-container></pre>
                <details class="nested-detail" *ngIf="message.extra" open>
                  <summary>Message metadata</summary>
                  <pre>{{ message.extra | json }}</pre>
                </details>
              </details>
            </article>

            <details id="modal-section-tools" class="detail-section" open>
              <summary>Tools ({{ tools.length }})</summary>
              <div class="empty-state" *ngIf="!tools.length">No tool definitions found in this exchange.</div>

              <article class="tool-card" *ngFor="let tool of tools">
                <header>
                  <strong>{{ tool.name }}</strong>
                  <span class="muted">tool {{ tool.index + 1 }}</span>
                </header>
                <div class="markdown-content" *ngIf="tool.description" [innerHTML]="tool.descriptionHtml"></div>
                <section class="json-panel">
                  <button type="button" (click)="toggleJsonPanel('request-tool-' + tool.index)">
                    Tool JSON
                    <span>{{ isJsonPanelOpen('request-tool-' + tool.index) ? 'Hide' : 'Show' }}</span>
                  </button>
                  <pre *ngIf="isJsonPanelOpen('request-tool-' + tool.index)">{{ tool.json }}</pre>
                </section>
              </article>
            </details>

            <details id="modal-section-raw-json" class="detail-section">
              <summary>Client request JSON</summary>
              <pre>{{ entry | json }}</pre>
            </details>

          </section>
        </ng-template>
      </div>
    </section>
  `
})
class EntryDetailsDialogComponent {
  private readonly dialogRef = inject(DialogRef);
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly data = inject<EntryDetailsDialogData>(DIALOG_DATA);

  private readonly host = this.data.host;
  readonly entry = this.data.entry;
  readonly selectedResponse = this.data.response;
  readonly params = this.host.entryParams(this.entry);
  readonly messages = this.host.entryMessages(this.entry);
  readonly tools = this.host.entryTools(this.entry);

  close(): void {
    this.dialogRef.close();
  }

  scrollModalSection(section: string): void {
    this.elementRef.nativeElement.querySelector<HTMLElement>(`#modal-section-${section}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  }

  flowLabel(entry: any): string {
    return this.host.flowLabel(entry);
  }

  entryTitle(entry: any): string {
    return this.host.entryTitle(entry);
  }

  toggleJsonPanel(panel: string): void {
    this.host.toggleJsonPanel(panel);
  }

  isJsonPanelOpen(panel: string): boolean {
    return this.host.isJsonPanelOpen(panel);
  }

  highlightXml(value: string): HighlightedTextSegment[] {
    return this.host.highlightXml(value);
  }
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, DialogModule],
  template: `
    <main class="shell">
      <header class="topbar">
        <div>
          <h1>Agent Proxy</h1>
          <p>Proxy for logging GitHub Copilot requests, tool calls, and OpenAI-compatible model responses.</p>
        </div>
        <button type="button" (click)="refresh()">Refresh</button>
      </header>

      <nav class="tabs" aria-label="Views">
        <button type="button" [class.active]="tab === 'status'" (click)="tab = 'status'">Status</button>
        <button type="button" [class.active]="tab === 'request'" (click)="tab = 'request'">Request Lab</button>
        <button type="button" [class.active]="tab === 'logs'" (click)="tab = 'logs'">Logs</button>
      </nav>

      <section *ngIf="tab === 'status'" class="panel">
        <div class="status-grid">
          <div>
            <span class="label">Upstream API</span>
            <strong>{{ status?.baseUrl || 'loading' }}</strong>
          </div>
          <div>
            <span class="label">Models endpoint</span>
            <strong [class.ok]="modelsLoaded" [class.bad]="modelsError">{{ modelsLoaded ? 'up' : modelsError ? 'down' : 'loading' }}</strong>
          </div>
          <div>
            <span class="label">Copilot endpoint</span>
            <strong><code>/v1/responses</code></strong>
          </div>
          <div>
            <span class="label">Models</span>
            <strong>{{ models.length }}</strong>
          </div>
          <div>
            <span class="label">Upstream API key</span>
            <strong [class.ok]="status?.apiKeyConfigured" [class.bad]="!!status && !status.apiKeyConfigured">{{ authLabel(status?.apiKeyConfigured) }}</strong>
          </div>
          <div>
            <span class="label">Log directory</span>
            <strong>{{ status?.logDirectory || 'loading' }}</strong>
          </div>
        </div>

        <p class="error" *ngIf="statusError">{{ statusError }}</p>
        <p class="error" *ngIf="modelsError">{{ modelsError }}</p>

        <table *ngIf="models.length">
          <thead>
            <tr>
              <th>Model id</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let model of models">
              <td><code>{{ model.id }}</code></td>
              <td>{{ model.owned_by }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section *ngIf="tab === 'request'" class="panel form-panel">
        <label>
          Model
          <select [(ngModel)]="selectedModel" [disabled]="sending">
            <option [ngValue]="''" disabled>Select a model</option>
            <option *ngFor="let model of models" [ngValue]="model.id">{{ model.id }}</option>
          </select>
        </label>

        <label class="wide">
          Prompt
          <textarea [(ngModel)]="prompt" rows="8"></textarea>
        </label>

        <div class="toolbar">
          <button type="button" [disabled]="sending || !selectedModel.trim() || !prompt.trim()" (click)="send()">Send proxy request</button>
          <span *ngIf="sending">waiting for /v1/responses...</span>
          <span class="error" *ngIf="sendError">{{ sendError }}</span>
        </div>

        <article class="response" *ngIf="lastResponse">
          <header>
            <strong>{{ lastResponse.model }}</strong>
            <span>{{ lastResponse.finishReasons.join(', ') || 'status not reported' }}</span>
          </header>
          <pre>{{ lastResponse.assistantText || 'No text returned. See Logs for the full response.' }}</pre>
        </article>
      </section>

      <section *ngIf="tab === 'logs'" class="panel">
        <div class="toolbar">
          <button type="button" (click)="loadLogs()">{{ importedLogFileName ? 'Back to server logs' : 'Reload logs' }}</button>
          <input #logFileInput type="file" hidden accept=".jsonl,application/x-ndjson,application/json" (change)="loadLogsFromFile($event)">
          <button type="button" (click)="logFileInput.click()">Load JSONL file</button>
          <button type="button" class="danger" [disabled]="clearingLogs" (click)="clearLogs()">
            {{ importedLogFileName ? 'Clear view' : 'Clear log series' }}
          </button>
          <span>{{ logSessions.length }} session groups / {{ logGroups.length }} interactions from <code>{{ logsSourceLabel }}</code></span>
          <span *ngIf="clearingLogs">clearing...</span>
          <span class="error" *ngIf="logsError">{{ logsError }}</span>
        </div>

        <section *ngFor="let session of logSessions" class="session-card">
          <header class="session-card-header">
            <div>
              <h2>{{ session.label }}</h2>
              <p>{{ session.groups.length }} interactions · {{ session.requestCount }} requests / {{ session.responseCount }} responses</p>
            </div>
            <code [title]="session.sessionId ? 'Copilot session ID from runtime session_context' : 'Session ID unavailable. Correlation IDs: ' + session.correlationIds.join(', ')">{{ session.sessionId || 'session ID not provided' }}</code>
          </header>
        <article *ngFor="let group of session.groups" class="interaction-card" [class.is-collapsed]="!expandedInteractions.has(group.key)">
          <header class="interaction-card-header">
            <div>
              <h2>{{ group.label }}</h2>
              <p class="interaction-prompt" *ngIf="group.prompt">{{ group.prompt }}</p>
              <p>{{ group.requestCount }} requests / {{ group.responseCount }} responses</p>
            </div>
            <div class="interaction-actions">
              <button type="button" class="danger compact" [disabled]="clearingLogs" (click)="clearInteraction(group)">
                {{ importedLogFileName ? 'Hide' : 'Delete' }}
              </button>
              <button type="button" class="interaction-toggle" (click)="toggleInteraction(group)"
                [attr.aria-expanded]="expandedInteractions.has(group.key)"
                [attr.aria-controls]="'interaction-details-' + group.exchangeIds[0]"
                [attr.aria-label]="(expandedInteractions.has(group.key) ? 'Collapse ' : 'Expand ') + group.label"
                [title]="expandedInteractions.has(group.key) ? 'Collapse interaction' : 'Expand interaction'">
                <span class="interaction-chevron" [class.is-expanded]="expandedInteractions.has(group.key)" aria-hidden="true"></span>
              </button>
            </div>
          </header>

          <div [id]="'interaction-details-' + group.exchangeIds[0]" [hidden]="!expandedInteractions.has(group.key)">
          <ng-container *ngIf="expandedInteractions.has(group.key)">
          <div class="interaction-summary">
            <div class="metric" data-tooltip="Number of tool definitions sent to the model in the largest request of this interaction.">
              <span class="label">Tools exposed</span>
              <strong>{{ group.toolsCount }}</strong>
            </div>
            <div class="metric" data-tooltip="Tool names requested by the model across responses in this interaction.">
              <span class="label">Tool calls</span>
              <div class="tag-list" *ngIf="group.toolCallNames.length; else noToolCalls">
                <span class="tag" *ngFor="let name of group.toolCallNames">{{ name }}</span>
              </div>
              <ng-template #noToolCalls><span class="muted">none</span></ng-template>
            </div>
            <div class="metric" [attr.data-tooltip]="(group.sessionId ? 'Copilot session ID from runtime session_context.' : 'No Copilot session ID found.') + ' Request correlation ID: ' + (group.correlationId || 'not provided')">
              <span class="label">Session</span>
              <code>{{ group.sessionId ? shortId(group.sessionId) : 'unknown' }}</code>
            </div>
            <div class="metric" [attr.data-tooltip]="contextUsageTooltip(group.tokenUsage)">
              <span class="label">Context window</span>
              <ng-container *ngIf="contextPromptTokens(group.tokenUsage) > 0; else contextUsageUnavailable">
                <strong>{{ contextUsageIsEstimated(group.tokenUsage) ? '~' : '' }}{{ contextUsagePercent(group.tokenUsage) }}%</strong>
              </ng-container>
              <ng-template #contextUsageUnavailable><strong>not reported</strong></ng-template>
              <div class="usage-meter" aria-hidden="true">
                <span [style.width.%]="contextUsagePercent(group.tokenUsage)"></span>
              </div>
              <small class="usage-line">
                <ng-container *ngIf="contextPromptTokens(group.tokenUsage) > 0; else noContextUsage">
                  {{ contextUsageIsEstimated(group.tokenUsage) ? '~' : '' }}{{ formatNumber(contextPromptTokens(group.tokenUsage)) }} / {{ formatNumber(group.tokenUsage.contextLimit) }}{{ contextUsageIsEstimated(group.tokenUsage) ? ' estimated' : '' }}
                </ng-container>
                <ng-template #noContextUsage>usage unavailable</ng-template>
              </small>
            </div>
          </div>

          <ol class="timeline" aria-label="Interaction sequence">
            <li *ngFor="let entry of group.entries" class="timeline-row">
              <span class="direction">{{ flowLabel(entry) }}</span>
              <strong>{{ entryTitle(entry) }}</strong>
              <span class="meta-cell has-tooltip" [attr.data-tooltip]="entryMetaTooltip(entry)">{{ entryMeta(entry) }}</span>
              <span class="token-cell has-tooltip" [attr.data-tooltip]="entryTokenTooltip(entry)">{{ entryTokenMeta(entry) }}</span>
              <button type="button" class="icon-button" title="Open details" [attr.aria-label]="'Open details for ' + entryTitle(entry)" (click)="openEntryDetails(entry)">
                <span class="eye-glyph" aria-hidden="true"></span>
              </button>
            </li>
          </ol>
          </ng-container>
          </div>
        </article>
        </section>

      </section>

    </main>
  `
})
class AppComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly dialog = inject(Dialog);
  private readonly overlay = inject(Overlay);

  tab: Tab = 'logs';
  status: ProxyStatus | null = null;
  statusError = '';
  models: ModelProviderModel[] = [];
  modelsLoaded = false;
  modelsError = '';
  logs: any[] = [];
  logGroups: LogGroup[] = [];
  logSessions: LogSession<LogGroup>[] = [];
  expandedInteractions = new Set<string>();
  logsError = '';
  logsSourceLabel = '/v1/logs';
  importedLogFileName = '';
  clearingLogs = false;
  sending = false;
  sendError = '';
  selectedModel = '';
  prompt = 'Reply exactly: AGENT_PROXY_MODEL_PROVIDER_COMPAT_OK';
  lastResponse: ParsedResponse | null = null;
  selectedEntry: any | null = null;
  selectedResponse: ResponseDetail | null = null;
  openJsonPanels = new Set<string>();
  private highlightedTextSegments = new Map<string, HighlightedTextSegment[]>();

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loadStatus();
    this.loadModels();
    this.loadLogs();
  }

  loadStatus(): void {
    this.statusError = '';
    this.http.get<ProxyStatus>('/v1/status').subscribe({
      next: response => {
        this.status = response;
      },
      error: error => {
        this.status = null;
        this.statusError = error?.error?.message || error?.message || 'Failed to load /v1/status';
      }
    });
  }

  loadModels(): void {
    this.modelsError = '';
    this.http.get<ModelProviderModelsResponse>('/v1/models').subscribe({
      next: response => {
        this.models = response.data ?? [];
        this.modelsLoaded = true;
        this.selectRecentModel();
      },
      error: error => {
        this.modelsLoaded = false;
        this.modelsError = error?.error?.message || error?.message || 'Failed to load /v1/models';
      }
    });
  }

  loadLogs(): void {
    this.logsError = '';
    this.http.get<{ entries: any[] }>('/v1/logs?limit=100').subscribe({
      next: response => {
        this.logs = response.entries ?? [];
        this.importedLogFileName = '';
        this.logsSourceLabel = '/v1/logs';
        this.groupLogs();
        this.selectRecentModel();
      },
      error: error => {
        this.logsError = error?.error?.message || error?.message || 'Failed to load /v1/logs';
      }
    });
  }

  async loadLogsFromFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    this.logsError = '';
    try {
      const text = (await file.text()).replace(/^\uFEFF/, '');
      const entries = text
        .split(/\r?\n/)
        .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
        .filter(item => item.line.length > 0)
        .map(item => {
          try {
            const entry = JSON.parse(item.line);
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
              throw new Error('entry must be a JSON object');
            }
            return entry;
          } catch (error: any) {
            throw new Error(`Invalid JSONL at line ${item.lineNumber}: ${error?.message ?? 'parse error'}`);
          }
        });

      this.logs = entries;
      this.importedLogFileName = file.name;
      this.logsSourceLabel = `file: ${file.name}`;
      this.groupLogs();
    } catch (error: any) {
      this.logsError = error?.message || `Failed to load ${file.name}`;
    } finally {
      input.value = '';
    }
  }

  clearLogs(): void {
    if (this.importedLogFileName) {
      this.logs = [];
      this.logGroups = [];
      this.logSessions = [];
      this.expandedInteractions.clear();
      return;
    }

    if (!confirm('Clear all proxy JSONL log files?')) {
      return;
    }

    this.clearingLogs = true;
    this.logsError = '';
    this.http.delete<{ deletedFiles: number }>('/v1/logs').subscribe({
      next: () => {
        this.clearingLogs = false;
        this.logs = [];
        this.logGroups = [];
        this.logSessions = [];
        this.expandedInteractions.clear();
      },
      error: error => {
        this.clearingLogs = false;
        this.logsError = error?.error?.message || error?.message || 'Failed to clear /v1/logs';
      }
    });
  }

  clearInteraction(group: LogGroup): void {
    if (this.importedLogFileName) {
      const entryIds = new Set(group.entries.map(entry => entry.id));
      this.logs = this.logs.filter(entry => !entryIds.has(entry.id));
      this.groupLogs();
      return;
    }

    if (!confirm(`Delete ${group.exchangeIds.length} exchanges from ${group.label}?`)) {
      return;
    }

    this.clearingLogs = true;
    this.logsError = '';
    this.http.delete<{ deletedEntries: number }>('/v1/logs/exchanges', { body: { ids: group.exchangeIds } }).subscribe({
      next: () => {
        this.clearingLogs = false;
        this.loadLogs();
      },
      error: error => {
        this.clearingLogs = false;
        this.logsError = error?.error?.message || error?.message || 'Failed to clear interaction logs';
      }
    });
  }

  toggleInteraction(group: LogGroup): void {
    if (this.expandedInteractions.has(group.key)) {
      this.expandedInteractions.delete(group.key);
    } else {
      this.expandedInteractions.add(group.key);
    }
  }

  private groupLogs(): void {
    this.logGroups = groupLogEntries(this.logs).map(base => {
      const group: LogGroup = {
        ...base,
        requestCount: 0,
        responseCount: 0,
        toolsCount: 0,
        toolCallIds: [],
        toolCallNames: [],
        tokenUsage: this.emptyTokenUsage()
      };

      for (const entry of group.entries) {
        if (entry.kind === 'proxy-request') {
          group.requestCount += 1;
          group.toolsCount = Math.max(group.toolsCount, Number(entry.payload?.toolsCount ?? 0));
          group.tokenUsage = this.mergeTokenUsage(group.tokenUsage, this.requestUsageEstimate(entry));
        }
        if (entry.kind === 'proxy-response') {
          group.responseCount += 1;
          group.toolCallIds = this.unique([...group.toolCallIds, ...this.responseToolCallIds(entry)]);
          group.toolCallNames = this.unique([...group.toolCallNames, ...this.responseToolCallNames(entry)]);
          group.tokenUsage = this.mergeTokenUsage(group.tokenUsage, this.responseUsage(entry));
        }
      }
      return group;
    });
    this.logSessions = groupLogSessions(this.logGroups);
    const visibleKeys = new Set(this.logGroups.map(group => group.key));
    this.expandedInteractions = new Set([...this.expandedInteractions].filter(key => visibleKeys.has(key)));
  }

  authLabel(configured: boolean | null | undefined): string {
    if (configured === undefined || configured === null) {
      return 'loading';
    }
    return configured ? 'configured' : 'not configured';
  }

  private responseToolCallIds(entry: any): string[] {
    return this.unique(this.parseResponseBody(entry.payload?.body).toolCalls.map(toolCall => toolCall.id).filter(Boolean));
  }

  private responseToolCallNames(entry: any): string[] {
    return this.unique(this.parseResponseBody(entry.payload?.body).toolCalls.map(toolCall => toolCall.name).filter(Boolean));
  }

  flowLabel(entry: any): string {
    if (entry.kind === 'proxy-request') {
      return 'Agent -> Model';
    }
    if (entry.kind === 'proxy-response') {
      return 'Model -> Agent';
    }
    return entry.kind;
  }

  entryTitle(entry: any): string {
    if (entry.kind === 'proxy-request') {
      const model = entry.payload?.body?.model;
      return model ? `model ${model}` : 'request';
    }

    if (entry.kind === 'proxy-response') {
      const status = entry.payload?.status ?? 'response';
      const names = this.responseToolCallNames(entry);
      if (names.length) {
        return `tool call: ${names.join(', ')}`;
      }
      return `status ${status}`;
    }

    return entry.kind;
  }

  openEntryDetails(entry: any): void {
    this.selectedEntry = entry;
    this.selectedResponse = entry?.kind === 'proxy-response' ? this.buildResponseDetail(entry) : null;
    this.openJsonPanels = new Set<string>();
    this.highlightedTextSegments = new Map<string, HighlightedTextSegment[]>();

    this.dialog.open(EntryDetailsDialogComponent, {
      data: {
        entry,
        response: this.selectedResponse,
        host: this
      },
      width: '95vw',
      height: '95vh',
      maxWidth: '95vw',
      maxHeight: '95vh',
      panelClass: 'entry-dialog-panel',
      backdropClass: 'entry-dialog-backdrop',
      autoFocus: false,
      restoreFocus: true,
      scrollStrategy: this.overlay.scrollStrategies.block()
    }).closed.subscribe(() => this.closeEntryDetails());
  }

  closeEntryDetails(): void {
    this.selectedEntry = null;
    this.selectedResponse = null;
    this.openJsonPanels = new Set<string>();
    this.highlightedTextSegments = new Map<string, HighlightedTextSegment[]>();
  }

  toggleJsonPanel(panel: string): void {
    const key = this.jsonPanelKey(panel);
    const next = new Set(this.openJsonPanels);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    this.openJsonPanels = next;
  }

  isJsonPanelOpen(panel: string): boolean {
    return this.openJsonPanels.has(this.jsonPanelKey(panel));
  }

  entryParams(entry: any): ParamDetail[] {
    const payload = entry?.payload ?? {};
    const body = this.entryBody(entry);
    const params: ParamDetail[] = [];

    if (entry?.kind === 'proxy-request') {
      [
        'model',
        'temperature',
        'top_p',
        'max_output_tokens',
        'stream',
        'tool_choice',
        'parallel_tool_calls',
        'text',
        'reasoning',
        'previous_response_id',
        'store',
        'include',
        'metadata'
      ].forEach(name => this.addParam(params, name, body?.[name]));
      this.addParam(params, 'messages', requestMessageCount(body));
      this.addParam(params, 'input items', typeof body?.input === 'string' ? 1 : this.asArray(body?.input).length);
      this.addParam(params, 'tools', this.asArray(body?.tools).length);
      this.addParam(
        params,
        'estimated prompt tokens',
        `~${this.formatNumber(this.requestUsageEstimate(entry).estimatedMaxPromptTokens)} (~4 chars/token)`
      );
      return params;
    }

    if (entry?.kind === 'proxy-response') {
      this.addParam(params, 'status', payload.status);
      this.addParam(params, 'durationMs', payload.durationMs);
      this.addParam(params, 'id', body?.id);
      this.addParam(params, 'model', body?.model);
      this.addParam(params, 'object', body?.object);
      this.addParam(params, 'created_at', body?.created_at);
      this.addParam(params, 'response status', body?.status);
      this.addParam(params, 'output items', this.asArray(body?.output).length);
      this.addParam(params, 'usage', body?.usage);
      return params;
    }

    this.addParam(params, 'kind', entry?.kind);
    return params;
  }

  entryMessages(entry: any): MessageDetail[] {
    const body = this.entryBody(entry);
    if (entry?.kind === 'proxy-request') {
      const messages: MessageDetail[] = [];
      if (body?.instructions) {
        messages.push(this.toMessageDetail({ role: 'instructions', content: body.instructions }, messages.length));
      }
      const input = typeof body?.input === 'string' ? [{ role: 'user', content: body.input }] : this.asArray(body?.input);
      input.forEach((item, index) => {
        messages.push(this.toMessageDetail({ ...item, role: item.role ?? item.type, content: item.content ?? item.output ?? item.arguments },
          messages.length, { source: `input[${index}]` }, `input[${index}]`));
      });
      return messages;
    }

    if (entry?.kind === 'proxy-response') {
      return this.asArray(body?.output).map((item: any, index: number) => this.toMessageDetail(
        { ...item, role: item.role ?? item.type, content: item.content ?? item.arguments }, index));
    }

    return [];
  }

  entryTools(entry: any): ToolDetail[] {
    const body = this.entryBody(entry);
    return this.asArray(body?.tools).map((tool, index) => {
      const definition = tool;
      return {
        index,
        name: definition?.name ?? `tool-${index + 1}`,
        description: definition?.description ?? '',
        descriptionHtml: this.markdownToSafeHtml(definition?.description ?? ''),
        json: JSON.stringify(tool, null, 2)
      };
    });
  }

  private buildResponseDetail(entry: any): ResponseDetail {
    const payload = entry?.payload ?? {};
    const rawBody = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body ?? {}, null, 2);
    const parsed = this.parseResponseBody(payload.body);
    const finishReasons = this.unique(parsed.finishReasons);
    const responseError = this.entryBody(entry)?.error ?? parsed.chunks
      .map(chunk => chunk.response?.error ?? chunk.error).find(Boolean);
    const responseType = responseError ? 'provider error' : parsed.toolCalls.length
      ? 'tool call'
      : parsed.assistantText
        ? 'assistant message'
        : 'empty';
    const overview: ParamDetail[] = [];

    this.addParam(overview, 'response type', responseType);
    this.addParam(overview, 'HTTP status', payload.status);
    this.addParam(overview, 'error', responseError?.message);
    this.addParam(overview, 'error parameter', responseError?.param);
    this.addParam(overview, 'durationMs', payload.durationMs);
    this.addParam(overview, 'model', parsed.model);
    this.addParam(overview, 'response id', parsed.responseId);
    this.addParam(overview, 'response status', finishReasons.join(', '));
    this.addParam(overview, 'SSE chunks', parsed.chunks.length);
    this.addParam(overview, 'content chars', parsed.assistantText.length);
    this.addParam(overview, 'tool calls', parsed.toolCalls.length);
    if (!parsed.usage) {
      const estimatedOutputTokens = this.estimatedCompletionTokens(parsed);
      this.addParam(
        overview,
        'estimated output tokens',
        estimatedOutputTokens ? `~${this.formatNumber(estimatedOutputTokens)}` : 'unavailable'
      );
    }

    return {
      overview,
      assistantText: parsed.assistantText,
      toolCalls: parsed.toolCalls,
      usage: this.usageParams(parsed.usage, this.estimatedCompletionTokens(parsed)),
      streaming: this.streamingParams(parsed),
      parsedChunksJson: JSON.stringify(parsed.chunks, null, 2),
      rawBody
    };
  }

  private parseResponseBody(body: any): ParsedResponse {
    const responses = parseResponsesBody(body);
    if (responses) {
      return { ...responses, toolCalls: responses.toolCalls.map(call => this.toResponseToolCallDetail(call)) };
    }
    let value = body;
    if (typeof body === 'string') {
      try { value = JSON.parse(body); } catch { value = null; }
    }
    return {
      assistantText: '', chunks: value ? [value] : [], finishReasons: [],
      model: '', responseId: '', toolCalls: [], usage: null,
      contentChunkCount: 0, toolArgumentChunkCount: 0, finishChunkCount: 0, usageChunkCount: 0
    };
  }

  private toResponseToolCallDetail(toolCall: {
    index: number;
    id: string;
    type: string;
    name: string;
    argumentsText: string;
  }): ResponseToolCallDetail {
    let argumentsJson: any | null = null;
    try {
      argumentsJson = toolCall.argumentsText ? JSON.parse(toolCall.argumentsText) : null;
    } catch {
      argumentsJson = null;
    }

    const argumentsFields: ParamDetail[] = [];
    if (argumentsJson && typeof argumentsJson === 'object' && !Array.isArray(argumentsJson)) {
      Object.entries(argumentsJson).forEach(([label, value]) => this.addParam(argumentsFields, label, value));
    }

    return {
      index: toolCall.index,
      id: toolCall.id,
      type: toolCall.type,
      name: toolCall.name,
      argumentsText: toolCall.argumentsText,
      argumentsJson,
      argumentsFields
    };
  }

  private usageParams(usage: any | null, estimatedOutputTokens = 0): ParamDetail[] {
    const params: ParamDetail[] = [];
    if (!usage) {
      this.addParam(params, 'source', 'estimated; provider did not report usage');
      this.addParam(params, 'estimated_output_tokens', estimatedOutputTokens ? `~${estimatedOutputTokens}` : 'unavailable');
      this.addParam(params, 'estimation method', 'visible assistant text and tool-call arguments at ~4 chars/token');
      return params;
    }
    this.addParam(params, 'input_tokens', usage.input_tokens);
    this.addParam(params, 'output_tokens', usage.output_tokens);
    this.addParam(params, 'total_tokens', usage.total_tokens);
    const promptTokens = usage.input_tokens;
    const cachedTokens = usage.input_tokens_details?.cached_tokens;
    this.addParam(params, 'cached_tokens', cachedTokens);
    this.addParam(params, 'reasoning_tokens', usage.output_tokens_details?.reasoning_tokens);
    if (promptTokens && cachedTokens !== undefined) {
      const ratio = (Number(cachedTokens) / Number(promptTokens)) * 100;
      this.addParam(params, 'cache ratio', `${ratio.toFixed(1)}%`);
    }
    return params;
  }

  private streamingParams(parsed: {
    chunks: any[];
    contentChunkCount: number;
    toolArgumentChunkCount: number;
    finishChunkCount: number;
    usageChunkCount: number;
  }): ParamDetail[] {
    const params: ParamDetail[] = [];
    this.addParam(params, 'total SSE chunks', parsed.chunks.length);
    this.addParam(params, 'content chunks', parsed.contentChunkCount);
    this.addParam(params, 'tool argument chunks', parsed.toolArgumentChunkCount);
    this.addParam(params, 'finish chunks', parsed.finishChunkCount);
    this.addParam(params, 'usage chunks', parsed.usageChunkCount);
    return params;
  }

  highlightXml(value: string): HighlightedTextSegment[] {
    const text = value ?? '';
    const cached = this.highlightedTextSegments.get(text);
    if (cached) {
      return cached;
    }

    const segments: HighlightedTextSegment[] = [];
    const xmlTagPattern = /(<\/?[A-Za-z][A-Za-z0-9:_-]*(?:\s+[^<>]*?)?\/?>)/g;
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = xmlTagPattern.exec(text)) !== null) {
      if (match.index > cursor) {
        segments.push({ text: text.slice(cursor, match.index), xmlTag: false });
      }
      segments.push({ text: match[0], xmlTag: true });
      cursor = match.index + match[0].length;
    }

    if (cursor < text.length) {
      segments.push({ text: text.slice(cursor), xmlTag: false });
    }

    const result = segments.length ? segments : [{ text, xmlTag: false }];
    this.highlightedTextSegments.set(text, result);
    return result;
  }

  entryMeta(entry: any): string {
    if (entry.kind === 'proxy-request') {
      const body = entry.payload?.body;
      const messageCount = requestMessageCount(body);
      const inputCount = Array.isArray(body?.input) ? body.input.length : typeof body?.input === 'string' ? 1 : 0;
      return `${messageCount} messages${body?.input != null ? ` · ${inputCount} input items` : ''}`;
    }

    if (entry.kind === 'proxy-response') {
      const duration = Number(entry.payload?.durationMs ?? 0);
      const status = entry.payload?.status;
      return [status ? `HTTP ${status}` : '', duration ? `${duration} ms` : '']
        .filter(Boolean)
        .join(' · ');
    }

    return '';
  }

  entryTokenMeta(entry: any): string {
    if (entry.kind === 'proxy-request') {
      const tools = Number(entry.payload?.toolsCount ?? 0);
      const estimatedPromptTokens = this.requestUsageEstimate(entry).estimatedMaxPromptTokens;
      return [
        estimatedPromptTokens ? `~${this.formatNumber(estimatedPromptTokens)} prompt` : '',
        tools ? `${tools} tools` : ''
      ].filter(Boolean).join(' · ');
    }

    if (entry.kind === 'proxy-response') {
      const usage = this.responseUsage(entry);
      if (!usage.hasReportedUsage) {
        const estimatedOutputTokens = this.estimatedCompletionTokens(this.parseResponseBody(entry?.payload?.body));
        return estimatedOutputTokens
          ? `~${this.formatNumber(estimatedOutputTokens)} output estimated`
          : 'usage not reported';
      }
      const parts = [
        `${this.formatNumber(usage.totalTokens)} total`,
        `${this.formatNumber(usage.promptTokens)} prompt`,
        `${this.formatNumber(usage.completionTokens)} completion`
      ];
      if (usage.cachedTokens) {
        parts.push(`${this.formatNumber(usage.cachedTokens)} cached`);
      }
      return parts.join(' · ');
    }

    return '';
  }

  entryMetaTooltip(entry: any): string {
    if (entry.kind === 'proxy-request') {
      return 'Number of messages included in this request body.';
    }
    if (entry.kind === 'proxy-response') {
      return 'HTTP status returned by upstream and proxy-measured response duration.';
    }
    return 'Technical metadata for this log entry.';
  }

  entryTokenTooltip(entry: any): string {
    if (entry.kind === 'proxy-request') {
      return 'Estimated prompt size for this request at approximately four characters per token, plus the number of tool definitions exposed to the model.';
    }
    if (entry.kind === 'proxy-response') {
      if (!this.responseUsage(entry).hasReportedUsage) {
        return 'The provider did not include a usage object. Output is estimated from assistant text, reasoning and tool-call data at approximately four characters per token.';
      }
      return 'Token usage reported by the model for this response: total, prompt, completion and cached tokens.';
    }
    return 'Token or tool metadata for this log entry.';
  }

  formatNumber(value: number): string {
    return Number(value || 0).toLocaleString();
  }

  contextUsagePercent(usage: TokenUsageSummary): number {
    if (!usage.contextLimit) {
      return 0;
    }
    return Math.min(100, Math.round((this.contextPromptTokens(usage) / usage.contextLimit) * 100));
  }

  contextPromptTokens(usage: TokenUsageSummary): number {
    return usage.hasReportedPromptTokens ? usage.maxPromptTokens : usage.estimatedMaxPromptTokens;
  }

  contextUsageIsEstimated(usage: TokenUsageSummary): boolean {
    return !usage.hasReportedPromptTokens && usage.estimatedMaxPromptTokens > 0;
  }

  contextUsageTooltip(usage: TokenUsageSummary): string {
    if (this.contextUsageIsEstimated(usage)) {
      return 'The provider did not report prompt token usage. The displayed value is estimated from request messages, tools and system content at approximately four characters per token.';
    }
    if (usage.hasReportedPromptTokens) {
      return 'Largest prompt token count reported by the provider in this interaction, divided by the estimated model context limit.';
    }
    return 'The provider did not report prompt token usage and the request did not contain enough data to estimate it.';
  }

  shortId(value: string): string {
    if (!value) {
      return 'not provided';
    }
    return value.length > 8 ? value.slice(0, 8) : value;
  }

  private unique(values: string[]): string[] {
    return Array.from(new Set(values));
  }

  private jsonPanelKey(panel: string): string {
    return `${this.selectedEntry?.id ?? 'entry'}:${panel}`;
  }

  private emptyTokenUsage(): TokenUsageSummary {
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      maxPromptTokens: 0,
      estimatedMaxPromptTokens: 0,
      contextLimit: 128000,
      hasReportedUsage: false,
      hasReportedPromptTokens: false
    };
  }

  private mergeTokenUsage(left: TokenUsageSummary, right: TokenUsageSummary): TokenUsageSummary {
    return {
      promptTokens: left.promptTokens + right.promptTokens,
      completionTokens: left.completionTokens + right.completionTokens,
      totalTokens: left.totalTokens + right.totalTokens,
      cachedTokens: left.cachedTokens + right.cachedTokens,
      maxPromptTokens: Math.max(left.maxPromptTokens, right.maxPromptTokens),
      estimatedMaxPromptTokens: Math.max(left.estimatedMaxPromptTokens, right.estimatedMaxPromptTokens),
      contextLimit: Math.max(left.contextLimit, right.contextLimit),
      hasReportedUsage: left.hasReportedUsage || right.hasReportedUsage,
      hasReportedPromptTokens: left.hasReportedPromptTokens || right.hasReportedPromptTokens
    };
  }

  private responseUsage(entry: any): TokenUsageSummary {
    const parsed = this.parseResponseBody(entry?.payload?.body);
    const usage = parsed.usage ?? {};
    const hasReportedUsage = parsed.usage !== null && parsed.usage !== undefined;
    const hasReportedPromptTokens = usage.input_tokens != null;
    const promptTokens = Number(usage.input_tokens ?? 0);
    const completionTokens = Number(usage.output_tokens ?? 0);
    const model = parsed.model || '';
    return {
      promptTokens,
      completionTokens,
      totalTokens: Number(usage.total_tokens ?? promptTokens + completionTokens),
      cachedTokens: Number(usage.input_tokens_details?.cached_tokens ?? 0),
      maxPromptTokens: promptTokens,
      estimatedMaxPromptTokens: 0,
      contextLimit: this.contextLimitForModel(model),
      hasReportedUsage,
      hasReportedPromptTokens
    };
  }

  private requestUsageEstimate(entry: any): TokenUsageSummary {
    const body = entry?.payload?.body ?? {};
    const promptShape = {
      input: body.input,
      instructions: body.instructions,
      tools: body.tools,
      tool_choice: body.tool_choice,
      text: body.text
    };
    const hasPromptData = promptShape.input !== undefined || promptShape.instructions !== undefined
      || promptShape.tools !== undefined;
    const estimatedPromptTokens = hasPromptData
      ? Math.max(1, Math.ceil(JSON.stringify(promptShape).length / 4))
      : 0;
    return {
      ...this.emptyTokenUsage(),
      estimatedMaxPromptTokens: estimatedPromptTokens,
      contextLimit: this.contextLimitForModel(String(body.model ?? ''))
    };
  }

  private estimatedCompletionTokens(parsed: ParsedResponse): number {
    const outputText = parsed.assistantText + parsed.toolCalls
      .map(toolCall => `${toolCall.name}${toolCall.argumentsText}`)
      .join('');
    return outputText ? Math.max(1, Math.ceil(outputText.length / 4)) : 0;
  }

  private contextLimitForModel(model: string): number {
    const normalized = model.toLowerCase();
    if (normalized.includes('gpt-4.1') || normalized.includes('gpt-4o') || normalized.includes('o4')) {
      return 128000;
    }
    if (normalized.includes('gpt-3.5')) {
      return 16385;
    }
    return 128000;
  }

  private entryBody(entry: any): any {
    const body = entry?.payload?.body;
    if (typeof body !== 'string') {
      return body ?? {};
    }

    try {
      return JSON.parse(body);
    } catch {
      return { content: body };
    }
  }

  private asArray(value: any): any[] {
    return Array.isArray(value) ? value : [];
  }

  private toMessageDetail(
    message: any,
    index: number,
    metadata: any = null,
    label = `message[${index}]`
  ): MessageDetail {
    const { role, content, ...rest } = message ?? {};
    const extra = {
      ...rest,
      ...(metadata ?? {})
    };
    const cleanExtra = Object.keys(extra).length ? extra : null;
    return {
      index,
      label,
      role: role ?? 'message',
      content: this.contentToText(content),
      extra: cleanExtra
    };
  }

  private addParam(params: ParamDetail[], label: string, value: any): void {
    if (value === undefined || value === null || value === '') {
      return;
    }
    params.push({
      label,
      value: typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
    });
  }

  private markdownToSafeHtml(markdown: string): SafeHtml {
    const html = marked.parse(markdown, { async: false }) as string;
    const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    return this.sanitizer.bypassSecurityTrustHtml(clean);
  }

  private contentToText(content: any): string {
    if (content == null) {
      return '';
    }
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content.map(part => {
        if (typeof part === 'string') {
          return part;
        }
        if (typeof part?.text === 'string') {
          return part.text;
        }
        return JSON.stringify(part, null, 2);
      }).join('\n');
    }
    return JSON.stringify(content, null, 2);
  }

  private maxTimestamp(left: string, right: string): string {
    return this.timestampMs(right) > this.timestampMs(left) ? right : left;
  }

  private timestampMs(timestamp: string): number {
    const parsed = Date.parse(timestamp);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  send(): void {
    let request: ReturnType<typeof buildLabRequest>;
    try {
      request = buildLabRequest(this.selectedModel, this.prompt);
    } catch (error: any) {
      this.sendError = error.message;
      return;
    }
    this.sending = true;
    this.sendError = '';
    this.lastResponse = null;

    this.http.post<any>(request.path, request.body).subscribe({
      next: response => {
        this.sending = false;
        this.lastResponse = this.parseResponseBody(response);
        if (response.error) this.sendError = requestErrorMessage({ error: response });
        this.loadLogs();
      },
      error: error => {
        this.sending = false;
        this.sendError = requestErrorMessage(error);
        this.loadLogs();
      }
    });
  }

  private selectRecentModel(): void {
    if (this.selectedModel) return;
    const available = new Set(this.models.map(model => model.id));
    const recent = this.logs.find(entry => entry.kind === 'proxy-request' && available.has(entry.payload?.body?.model));
    if (recent) this.selectedModel = recent.payload.body.model;
  }
}

bootstrapApplication(AppComponent, {
  providers: [provideHttpClient()]
}).catch(error => console.error(error));
