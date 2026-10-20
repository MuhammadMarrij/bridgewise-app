-- Fixed-window request counters shared by every server instance. On Vercel each
-- function instance has its own memory, so an in-process counter limits nothing.
CREATE TABLE IF NOT EXISTS rate_limits (
  key text NOT NULL,
  window_start bigint NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (key, window_start)
);
