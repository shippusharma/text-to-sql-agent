import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeReadOnly } from './db';

const originalAllowedDirs = process.env.SQLITE_ALLOWED_DIRS;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalAllowedDirs === undefined) delete process.env.SQLITE_ALLOWED_DIRS;
  else process.env.SQLITE_ALLOWED_DIRS = originalAllowedDirs;
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sqliteProfile(databasePath: string) {
  return {
    dialect: 'sqlite' as const,
    name: 'test',
    description: '',
    path: databasePath,
    ssl: false,
    sslRejectUnauthorized: true,
    timeoutMs: 30_000,
    maxRows: 500,
    maxResponseBytes: 5_000_000,
    allowedObjects: [],
  };
}

test('does not open a database for an already-cancelled query', async () => {
  const abort = new AbortController();
  abort.abort();

  await expect(
    executeReadOnly(
      sqliteProfile('/definitely/missing/queryroom.sqlite'),
      'SELECT 1',
      abort.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
});

test('rejects a SQLite symlink that escapes the configured directory', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'queryroom-db-test-'));
  tempDirs.push(root);
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside.sqlite');
  const link = path.join(allowed, 'linked.sqlite');
  mkdirSync(allowed);
  writeFileSync(outside, 'not opened');
  symlinkSync(outside, link);
  process.env.SQLITE_ALLOWED_DIRS = allowed;

  await expect(executeReadOnly(sqliteProfile(link), 'SELECT 1')).rejects.toThrow(
    'outside the directories allowed',
  );
});
