DROP INDEX IF EXISTS "issues_active_stale_run_evaluation_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_stale_run_evaluation_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_fingerprint")
  WHERE "origin_kind" = 'stale_active_run_evaluation'
    AND "origin_fingerprint" <> 'default'
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
