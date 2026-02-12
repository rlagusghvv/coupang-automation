import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// This test guards against SQLITE_BUSY errors when many jobs are enqueued at once
// (e.g. bulk upload from recommendations list).

test('storage_sqlite: concurrent createJob does not throw SQLITE_BUSY', async () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couplus-sqlite-'));
  const prevCwd = process.cwd();
  process.chdir(tmp);

  try {
    const storagePath = path.join(repoRoot, 'src', 'server', 'storage_sqlite.js');
    const mod = await import(storagePath);

    await mod.initDb();

    const email = `test-${Date.now()}@example.com`;
    const user = await mod.createUser({ email, password: 'pw' });
    assert.ok(user?.id);

    const N = 40;
    const jobs = await Promise.all(
      Array.from({ length: N }, (_, i) => mod.createJob({
        userId: user.id,
        kind: 'upload',
        inputUrl: `https://domeggook.com/${49640000 + i}`,
        force: '0',
        catalogId: null,
      })),
    );

    assert.equal(jobs.length, N);
    const listed = await mod.listJobs(user.id, { kind: 'upload', limit: 200 });
    assert.ok(listed.length >= N);
  } finally {
    process.chdir(prevCwd);
  }
});
