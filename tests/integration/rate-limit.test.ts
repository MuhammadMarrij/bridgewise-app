import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rateLimit } from '@/lib/api/http';

describe('rate limit', () => {
  it('counts in the database, so every server instance shares one window', async () => {
    const key = `test:${randomUUID()}`;
    for (let i = 0; i < 3; i++) await rateLimit(key, 3, 60_000);
    await expect(rateLimit(key, 3, 60_000)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('keeps separate keys separate', async () => {
    const a = `test:${randomUUID()}`, b = `test:${randomUUID()}`;
    await rateLimit(a, 1, 60_000);
    await expect(rateLimit(b, 1, 60_000)).resolves.toBeUndefined();
  });
});
