-- UNDO 002 — emergency only: re-opens OMS tables to the public key (old behaviour).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['oms_orders','oms_payments','oms_products','oms_trash',
      'oms_fraud_list','customer_profiles','oms_reconciliation_history'] LOOP
    IF to_regclass('public.'||t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO anon, authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS oms_open ON public.%I', t);
    EXECUTE format('CREATE POLICY oms_open ON public.%I FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
