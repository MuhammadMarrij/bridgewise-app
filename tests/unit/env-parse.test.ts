import { describe, it, expect } from 'vitest';

// Regression: a value that is only a trailing comment must parse as empty, not as
// the comment text. Otherwise doctor reports an absent MODEL_API_KEY as configured
// and the P4 live-agent blocker disappears silently.
const parse = (line: string): [string, string] | null => {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  return m ? [m[1]!, m[2]!.replace(/(^|\s)#.*$/, '').trim()] : null;
};

describe('.env line parsing', () => {
  it('reads a plain value', () => {
    expect(parse('APP_ENV=local_demo')).toEqual(['APP_ENV', 'local_demo']);
  });
  it('strips a trailing comment', () => {
    expect(parse('EXECUTION_MODE=SIMULATED   # LIVE is not implemented'))
      .toEqual(['EXECUTION_MODE', 'SIMULATED']);
  });
  it('treats a comment-only value as empty', () => {
    expect(parse('MODEL_API_KEY=            # server-only')).toEqual(['MODEL_API_KEY', '']);
  });
  it('keeps a url containing no comment intact', () => {
    expect(parse('DATABASE_URL=postgresql://u:p@localhost:5432/db'))
      .toEqual(['DATABASE_URL', 'postgresql://u:p@localhost:5432/db']);
  });
  it('ignores a non-assignment line', () => {
    expect(parse('# just a comment')).toBeNull();
  });
});
