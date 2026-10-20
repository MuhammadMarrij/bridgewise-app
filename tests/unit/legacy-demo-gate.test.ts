import { afterEach, describe, expect, it } from 'vitest';
import { assertLegacyDemoEnabled } from '@/lib/api/http';

describe('legacy demo endpoints', () => {
  const prev = process.env.APP_ENV;
  afterEach(() => { process.env.APP_ENV = prev; });

  it('are absent on the hosted site, so nobody gets a session without signing up', () => {
    process.env.APP_ENV = 'hosted_demo';
    expect(() => assertLegacyDemoEnabled()).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('stay available locally and in tests', () => {
    process.env.APP_ENV = 'local_demo';
    expect(() => assertLegacyDemoEnabled()).not.toThrow();
  });
});
