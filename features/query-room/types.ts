import type { ConnectionProfile, ModelProfile, QueryResult } from '@/lib/types';

export type CheckState = 'idle' | 'testing' | 'success' | 'error';

export type SetupForm = {
  name: string;
  description: string;
  dialect: 'postgresql' | 'mysql' | 'sqlite';
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  path: string;
  ssl: boolean;
  sslRejectUnauthorized: boolean;
  allowedObjects: string;
  timeoutMs: string;
  maxRows: string;
  maxResponseBytes: string;
};

export type ModelForm = {
  provider: 'openai';
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: string;
};

export type StoredProfiles = {
  connection: ConnectionProfile;
  model: ModelProfile;
  /** Random key that encrypts chat history. Never sent to the server. */
  threadsKey?: string;
};

export type Approval = {
  runId: string;
  sql: string;
  explanation: string;
  tables: string[];
  checks: string[];
  /** Problems with SQL the user edited. Approval is blocked until they are fixed. */
  errors: string[];
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  stages?: string[];
  currentStage?: string;
  sql?: string;
  approval?: Approval;
  result?: QueryResult;
  running?: boolean;
  rejected?: boolean;
  stopped?: boolean;
};

export type ChatThread = {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
};
