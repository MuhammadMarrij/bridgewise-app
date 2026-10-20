-- Real accounts. A user owns one wallet (the workspace keyed by session_id).
-- Passwords are stored only as scrypt hashes with a per-user salt.
CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "name" text NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "sessions" ("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_login_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" (lower("email"));
--> statement-breakpoint
CREATE UNIQUE INDEX "users_session_key" ON "users" ("session_id");
