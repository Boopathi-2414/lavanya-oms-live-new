-- Run on the existing OMS TEST project first. No existing records are changed.
-- For another project, replace the authorised UID below before running.
BEGIN;
CREATE TABLE IF NOT EXISTS public.oms_business_records (
 id text PRIMARY KEY,
 data jsonb NOT NULL DEFAULT '{}'::jsonb,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.oms_business_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.oms_business_records FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.oms_business_records TO authenticated;
DROP POLICY IF EXISTS oms_business_owner ON public.oms_business_records;
CREATE POLICY oms_business_owner ON public.oms_business_records FOR ALL TO authenticated
 USING ((select auth.uid()) = '31f9ac9d-ba24-475a-831f-694e454c8de6'::uuid)
 WITH CHECK ((select auth.uid()) = '31f9ac9d-ba24-475a-831f-694e454c8de6'::uuid);
COMMIT;
-- Optional: enable Realtime for this table in Supabase Database > Publications.
-- Existing OMS tables and their policies are required and are not replaced here.
