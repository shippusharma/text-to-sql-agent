import { z } from 'zod';

export type Dialect = 'postgresql' | 'mysql' | 'sqlite';

const sharedConnection = {
  name: z.string().min(1, 'Database name is required.').max(80),
  description: z.string().max(240).default(''),
  ssl: z.boolean().default(false),
  sslRejectUnauthorized: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  maxRows: z.number().int().min(1).max(10000).default(500),
  maxResponseBytes: z.number().int().min(10000).max(50000000).default(5000000),
  allowedObjects: z.array(z.string().min(1).max(255)).max(200).default([]),
};

export const connectionProfileSchema = z.discriminatedUnion('dialect', [
  z.object({
    ...sharedConnection,
    dialect: z.literal('postgresql'),
    host: z.string().min(1, 'Database host is required.').max(255),
    port: z.number().int().min(1).max(65535).default(5432),
    database: z.string().min(1, 'Database name is required.').max(255),
    username: z.string().min(1, 'Database username is required.').max(255),
    password: z.string().min(1, 'Database password is required.').max(2000),
  }),
  z.object({
    ...sharedConnection,
    dialect: z.literal('mysql'),
    host: z.string().min(1, 'Database host is required.').max(255),
    port: z.number().int().min(1).max(65535).default(3306),
    database: z.string().min(1, 'Database name is required.').max(255),
    username: z.string().min(1, 'Database username is required.').max(255),
    password: z.string().min(1, 'Database password is required.').max(2000),
  }),
  z.object({
    ...sharedConnection,
    dialect: z.literal('sqlite'),
    path: z.string().min(1, 'SQLite file path is required.').max(1000),
    ssl: z.boolean().default(false),
  }),
]);
export type ConnectionProfile = z.infer<typeof connectionProfileSchema>;

const modelBaseUrlSchema = z.string().refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}, 'The model base URL must be a valid HTTP(S) URL without embedded credentials.');

export const modelProfileSchema = z.object({
  provider: z.enum(['openai']),
  model: z.string().min(1, 'Model name is required.').max(120),
  apiKey: z.string().min(1, 'API key is required.').max(4000),
  baseUrl: modelBaseUrlSchema.optional().or(z.literal('')),
  temperature: z.number().min(0).max(1).default(0),
});
export type ModelProfile = z.infer<typeof modelProfileSchema>;

export type SchemaSnapshot = {
  tables: Array<{
    name: string;
    schema?: string;
    columns: Array<{ name: string; type: string }>;
  }>;
  relationships: Array<{
    fromSchema?: string;
    fromTable: string;
    fromColumn: string;
    toSchema?: string;
    toTable: string;
    toColumn: string;
  }>;
  fingerprint: string;
};

// Earlier turns of the same conversation: the question and the SQL that answered it. Query
// results are never included, so the model still never sees your data.
const historyTurnSchema = z.object({
  question: z.string().max(4000),
  sql: z.string().max(20000).optional(),
});
export type HistoryTurn = z.infer<typeof historyTurnSchema>;

export const runRequestSchema = z.object({
  question: z.string().trim().min(2).max(20000),
  connection: connectionProfileSchema,
  model: modelProfileSchema,
  threadId: z.string().min(8).max(120),
  history: z.array(historyTurnSchema).max(10).default([]),
});

export const resumeRequestSchema = z.object({
  threadId: z.string().min(8).max(120),
  runId: z.string().min(8).max(120),
  decision: z.enum(['approve', 'reject', 'edit']),
  // The browser holds the pending SQL; the server validates it again before running anything.
  sql: z.string().max(20000).optional(),
  explanation: z.string().max(4000).optional(),
  connection: connectionProfileSchema,
});

export type QueryColumn = { name: string; type?: string };
export type QueryResult = {
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
};

type ApprovalRequest = {
  runId: string;
  sql: string;
  explanation: string;
  tables: string[];
  checks: string[];
  errors: string[];
};

export type StreamEvent =
  | { type: 'run.started'; runId: string }
  | { type: 'stage.started' | 'stage.completed'; stage: string }
  | { type: 'sql.ready'; sql: string; explanation: string; tables: string[]; checks: string[] }
  | ({ type: 'approval.required' } & ApprovalRequest)
  | { type: 'query.started' }
  | { type: 'result.completed'; result: QueryResult }
  | { type: 'run.completed'; answer: string }
  | { type: 'run.error'; message: string };
