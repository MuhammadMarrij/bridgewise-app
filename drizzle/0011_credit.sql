-- Credit-building progress: steps the student marks done that the app cannot
-- detect for itself (for example, real-name verification inside Alipay).
CREATE TABLE "credit_progress" (
  "session_id" uuid NOT NULL REFERENCES "sessions" ("id") ON DELETE CASCADE,
  "step_id" text NOT NULL,
  "done_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("session_id", "step_id")
);
