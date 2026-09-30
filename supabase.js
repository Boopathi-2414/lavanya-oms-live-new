// ============================================================
// SUPABASE — background customer-profile / fraud-history sync
// ============================================================
// Configured for Lavanya OMS v5 deployment.
//
// FALLBACK SAFETY: If Supabase is unreachable (network issue,
// wrong credentials, RLS error), ALL functions are safe no-ops.
// The app continues to work 100% on localStorage — no data is
// ever lost or deleted from localStorage by this module.
//
// KEY FORMAT: Uses Supabase's newer "<REDACTED-ANON-KEY>" key format
// (supported in @supabase/supabase-js v2.60+).
//
// For Vercel deployment, set these Environment Variables in
// Vercel Dashboard → Settings → Environment Variables:
//   VITE_SUPABASE_URL      = https://<PROJECT-REF>.supabase.co
//   VITE_SUPABASE_ANON_KEY = <REDACTED-ANON-KEY>

let _client = null;
let _clientPromise = null;
let _connectionHealthy = true; // tracks if last Supabase call succeeded

// Read from Vite environment variables (set in .env locally or Vercel dashboard)
const SUPABASE_URL = typeof import.meta !== 'undefined'
  ? import.meta.env?.VITE_SUPABASE_URL
  : undefined;
const SUPABASE_KEY = typeof import.meta !== 'undefined'
  ? import.meta.env?.VITE_SUPABASE_ANON_KEY
  : undefined;

// ── isSupabaseConfigured ─────────────────────────────────────
// Returns true only when both URL and KEY are present and non-empty.
// Used throughout the app to gate all Supabase calls.
export function isSupabaseConfigured() {
  return Boolean(
    SUPABASE_URL &&
    SUPABASE_KEY &&
    SUPABASE_URL.includes('supabase.co')
  );
}
// ── isSupabaseHealthy ────────────────────────────────────────
// Returns false after any failed Supabase call, so callers can
// quickly decide to fall back to localStorage without retrying.
export function isSupabaseHealthy() {
  return _connectionHealthy;
}

// ── getClient ────────────────────────────────────────────────
// Lazily initialises the Supabase client. Returns null if not
// configured or if the import fails (falls back to localStorage).
export async function getClient() {
  if (!isSupabaseConfigured()) return null;
  if (_client) return _client;
  if (!_clientPromise) {
    _clientPromise = import('@supabase/supabase-js')
      .then(({ createClient }) => {
        _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false,
          },
          global: {
            fetch: (...args) => {
              // Wrap fetch so any network error marks connection unhealthy
              return window.fetch(...args).then(res => {
                if (res.ok) _connectionHealthy = true;
                return res;
              }).catch(err => {
                _connectionHealthy = false;
                throw err;
              });
            }
          }
        });
        return _client;
      })
      .catch((e) => {
        console.error(
          '[Lavanya OMS] Supabase client failed to load — ' +
          'falling back to localStorage-only mode:', e
        );
        _clientPromise = null;
        _connectionHealthy = false;
        return null;
      });
  }
  return _clientPromise;
}

// ── normKey ──────────────────────────────────────────────────
// Normalises customer name + phone into a stable lookup key.
// Must match the logic in db.js checkFraud() / detectRepeatReturners().
function normKey(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── upsertCustomerProfile ────────────────────────────────────
// Fire-and-forget: called once per imported order.
// Never blocks or throws — PDF import continues at full speed
// even if Supabase is offline. localStorage data is NEVER touched.
export async function upsertCustomerProfile({
  customer, phone, address, companyId, channel, orderId, orderType
}) {
  try {
    const client = await getClient();
    if (!client) return; // not configured — silent no-op

    const key = normKey(customer) + '|' + normKey(phone);
    if (!key.replace('|', '').trim()) return;

    const { data: existing, error: fetchErr } = await client
      .from('customer_profiles')
      .select('id, order_count, return_count')
      .eq('lookup_key', key)
      .maybeSingle();

    if (fetchErr) {
      _connectionHealthy = false;
      console.warn('[Lavanya OMS] Supabase fetch error (non-fatal):', fetchErr.message);
      return;
    }

    const isReturnish = orderType === 'Exchange';
    const orderCount  = (existing?.order_count  || 0) + 1;
    const returnCount = (existing?.return_count || 0) + (isReturnish ? 1 : 0);

    const { error: upsertErr } = await client.from('customer_profiles').upsert({
      lookup_key:    key,
      customer_name: customer  || '',
      phone:         phone     || '',
      address:       address   || '',
      company_id:    companyId || 'unknown',
      channel:       channel   || '',
      last_order_id: orderId   || '',
      order_count:   orderCount,
      return_count:  returnCount,
      updated_at:    new Date().toISOString(),
    }, { onConflict: 'lookup_key' });

    if (upsertErr) {
      _connectionHealthy = false;
      console.warn('[Lavanya OMS] Supabase upsert error (non-fatal):', upsertErr.message);
    } else {
      _connectionHealthy = true;
    }
  } catch (e) {
    _connectionHealthy = false;
    console.error(
      '[Lavanya OMS] upsertCustomerProfile failed (non-fatal, ' +
      'localStorage data is safe):', e
    );
  }
}

// ── recordReturnOutcome ──────────────────────────────────────
// Called when an order moves to a returned/RTO state.
// Updates the background return-count used for fraud flagging.
export async function recordReturnOutcome({ customer, phone }) {
  try {
    const client = await getClient();
    if (!client) return;

    const key = normKey(customer) + '|' + normKey(phone);
    if (!key.replace('|', '').trim()) return;

    const { data: existing, error: fetchErr } = await client
      .from('customer_profiles')
      .select('id, return_count')
      .eq('lookup_key', key)
      .maybeSingle();

    if (fetchErr || !existing) {
      if (fetchErr) _connectionHealthy = false;
      return;
    }

    const { error: updateErr } = await client
      .from('customer_profiles')
      .update({
        return_count: (existing.return_count || 0) + 1,
        updated_at:   new Date().toISOString(),
      })
      .eq('lookup_key', key);

    if (updateErr) {
      _connectionHealthy = false;
      console.warn('[Lavanya OMS] Supabase update error (non-fatal):', updateErr.message);
    }
  } catch (e) {
    _connectionHealthy = false;
    console.error('[Lavanya OMS] recordReturnOutcome failed (non-fatal):', e);
  }
}

// ── getCustomerProfile ───────────────────────────────────────
// Looks up stored fraud history for a customer.
// Returns null (never throws) if Supabase isn't configured or fails.
// Callers treat null as "no history" — same as localStorage-only mode.
export async function getCustomerProfile({ customer, phone }) {
  try {
    const client = await getClient();
    if (!client) return null;

    const key = normKey(customer) + '|' + normKey(phone);
    if (!key.replace('|', '').trim()) return null;

    const { data, error } = await client
      .from('customer_profiles')
      .select('*')
      .eq('lookup_key', key)
      .maybeSingle();

    if (error) {
      _connectionHealthy = false;
      console.warn('[Lavanya OMS] Supabase getCustomerProfile error (non-fatal):', error.message);
      return null;
    }

    _connectionHealthy = true;
    return data || null;
  } catch (e) {
    _connectionHealthy = false;
    console.error('[Lavanya OMS] getCustomerProfile failed (non-fatal):', e);
    return null;
  }
}
