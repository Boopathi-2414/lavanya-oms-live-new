# VPS deployment — frontend on VPS, existing Supabase database retained

This source release targets a Linux VPS with Docker Engine + Compose, and an HTTPS reverse proxy. It does not migrate Postgres onto the VPS. If your VPS is Windows or uses an existing control panel, adapt the hosting configuration rather than replacing its web server.

## Prerequisites and order

1. Keep the existing release and a full database backup. Verify the app against a separate TEST Supabase project first.
2. The existing OMS tables (`oms_orders`, `oms_payments`, `oms_products`, `oms_trash`, `oms_fraud_list`, `customer_profiles`, `oms_reconciliation_history`) and their restricted RLS policies must already exist. This is an upgrade, not a fresh database bootstrap.
3. Run `001_business_records.sql` on TEST. For a different project, replace its authorised UID first. Review existing policies; this migration does not remove policies belonging to other releases. No anonymous data access is required.
4. Create `.env` from `.env.example`. Set the project URL, **public publishable/anon key**, authorised user UID, and `VITE_ENVIRONMENT=test`. Never use a service-role/secret key in frontend environment variables.
5. Run `docker compose build` then `docker compose up -d`. Verify `curl http://127.0.0.1:8080/health` returns `ok`. Port 8080 binds to loopback only.
6. Configure your current reverse proxy or Caddy using `Caddyfile.example`. Replace `oms.example.com` with your actual domain, point DNS to your VPS and obtain HTTPS. Keep other hosted sites intact. Supabase Auth site URL/redirect configuration must use the intended HTTPS domain.
7. Through HTTPS: login, refresh, verify import/dispatch/return/payment, run 10 rapid keyboard scans and confirm after reload on a second device. Then test with the real hardware scanner and full expected batch size. Confirm no duplicate stock movement or payment transaction.
8. Check Supabase RLS with an unauthorised account: it must not read or write any business table. Test simultaneous-device edits and decide who owns each parcel/count until server-side locking is implemented.
9. Only after acceptance switch to the intended database and `VITE_ENVIRONMENT=production`, then **rebuild**. Vite environment values are embedded at build time. Changing `.env` alone does not change an already-built app.

Do not serve production with `npm run dev` or `vite preview`. Nginx serves the compiled `dist` output. Docker, TLS and live VPS execution were not available for validation in this task; only the Vite production build and local application workflows were executed.

## Backups / rollback

The app's automatic recovery copies use browser IndexedDB and are local only. Configure separate scheduled encrypted database backups, retention and a restore drill with your database administrator. Export full JSON before imports. Excel is not a full database backup. The JSON UI restores missing records only.

For frontend rollback, redeploy the prior image/source build and environment. New business records remain in their additional table; an older frontend will not show them. Do not delete that table or overwrite production with test exports.

## Runtime limits

Single authorised admin model. Existing record sync uses last-writer-wins and there is no server-side stock locking. Do not approve unrestricted multi-operator production use until these cases have been addressed and tested. Network retries protect queued local changes but are not a substitute for a database backup. Opening/recount timestamps use client clocks; keep device clocks correct.

The provided Compose exposes only the static app. It does not provide email, domain purchase, payment gateway, marketplace APIs, Postgres administration, payroll, or scheduled off-site backup.

## Official references

- Vite static deployment: https://vite.dev/guide/static-deploy
- Supabase row-level security: https://supabase.com/docs/guides/database/postgres/row-level-security
