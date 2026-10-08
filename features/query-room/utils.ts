'use client';

import {
  connectionProfileSchema,
  modelProfileSchema,
  type ConnectionProfile,
  type ModelProfile,
  type QueryResult,
  type StreamEvent,
} from '@/lib/types';
import { decryptWithDataKey, encryptWithDataKey, type DataEnvelope } from '@/lib/security/vault';
import {
  LEGACY_STORAGE_KEYS,
  readStorage,
  removeStorage,
  STORAGE_KEYS,
  writeStorage,
} from '@/lib/storage';
import type { ChatMessage, ChatThread, ModelForm, SetupForm } from './types';

export const initialSetup: SetupForm = {
  name: 'Local analytics database',
  description: '',
  dialect: 'postgresql',
  host: 'localhost',
  port: '5432',
  database: '',
  username: '',
  password: '',
  path: '',
  ssl: false,
  sslRejectUnauthorized: true,
  allowedObjects: '',
  timeoutMs: '30000',
  maxRows: '500',
  maxResponseBytes: '5000000',
};

export const initialModel: ModelForm = {
  provider: 'openai',
  model: '',
  apiKey: '',
  baseUrl: '',
  temperature: '0',
};

export function threadTitle(messages: ChatMessage[]) {
  const question = messages.find(message => message.role === 'user')?.text?.trim();
  if (!question) return 'New conversation';

  const compact = question.replace(/\s+/g, ' ');
  return compact.length > 58 ? `${compact.slice(0, 58)}…` : compact;
}

export function upsertActiveThread(
  threads: ChatThread[],
  threadId: string,
  messages: ChatMessage[],
  updatedAt = Date.now(),
) {
  if (!threadId || !messages.some(message => message.role === 'user')) return threads;
  const existing = threads.find(thread => thread.id === threadId);
  if (existing?.messages === messages) return threads;
  const updated: ChatThread = {
    id: threadId,
    title:
      existing && existing.title !== 'New conversation' ? existing.title : threadTitle(messages),
    messages: messages.slice(-30),
    createdAt: existing?.createdAt ?? updatedAt,
    updatedAt,
  };
  return [updated, ...threads.filter(thread => thread.id !== threadId)];
}

function isChatThread(value: unknown): value is ChatThread {
  if (!value || typeof value !== 'object') return false;
  const thread = value as Partial<ChatThread>;
  return (
    typeof thread.id === 'string' &&
    typeof thread.title === 'string' &&
    Array.isArray(thread.messages) &&
    typeof thread.createdAt === 'number' &&
    typeof thread.updatedAt === 'number'
  );
}

// Approvals saved by older versions cannot be resumed (they have no run id).
function expireLegacyApprovals(thread: ChatThread): ChatThread {
  return {
    ...thread,
    messages: thread.messages.map(message =>
      message.approval && !message.approval.runId
        ? {
            ...message,
            approval: undefined,
            text: 'This approval expired. Ask the question again to get a fresh query.',
          }
        : message,
    ),
  };
}

function readLegacyThreads(): ChatThread[] {
  return readLegacyThreadList().map(expireLegacyApprovals);
}

