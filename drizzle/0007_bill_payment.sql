-- M3: a bill paid from the wallet. "Sent" means it left BridgeWise's book for the
-- university; the university's own confirmation is a separate fact, not assumed.
ALTER TABLE "obligations" ADD COLUMN "paid_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "obligations" ADD COLUMN "paid_proposal_id" uuid REFERENCES "action_proposals" ("id");
