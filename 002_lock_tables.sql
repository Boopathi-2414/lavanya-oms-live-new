-- 002 — LOCK CUSTOMER DATA TO YOUR LOGIN (run ONLY after the new site works)
-- Effect: without login, nobody can read or change OMS data with the public key.
-- WARNING: the OLD app (hard-coded login, no Supabase Auth) stops working after this.
--          Run it only when everyone uses the new site.
-- BEFORE RUNNING: replace PUT-UID-HERE (one place below) with your login's User UID
--          (Supabase > Authentication > Users). Undo: deploy/002_undo_lock.sql
-- No rows are changed or deleted. Only access rules change.
DO $$
DECLARE
  owner uuid := 'PUT-UID-HERE';
  t text; p record;
BEGIN
  FOREACH t IN ARRAY ARRAY['oms_orders','oms_payments','oms_products','oms_trash',
      'oms_fraud_list','oms_business_records','customer_profiles','oms_reconciliation_history'] LOOP
    IF to_regclass('public.'||t) IS NULL THEN RAISE NOTICE 'skip % (table not found)', t; CONTINUE; END IF;
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY oms_owner ON public.%I FOR ALL TO authenticated USING ((select auth.uid()) = %L::uuid) WITH CHECK ((select auth.uid()) = %L::uuid)', t, owner, owner);
    RAISE NOTICE 'locked %', t;
  END LOOP;
END $$;