function readLegacyThreadList(): ChatThread[] {
  const v2 = readStorage<unknown>(LEGACY_STORAGE_KEYS.threadsV2, null);
  if (Array.isArray(v2)) return v2.filter(isChatThread);

  const v1 = readStorage<unknown>(LEGACY_STORAGE_KEYS.threadsV1, null);
  if (!Array.isArray(v1) || !v1.length) return [];

  const messages = v1 as ChatMessage[];
  if (!messages.some(message => message.role === 'user')) return [];

  const timestamp = Date.now();
  return [
    {
      id: `thread-${crypto.randomUUID()}`,
      title: threadTitle(messages),
      messages,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
}

// Older versions saved a static welcome message and empty placeholder conversations.
function tidyThreads(threads: ChatThread[]) {
  return threads
    .map(thread => ({
      ...thread,
      messages: thread.messages.filter(message => message.id !== 'welcome'),
    }))
    .filter(thread => thread.messages.some(message => message.role === 'user'));
}

/**
 * Loads encrypted chat history. Plaintext history from older versions is migrated into encrypted
 * storage once and then removed.
 */
export async function loadThreads(threadsKey: string): Promise<ChatThread[]> {
  const envelope = readStorage<DataEnvelope | null>(STORAGE_KEYS.threads, null);
  if (envelope) {
    try {
      const threads = await decryptWithDataKey<unknown>(envelope, threadsKey);
      return Array.isArray(threads) ? tidyThreads(threads.filter(isChatThread)) : [];
    } catch {
      return [];
    }
  }

  const legacy = tidyThreads(readLegacyThreads());
  if (legacy.length && (await saveThreads(legacy, threadsKey))) {
    Object.values(LEGACY_STORAGE_KEYS).forEach(removeStorage);
  }
  return legacy;
}

// Keeps saved history small enough for browser storage; full results stay in memory.
const PERSISTED_ROWS_PER_RESULT = 200;

function compactThreads(threads: ChatThread[], rowsPerResult: number): ChatThread[] {
  return threads.map(thread => ({
    ...thread,
    messages: thread.messages.map(message => {
      if (!message.result || message.result.rows.length <= rowsPerResult) return message;
      return {
        ...message,
        result: {
          ...message.result,
          rows: message.result.rows.slice(0, rowsPerResult),
          truncated: true,
        },
      };
    }),
  }));
}

/** Encrypts and saves chat history, dropping result rows if browser storage is full. */
export async function saveThreads(
  threads: ChatThread[],
  threadsKey: string,
  isCurrent: () => boolean = () => true,
) {
  for (const rowsPerResult of [PERSISTED_ROWS_PER_RESULT, 20, 0]) {
    try {
      if (!isCurrent()) return false;
      const envelope = await encryptWithDataKey(compactThreads(threads, rowsPerResult), threadsKey);
      if (!isCurrent()) return false;
      writeStorage(STORAGE_KEYS.threads, envelope);
      return true;
    } catch {
      // Most likely the storage quota; retry with fewer saved rows.
    }
  }
  return false;
}

export function makeConnection(form: SetupForm): ConnectionProfile {
  const common = {
    name: form.name.trim() || 'Untitled database',
    description: form.description,
    ssl: form.ssl,
    sslRejectUnauthorized: form.sslRejectUnauthorized,
    timeoutMs: Number(form.timeoutMs) || 30000,
    maxRows: Number(form.maxRows) || 500,
    maxResponseBytes: Number(form.maxResponseBytes) || 5000000,
    allowedObjects: form.allowedObjects
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
  };

  if (form.dialect === 'sqlite')
    return connectionProfileSchema.parse({ ...common, dialect: 'sqlite', path: form.path.trim() });

  return connectionProfileSchema.parse({
    ...common,
    dialect: form.dialect,
    host: form.host.trim(),
    port: Number(form.port),
    database: form.database.trim(),
    username: form.username.trim(),
    password: form.password,
  });
}

export function makeModel(form: ModelForm): ModelProfile {
  return modelProfileSchema.parse({
    provider: form.provider,
    model: form.model.trim(),
    apiKey: form.apiKey,
    baseUrl: form.baseUrl.trim(),
    temperature: Number(form.temperature) || 0,
  });
}

export function friendlyTestError(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  if (
    !message ||
    error.name === 'ZodError' ||
    error.name === 'SyntaxError' ||
    /failed to fetch|networkerror|network request/i.test(message)
  )
    return fallback;
  return message;
}

export function updateMessage(messages: ChatMessage[], id: string, update: Partial<ChatMessage>) {
  return messages.map(message => (message.id === id ? { ...message, ...update } : message));
}

export async function consumeStream(
  url: string,
  body: unknown,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    let message = 'The request could not be started.';
    try {
      const data = (await response.json()) as { message?: unknown };
      if (typeof data.message === 'string' && data.message.trim()) message = data.message;
    } catch {
      // Keep the safe fallback when the server does not return JSON.
    }
    throw new Error(message);
  }
  if (!response.body) throw new Error('Streaming is not available in this browser.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(line => {
      if (line.trim()) onEvent(JSON.parse(line) as StreamEvent);
    });
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as StreamEvent);
}

export function formatCell(value: unknown) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function escapeCsvCell(value: unknown) {
  const text = formatCell(value);
  const safe = typeof value === 'string' && /^[\t\r ]*[=+\-@]/.test(value) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function exportCsv(result: QueryResult) {
  const header = result.columns.map(column => escapeCsvCell(column.name)).join(',');
  const rows = result.rows.map(row =>
    result.columns.map(column => escapeCsvCell(row[column.name])).join(','),
  );
  downloadBlob(
    new Blob([[header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8' }),
    'query-results.csv',
  );
}

export function exportJson(result: QueryResult) {
  downloadBlob(
    new Blob([JSON.stringify(result.rows, null, 2)], { type: 'application/json' }),
    'query-results.json',
  );
}

export async function exportXlsx(result: QueryResult) {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Results');
  worksheet.columns = result.columns.map(column => ({ header: column.name, key: column.name }));
  result.rows.forEach(row => worksheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    'query-results.xlsx',
  );
}
