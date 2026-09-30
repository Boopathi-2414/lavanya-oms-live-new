import { CACHE_PREFIX } from './environment.js';
import { createWorker } from 'tesseract.js';
import { encodeCache, decodeCache } from './localCacheCodec.js';
import { recoverDispatches, clearPersistedDispatches } from './dispatchJournal.js';

// ============================================================
// DATA STORE — localStorage  (swap bodies for Supabase later)
// ============================================================
const STORAGE_KEY = CACHE_PREFIX + 'oms_v3';

export function loadDB() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = recoverDispatches(decodeCache(raw));
      return {
        orders: Array.isArray(p.orders) ? p.orders : [],
        payments: Array.isArray(p.payments) ? p.payments : [],
        products: Array.isArray(p.products) ? p.products : [],
        trash: Array.isArray(p.trash) ? p.trash : [],
        fraudList: Array.isArray(p.fraudList) ? p.fraudList : [],
        businessRecords: Array.isArray(p.businessRecords) ? p.businessRecords : [],
      };
    }
  } catch (_) { /* ignore */ }
  return recoverDispatches({ orders: [], payments: [], products: [], trash: [], fraudList: [], businessRecords: [] });
}

// ── saveDB ───────────────────────────────────────────────────
// Writes the local cache, and NEVER fails silently.
//
// BUG THIS FIXES (Aug 2026): this was one line — `try { setItem } catch
// (_) {}`. Measured in a real browser, this account's data crosses the
// localStorage quota at almost exactly its working volume:
//
//     10,000 orders →  4.8 MB → saves fine
//     20,000 orders →  9.6 MB → QuotaExceededError
//
// So at ~20k orders every single save was throwing and being swallowed.
// Nothing was written to disk at all: each scan updated React state, the
// screen said "Dispatched", and if the tab was closed or reloaded before
// the Supabase push completed, the scan was simply gone — with no error
// anywhere. The offline fallback the comment advertised did not exist.
//
// Supabase is the real record, so the local copy is a cache and is
// allowed to be partial. When the full write does not fit, the cache is
// trimmed to the records that actually matter — everything not yet
// synced (`keepIds`, which must never be dropped) plus the most recent
// activity — and retried. The caller is told what happened so it can
// warn the user instead of pretending all is well.
//
// (A larger store — IndexedDB — is the proper long-term home for this
// much data and would remove the trimming entirely.)
export function saveDB(db, keepIds) {
  const write = (payload) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    clearPersistedDispatches(payload);
  };
  try {
    write(db);
    return { ok: true, trimmed: false };
  } catch (err) {
    try {
      localStorage.setItem(STORAGE_KEY, encodeCache(db));
      clearPersistedDispatches(db);
      return { ok: true, trimmed: false, compact: true };
    } catch (_) { /* Try the existing protected cache fallback below. */ }
    // Quota (or private-mode) failure — fall back to a trimmed cache.
    const keep = keepIds instanceof Set ? keepIds : new Set(keepIds || []);
    const recency = (o) => o?.receivedDate || o?.transitDate || o?.dispatchedAt || o?.createdAt || o?.orderDate || '';
    for (const limit of [8000, 4000, 2000, 800, 200]) {
      try {
        const orders = [...(db.orders || [])].sort((a, b) => String(recency(b)).localeCompare(String(recency(a))));
        const mustKeep = orders.filter((o) => o?.id && keep.has(o.id));
        const rest = orders.filter((o) => !(o?.id && keep.has(o.id))).slice(0, limit);
        write({
          ...db,
          orders: [...mustKeep, ...rest],
          trash: (db.trash || []).slice(0, Math.min(limit, 500)),
          __partialCache: true,
        });
        return { ok: true, trimmed: true, kept: mustKeep.length + rest.length, error: err?.name };
      } catch (_) { /* still too big — try a smaller limit */ }
    }
    return { ok: false, trimmed: false, error: err?.name || 'StorageError' };
  }
}

export function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

export function today() {
  return new Date().toISOString().split('T')[0];
}

const TEMPLATES = {
  payments: 'Order ID,AWB,Settlement Amount,GST,Date',
  returns: 'Order ID,AWB,Status,Return Type,Return Reason',   // Return Type = "Customer Return" | "RTO"; Return Reason = see RETURN_REASONS
  products: 'SKU,HSN,Category,Purchase Rate,MRP,Stock',
  claims: 'Order ID,AWB,Claim Amount,Reason,Date',
};

// ── RETURN TYPE helpers ──────────────────────────────────────
// Valid values: 'Customer Return' | 'RTO' | '' (unknown)
export const RETURN_TYPES = ['Customer Return', 'RTO'];

// CSS class name for each type (used in JSX)
export function returnTypeClass(rt) {
  if (rt === 'Customer Return') return 'rt-customer';
  if (rt === 'RTO') return 'rt-rto';
  return 'rt-unknown';
}

// Short display label
export function returnTypeLabel(rt) {
  if (rt === 'Customer Return') return '↩ Customer Return';
  if (rt === 'RTO') return '🚚 RTO';
  return '— Unknown';
}

// Normalise raw strings from Excel / manual input
// BUG THIS FIXES (Sep 2026 — "scanned parcels don't become Return
// Received"): this only understood Meesho's wording. Meesho writes
// "Customer Return" and "Courier Return (RTO)", both of which matched.
// Flipkart writes `customer_return` / `courier_return` /
// `logistics_return`, and Amazon writes `C-Returns` / `Undelivered` /
// `Rejected` — `courier_return`, `logistics_return`, `C-Returns` and
// `Rejected` matched NEITHER branch and came back as '' (blank).
//
// A blank return_type is not a cosmetic problem. Received.jsx only
// auto-marks a scan when `order.return_type` is set; with it blank the
// scan shows a confirmation card and waits for a click instead. The
// packer scans the next parcel, the card is replaced, and that order
// silently stays "In Transit (Return)" — which is exactly the
// "scan panniyum Return Received aagala" symptom, on Flipkart and
// Amazon returns only.
export function normalizeReturnType(raw) {
  const s = (raw || '').trim().toLowerCase();
  // Buyer-initiated. Checked first so `customer_return` can never be
  // caught by the `courier`/`return` words in the RTO branch below.
  if (/customer|cust|buyer/i.test(s) || /^c-?returns?$/i.test(s)) return 'Customer Return';
  // Came back without the buyer taking delivery.
  if (/rto|undeliver|reject|courier|logistic|return\s+to\s+origin/i.test(s)) return 'RTO';
  return '';
}

// ── SCAN NORMALISATION ───────────────────────────────────────
// One definition of "are these two waybills the same string", used on
// BOTH sides of every scan comparison — what the scanner typed and what
// the order has stored.
//
// BUG THIS FIXES (Sep 2026 — "some return parcels show a red ❌"):
// Dispatch.jsx normalised a scan with `.trim().toUpperCase()
// .replace(/\s+/g,'')` and also stripped an "AWB#" prefix and pulled the
// waybill out of a tracking URL. Received.jsx did none of that — it used
// `scanValue.trim().replace(/-/g,'')` alone, with NO uppercasing and no
// space stripping, and compared it against the stored value equally
// unnormalised. So the SAME physical parcel could scan fine at Dispatch
// and come back "not found" at Return Received:
//   • a Shadowfax return stored "R1234567890FPL", scanner emits
//     lowercase → no match
//   • a scanner appending a space, or a label reading "AWB# FMPR…"
//     → no match
//   • a QR encoding the courier's tracking URL → no match
// Hyphens, spaces and case can never distinguish two real waybills, so
// removing them cannot create a false match.
export function normalizeScan(raw) {
  let s = String(raw || '').trim();
  // Some scanners are set to emit the courier's tracking URL rather than
  // the bare waybill — take the last meaningful path/query segment.
  if (/^https?:\/\//i.test(s)) {
    const m = s.match(/[A-Za-z0-9]{8,}/g);
    if (m && m.length) s = m[m.length - 1];
  }
  s = s.replace(/^A?WB\s*#?\s*N?[o0]?\.?\s*:?\s*/i, '');
  return s.toUpperCase().replace(/[\s\-]/g, '');
}

// ── RETURN REASON helpers ────────────────────────────────────
// Why the item actually came back (separate from RETURN_TYPES above,
// which only says whether it was courier-returned or customer-returned).
// Mandatory on every return record so SKU/category-level return analytics
// (see buildReturnAnalytics below) can be broken down by root cause.
export const RETURN_REASONS = ['Size Issue', 'Damage', 'Quality Issue', 'Wrong Item Sent', 'Customer Changed Mind', 'Others'];

// Best-effort match for reasons coming from an Excel import (free text).
export function normalizeReturnReason(raw) {
  const s = (raw || '').trim().toLowerCase();
  // Meesho writes "NA"/"null" in the reason column for RTO rows — the
  // courier returned it, the buyer never gave a reason. Treating those
  // as real text made every RTO land in "Others" and drown out the
  // genuine customer-return reasons in Return Analytics.
  if (!s || s === 'na' || s === 'n/a' || s === 'null' || s === '-') return '';
  const hit = RETURN_REASONS.find((r) => r.toLowerCase() === s);
  if (hit) return hit;
  // Patterns below are written against the wording Meesho actually
  // exports, in BOTH its reason columns — checked against a real 263-row
  // return file. Order matters: "wrong size delivered" is a wrong-item
  // complaint, not a sizing one, so the wrong-item test runs first.
  if (/wrong\s*(item|product)|different\s*(product|colour|color)|not\s*as\s*(described|shown)|different\s*from\s*shown/.test(s)) {
    return 'Wrong Item Sent';
  }
  if (/size|fit\b|too\s*(tight|loose|small|big)/.test(s)) return 'Size Issue';
  if (/damage|broken|torn/.test(s)) return 'Damage';
  if (/quality|defect|stain|dirty|not\s*good|performance/.test(s)) return 'Quality Issue';
  if (/changed?\s*(my\s*)?mind|no\s*longer\s*(need|want)|don'?t\s*need|not\s*need|did\s*not\s*like|didn'?t\s*like|ordered\s*by\s*mistake|lower\s*price/.test(s)) {
    return 'Customer Changed Mind';
  }
  return 'Others';
}

export function downloadTemplate(type) {
  const headers = TEMPLATES[type];
  if (!headers) return;
  const blob = new Blob([headers + '\n'], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `template_${type}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function normalizeDate(raw) {
  if (!raw) return today();
  const m = raw.trim().match(/^(\d{2})[.\-\/](\d{2})[.\-\/](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return today();
}

export function statusClass(s) {
  return (
    {
      'Ready to Ship': 's-ready', Dispatched: 's-dispatched',
      'In Transit (Return)': 's-transit', 'Return Received': 's-received'
    }[s] || 's-ready'
  );
}

// ── AWB display helper (returns plain string for table cells) ──
export function awbText(o) {
  if (!o.awb) return '—';
  if (o.channel === 'Amazon' && o.awb.startsWith('IN-')) return `${o.awb} ⚠ref`;
  return o.awb;
}

// ── EXCHANGE DETECTION ───────────────────────────────────────
// Returns true if the page text contains exchange/replacement keywords.
//
// Previously this used \b(word)\b boundaries. That silently misses the
// keyword whenever the PDF's text layer glues two words together with no
// space in between (e.g. "EXCHANGEORDER" as a single token) — pdfjs does
// this on some Amazon/Flipkart/Meesho label templates depending on how
// the label was generated. A plain case-insensitive substring search is
// more forgiving and doesn't have that failure mode; false positives are
// effectively a non-issue here since none of these words show up
// incidentally on a shipping label.
export function detectExchange(pageText) {
  const s = (pageText || '').toLowerCase();
  const KEYWORDS = [
    'exchange',        // covers "exchange order", "size exchange", "colour/color exchange", etc.
    'replacement',      // "replacement order", "replacement item"
    'replace order',
    'replace item',
    'exch order',       // some labels abbreviate "Exch" instead of "Exchange"
    'exch item',
    'reshipment',
    're-shipment',
    'reship',
    'exchg',            // another common abbreviation seen on some labels
    'product exchange', // Meesho-style phrasing
    'return & exchange',
    'return and exchange',
    'new for old',
  ];
  return KEYWORDS.some((k) => s.includes(k));
}

// ── FRAUD CHECK ──────────────────────────────────────────────
// Returns a matching fraud entry if name/phone/address matches any blocklist entry
export function checkFraud(fraudList, { customer, phone, address }) {
  if (!fraudList || !fraudList.length) return null;
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const nc = norm(customer);
  const np = norm(phone);
  const na = norm(address);
  return fraudList.find((f) => {
    if (nc && norm(f.customer) && norm(f.customer) === nc) return true;
    if (np && norm(f.phone) && norm(f.phone) === np) return true;
    if (na && norm(f.address) && na.length > 5 && na.includes(norm(f.address))) return true;
    return false;
  }) || null;
}

// ============================================================
// MULTI-COMPANY DETECTION
// ============================================================
// One seller can run several GST-registered businesses across
// marketplaces (e.g. a different company per Meesho/Amazon/Flipkart
// account). Each label prints its company in two places that are both
// far more reliable than guessing from layout position: the "If
// undelivered, return to:" block and the "Sold by:"/registration block,
// which also carries the GSTIN or Enrolment Number — a value that is
// unique per registration and therefore the strongest possible signal.
// Detection is a known-company lookup (never a freeform name guess) so
// it can never misfile an order under the wrong business.
export const COMPANIES = [
  {
    id: 'lavanya',
    name: 'Lavanya Aari Materials',
    aliases: ['LAVANYA AARI MATERIALS', 'LAVANYA AARI'],
    gstin: '33FPAPB6603C1ZO',
    returnCode: '641007,1097145',
    // Street token unique to this company's own pickup address. Used ONLY
    // inside the label's return-address block (see detectCompany), never
    // against the page as a whole — a Coimbatore buyer could live on the
    // same street, and their address must never decide the seller.
    returnHint: 'VEDAPATTI',
  },
  {
    // FIX (Aug 2026): display name previously said "Nandhu Resin Castle",
    // which didn't match this entry's id/aliases at all — any label that
    // matched "JWELLERY MAKERS HUB" etc. was being shown under the wrong
    // business name everywhere in the UI. Corrected to match the id/aliases.
    id: 'jwellery',
    name: 'Jewellery Makers',
    aliases: ["JWELLERY MAKER'S HUB", 'JWELLERY MAKERS HUB', "JEWELLERY MAKER'S HUB", 'JEWELLERY MAKERS HUB'],
    enrolment: '332500048299ES5',
    returnCode: '641007,3375073',
    returnHint: 'KALIKKANACKEN',
  },
  {
    // FIX (Aug 2026): display name previously said "Hanvill Enterprises"
    // (typo) despite id/aliases all saying "hornbill" — corrected.
    id: 'hornbill',
    name: 'Hornbill Enterprises',
    aliases: ['HORNBILL ENT', 'HORNBILL ENTERPRISES'],
    gstin: '33ODOPS2902C1ZF',
    returnCode: '641007,3446518',
    returnHint: 'THONADAMUTHUR',
  },
  {
    // Fourth seller account, added Sep 2026 from its first real labels.
    //
    // Not GST-registered — its invoices are a BILL OF SUPPLY carrying an
    // Enrolment No. instead of a GSTIN, exactly like Jewellery Makers.
    //
    // CAREFUL, and the reason returnCode exists: this company's own
    // registered address line literally reads
    //   "Lavanya Art and Craft, 19/14 Sundapalayam HORNBILL ENTERPRISE
    //    19/14, Mettukadu, Coimbatore"
    // so the string "HORNBILL ENT" appears on every one of its labels and
    // matches Hornbill's alias. Its return-address block also contains
    // "Vedapatti", which is Lavanya Aari Materials' return hint. Three
    // separate things keep it straight: the Enrolment No. and the Return
    // Code both outrank any alias, and where two aliases do both match the
    // longer, more specific one wins (see detectCompany).
    id: 'lavanyaartcraft',
    name: 'Lavanya Art and Craft',
    aliases: ['LAVANYA ART AND CRAFT', 'LAVANYA ART & CRAFT', 'LAVANYA ART CRAFT'],
    enrolment: '332500023389ESD',
    returnCode: '641007,2718220',
  },
];

function normCompanyText(s) {
  return (s || '').toUpperCase().replace(/['’]/g, '').replace(/\s+/g, ' ');
}

// Returns { id, name } for a confidently-recognized company, or null —
// never a guess. GSTIN/Enrolment Number match (strength 2) always wins
// over a plain name-alias match (strength 1) if both somehow fire for
// different companies on the same page.
export function detectCompany(pageText) {
  const text = normCompanyText(pageText);

  // The seller's OWN pickup address, isolated from the rest of the page.
  //
  // WHY (Sep 2026): an Amazon label-only page carries no GSTIN and no
  // company name — just "Ship From: <proprietor>" and a return address.
  // Such orders filed as "Unknown" and dropped out of every company-wise
  // report. The return-address street identifies the business exactly,
  // but ONLY when read from the return block: the buyer's address sits on
  // the same page and a Coimbatore customer could share a street name, so
  // matching the whole page would let a buyer decide the seller. This
  // slice stops at the next section heading so it can never run on into
  // the rest of the label.
  const returnBlock = normCompanyText(
    (String(pageText || '').match(
      /(?:Return\s*Address|If\s+undelivered,\s*return\s*to)\s*:?([\s\S]{0,220})/i
    ) || [, ''])[1]
  );

  // Digits only, so a Return Code still matches whether the label prints
  // it as "641007,2718220" or with a space or line break after the comma.
  const digitsOnly = String(pageText || '').replace(/\D/g, '');

  let best = null;
  for (const co of COMPANIES) {
    let strength = 0;
    let matchLen = 0;
    if (co.gstin && text.includes(normCompanyText(co.gstin))) strength = 2;
    // A Meesho label prints "Return Code  <pincode>,<supplier id>". The
    // supplier id belongs to exactly one seller account, so this is proof
    // of origin on the LABEL half of the page, where no tax id is printed.
    else if (co.returnCode && digitsOnly.includes(co.returnCode.replace(/\D/g, ''))) strength = 2;
    else if (co.enrolment && text.includes(normCompanyText(co.enrolment))) strength = 2;
    else {
      // Longest matching alias wins a tie.
      //
      // WHY (Sep 2026): "Lavanya Art and Craft"'s own registered address
      // line contains the words "HORNBILL ENTERPRISE", so Hornbill's
      // "HORNBILL ENT" alias matches every one of its labels too. Both
      // companies then sit at strength 1 and whichever happened to be
      // earlier in this list would win. Preferring the longer match makes
      // "LAVANYA ART AND CRAFT" (the company actually named as the seller)
      // beat an eleven-character fragment of another company's name.
      for (const a of co.aliases) {
        const n = normCompanyText(a);
        if (text.includes(n) && n.length > matchLen) { strength = 1; matchLen = n.length; }
      }
    }
    // Weakest signal of all, and deliberately last: only consulted when
    // neither a tax id nor the trading name appears anywhere on the page.
    if (!strength && co.returnHint && returnBlock.includes(normCompanyText(co.returnHint))) strength = 0.5;
    if (strength && (!best || strength > best.strength ||
        (strength === best.strength && matchLen > best.matchLen))) {
      best = { id: co.id, name: co.name, strength, matchLen };
    }
  }
  return best ? { id: best.id, name: best.name } : null;
}

// ============================================================
// COURIER / LOGISTICS-PARTNER DETECTION  (dynamic mapping table)
// ============================================================
// Single place to register a courier so it's picked up everywhere at
// once — AWB-signature recognition, address-block noise filtering, the
// Tier-3 "known courier on page" trust gate below, AND the Dashboard's
// courier-wise analytics (which reads whatever `courier` value ends up
// on each order — it never hardcodes this list itself, see
// buildCourierBreakdown() near the bottom of this file). Adding a new
// partner is exactly one object here; no other file needs to change.
//   - name:       display label used everywhere in the UI.
//   - aliases:    name variants printed on real labels (regex fragments,
//                 case-insensitive — escape any regex-special chars).
//   - awbPattern: OPTIONAL — a courier-specific AWB *shape* regex (no
//                 anchors, no flags) that proves the courier by shape
//                 alone wherever it appears, the same way "SF...FPL"
//                 already proves Shadowfax today. Leave this out for
//                 couriers without a distinctive shape — they're still
//                 detected from `aliases` (the name printed on the
//                 label) instead.
export const COURIERS = [
  { id: 'shadowfax', name: 'Shadowfax', aliases: ['Shadowfax'], awbPattern: 'SF\\d{8,13}FPL' },
  // Ekart's own AWBs aren't always "FMPP…" — bulk PDFs from the same
  // seller account have shown plain "FM…" prefixes too (no fixed C/P
  // letter, fewer/more digits). Both shapes are kept here ONLY as a
  // courier-identity *signature* (proves Ekart wherever it appears) —
  // actually pulling the AWB *value* off a label never depends on this
  // pattern matching at all; that's the keyword-anchored Tier 2 in
  // extractAwbStrict() below, which is already fully prefix-agnostic
  // and accepts literally any shape (FMPP, FMPC, FM, SF, or anything
  // else a courier prints) as long as it follows an AWB/WB-No label.
  // Ekart AWB shapes seen in production:
  //   FMPP<10 digits>, FMPC<10 digits> — classic Ekart prepaid/COD
  //   FM<6-14 digits>                  — shorter FM-prefix variant
  //   SF<8-13 digits>[optional letter] — Shadowfax-routed Flipkart labels
  //                                      (negative lookahead excludes Meesho's SF...FPL)
  // FIX (Aug 2026 bug report): the bare "<10-15 pure digits>" shape was
  // REMOVED from this identity signature. It matched ANY 10-15 digit
  // number regardless of channel/courier — it was misclassifying Meesho
  // orders (whose own numeric AWB/Tracking-ID often falls in that same
  // length range, e.g. the Tier 2f Meesho fallback below) as "Ekart
  // Logistics" in the Courier Partner Breakdown, even though "Ekart"
  // never appeared anywhere on the label. Genuine bare-digit Ekart AWB
  // *value* extraction is unaffected — that runs through
  // extractAwbStrict's Tier 3, which is properly gated on a recognized
  // courier NAME being present on the page. Real Ekart labels with no
  // FM-prefix are still correctly identified via the page-text alias
  // match in detectCourier() below — only the unsafe shape-alone proof
  // was removed.
  { id: 'ekart', name: 'Ekart Logistics', aliases: ['Ekart', 'E-?Kart(?:\\s+Logistics)?'], awbPattern: 'FMPP\\d{8,12}|FMPC\\d{8,12}|FMP[CP]\\d{8,10}|FM\\d{6,14}|SF\\d{8,13}(?!\\s*FPL)' },
  // 'ATSPL_DELHIVERY' is the literal footer Amazon prints when a
  // shipment is handed off to Delhivery instead of Amazon's own
  // network — see 'amazon_shipping' below for the counterpart.
  { id: 'delhivery', name: 'Delhivery', aliases: ['Delhivery', 'ATSPL[_\\s]+DELHIVERY'] },
  { id: 'xpressbees', name: 'Xpressbees', aliases: ['Xpressbees'] },
  { id: 'dtdc', name: 'DTDC', aliases: ['DTDC'] },
  { id: 'bluedart', name: 'Bluedart', aliases: ['Bluedart', 'Blue\\s*Dart'] },
  { id: 'ecomexpress', name: 'Ecom Express', aliases: ['Ecom\\s*Express'] },
  // Amazon's own in-house logistics network. The bare 'ATSPL' footer
  // (no following "DELHIVERY") is what Amazon prints when IT carried
  // the shipment itself rather than handing it to a third-party
  // partner — the negative lookahead keeps this from ever firing on
  // the 'ATSPL_DELHIVERY' handoff footer above (that one is real
  // Delhivery, not Amazon's own network, and must stay attributed to
  // Delhivery in the courier-wise analytics).
  { id: 'amazon_shipping', name: 'Amazon Shipping', aliases: ['ATSPL(?![_\\s]*DELHIVERY)'] },
];

// ============================================================
// CHANNEL → DEFAULT COURIER  (fallback ONLY, never an override)
// ============================================================
// detectCourier() above always wins when a label actually names (or
// AWB-signature-proves) a courier — Meesho in particular genuinely
// ships via several different partners label-to-label (Shadowfax,
// Delhivery, Xpressbees, …), and that real, per-label signal must
// never be discarded in favour of a guess. This table only fills the
// gap for the small number of labels where NOTHING on the page
// identifies a courier at all — instead of those rows landing on
// "Unknown" forever, they get the sales-channel's normal/expected
// partner: Flipkart ships through Ekart, Meesho's most common partner
// is Delhivery, Amazon defaults to its own ATSPL network. Adding or
// changing a channel's default is a one-line edit to this object —
// `resolveCourier()` below and every caller of it pick the change up
// automatically, no other code (or this file's structure) needs to
// change to add a brand-new sales channel + default partner later.
export const CHANNEL_DEFAULT_COURIER = {
  Amazon: 'amazon_shipping',
  Flipkart: 'ekart',
  Meesho: 'delhivery',
};

// Same "never guess wildly" contract as detectCourier(), just with one
// extra, clearly-marked fallback rung: real detection first, then the
// channel default (flagged via `fallback: true` so callers/log output
// can distinguish "read off the label" from "assumed from channel"),
// then finally null if even the channel has no configured default.
export function resolveCourier(pageText, awb, channel) {
  const detected = detectCourier(pageText, awb);
  if (detected) return detected;
  const fallbackId = CHANNEL_DEFAULT_COURIER[channel];
  const co = fallbackId && COURIERS.find((c) => c.id === fallbackId);
  return co ? { id: co.id, name: co.name, fallback: true } : null;
}

// Built from COURIERS so a newly-added entry above automatically extends
// every regex derived below — nothing past this point lists courier
// names literally again. (Kept non-global so repeated `.test()` calls
// elsewhere in this file never trip over regex `lastIndex` state; the
// one spot that needs a global replace — meeshoCleanLines below — builds
// its own fresh global instance from this same pattern string instead of
// reusing this regex object.)
const COURIER_ALIASES_PATTERN = COURIERS.flatMap((c) => c.aliases).join('|');
const KNOWN_COURIERS_RE = new RegExp(`\\b(${COURIER_ALIASES_PATTERN})\\b`, 'i');
const COURIER_AWB_SIGNATURES = COURIERS
  .filter((c) => c.awbPattern)
  .map((c) => ({ id: c.id, name: c.name, re: new RegExp(`(?<![A-Za-z0-9])(?:${c.awbPattern})(?![A-Za-z0-9])`, 'i') }));

// Returns { id, name } for a confidently-recognized courier, or null —
// same "never guess" contract as detectCompany() above. Two ways in:
// (a) the AWB itself matches a registered courier's signature shape
//     (strongest — the shape alone proves the courier), or
// (b) the courier's name/alias is printed somewhere on the page (label
//     header, "Ordered through" block, etc).
// (a) wins if both somehow disagree (an AWB's own shape is harder to
// fake than a nearby printed name on a multi-column label).
export function detectCourier(pageText, awb) {
  if (awb) {
    for (const sig of COURIER_AWB_SIGNATURES) {
      if (sig.re.test(awb)) return { id: sig.id, name: sig.name };
    }
  }
  const text = pageText || '';
  for (const co of COURIERS) {
    const re = new RegExp(`\\b(${co.aliases.join('|')})\\b`, 'i');
    if (re.test(text)) return { id: co.id, name: co.name };
  }
  return null;
}

// ============================================================
// STRICT ORDER-ID / AWB VALIDATION
// ============================================================
// The old parser's biggest weakness was *permissiveness*: separators that
// allowed any whitespace (so a multi-line OCR garble could be stitched
// into a fake order number), no upper bound on digit runs, and — worst of
// all — a couple of regexes that were hardcoded to literal text found in
// one specific sample PDF (a seller's own name, a specific customer's
// name). Those obviously can't generalize to a different upload batch,
// which is exactly the "21 ghost orders out of 14 real labels" / "random
// 2-3 digit numbers instead of the real Order ID" behaviour being
// reported. Every extractor below is now:
//   (a) anchored to the marketplace's fixed ID/AWB shape end-to-end,
//   (b) bounded with `(?<![A-Za-z0-9])...(?![A-Za-z0-9])` so it can never
//       be a fragment of a longer digit/alnum run, and
//   (c) generic — nothing sample-specific baked in.
// If a page doesn't produce a value that satisfies these, the page is
// SKIPPED (logged, visible in the Parse Log) rather than imported with a
// best-guess value. That trade-off is intentional, per the requirement
// that no ghost/half-parsed order should ever reach the Sales table.

function freshRe(pattern, flags = 'g') { return new RegExp(pattern, flags); }
const NB = (core) => `(?<![A-Za-z0-9])(?:${core})(?![A-Za-z0-9])`;

// ---- Amazon Order ID: 405-1234567-1234567  (3-7-7 digits, 2 hyphens) ----
const AMAZON_ID_CORE = `\\d{3}-\\d{7}-\\d{7}`;
export function isAmazonOrderId(id) { return new RegExp(`^${AMAZON_ID_CORE}$`).test(id || ''); }

function findAmazonOrderId(page) {
  const candidates = [...page.matchAll(freshRe(NB(AMAZON_ID_CORE)))].map((m) => m[0]);
  if (!candidates.length) {
    // ── OCR-repaired Order Id ──────────────────────────────────────────
    // BUG THIS FIXES (Sep 2026): an Amazon PDF containing ONLY the
    // shipping label — no invoice page beside it — imported ZERO orders
    // and said so nowhere except the parse log. Everything needed was on
    // the page: the barcode gave the AWB 372191623130 perfectly. What
    // failed was the Order Id, because OCR renders the label's hyphens
    // as spaced em-dashes:
    //     Order Id: 408 — 5850870 — 3717930
    // and the strict \d{3}-\d{7}-\d{7} shape cannot match that. On a
    // normal label+invoice batch the invoice page carries the id as real
    // text so this never showed; with a label-only file the whole parcel
    // silently disappeared — one order lost, no error, nothing to notice.
    //
    // Anchored on the "Order Id/Number" keyword and requiring EXACTLY
    // seventeen digits, so an arbitrary digit run elsewhere on the label
    // (pincode, date, sort code) can never be mistaken for an order id.
    const ocr = page.match(
      /Order\s*(?:Number|No\.?|[I1l]d|#)\s*[:\s]*((?:\d[\s‐-―-]*){17})(?!\s*\d)/i
    );
    if (ocr) {
      const d = ocr[1].replace(/\D/g, '');
      if (d.length === 17) {
        const id = `${d.slice(0, 3)}-${d.slice(3, 10)}-${d.slice(10)}`;
        return { id, candidate: id, ocrRepaired: true };
      }
    }
    return { id: null, candidate: null };
  }
  // Prefer whichever candidate is actually preceded by an "Order
  // Number/Id/#" label within a short window — guards against a
  // coincidentally-shaped hyphenated number elsewhere on the invoice
  // (e.g. a GST/HSN string) winning over the real order number.
  const labelled = candidates.find((c) => {
    const idx = page.indexOf(c);
    const before = page.slice(Math.max(0, idx - 40), idx);
    return /Order\s*(?:Number|No\.?|[I1l]d|#)/i.test(before);
  });
  const chosen = labelled || candidates[0];
  return { id: isAmazonOrderId(chosen) ? chosen : null, candidate: chosen };
}

// ---- Flipkart Order ID: "OD" + 15-18 digits ----
const FLIPKART_ID_CORE = `OD\\d{15,18}`;
export function isFlipkartOrderId(id) { return new RegExp(`^${FLIPKART_ID_CORE}$`, 'i').test(id || ''); }

function findFlipkartOrderId(page) {
  const candidates = [...page.matchAll(freshRe(NB(FLIPKART_ID_CORE), 'gi'))].map((m) => m[0].toUpperCase());
  if (!candidates.length) return { id: null, candidate: null };
  const labelled = candidates.find((c) => {
    const idx = page.toUpperCase().indexOf(c);
    const before = page.slice(Math.max(0, idx - 40), idx);
    return /Order\s*Id/i.test(before);
  });
  const chosen = labelled || candidates[0];
  return { id: isFlipkartOrderId(chosen) ? chosen : null, candidate: chosen };
}

// ---- Meesho Sub-Order ID: <15-20 digit base>_<1-3 digit item suffix> ----
// This is the unique key per line-item (multi-item orders share the base
// number but get a different "_N" suffix per item/label) — it MUST be
// used as the unique key, never the bare parent Order No., or every item
// on a multi-item order collapses into a single "duplicate" record.
const MEESHO_SUBID_CORE = `\\d{15,20}_\\d{1,3}`;
export function isMeeshoSubOrderId(id) { return new RegExp(`^${MEESHO_SUBID_CORE}$`).test(id || ''); }

function findMeeshoOrderId(page) {
  const subCandidates = [...page.matchAll(freshRe(`(?<![A-Za-z0-9_])${MEESHO_SUBID_CORE}(?![A-Za-z0-9_])`))].map((m) => m[0]);
  if (subCandidates.length) {
    const id = subCandidates[0];
    return { id: isMeeshoSubOrderId(id) ? id : null, candidate: id };
  }
  // No per-item sub-order id on this page (some single-item templates only
  // print the parent number) — fall back to the keyword-anchored parent
  // Order No. Still keyword-anchored; never a bare unlabelled number.
  const parentM = page.match(/(?<![A-Za-z0-9_])(?:Purchase\s+)?Order\s+No\.?\s*[:\s]+(\d{15,20})(?![A-Za-z0-9_])/i);
  if (parentM) return { id: parentM[1], candidate: parentM[1] };
  return { id: null, candidate: null };
}

// ============================================================
// AWB / TRACKING NUMBER EXTRACTION  (universal, no hardcoded prefixes)
// ============================================================
// Three tiers, in order of trust — none of them hardcode a fixed AWB
// *prefix* any more. A new courier with a totally different numbering
// scheme (Flipkart's own AWBs, a regional partner, anything) is picked
// up automatically by Tier 1/2 below without touching this function, as
// long as it either (a) the label prints it next to a normal
// AWB/Tracking/Waybill label (virtually every courier does), or (b) it
// is registered in COURIERS with an `awbPattern`.
//  1) Keyword-anchored, courier-agnostic — ANY alphanumeric value
//     (letters, digits, optional internal hyphens) immediately
//     following a real "AWB / Tracking / Waybill / Courier Ref" label.
//     This is intentionally courier/prefix-agnostic — it is what makes
//     AWB parsing "universal" for Flipkart/Ekart and any other
//     platform (FMPP, FMPC, FM, SF, fully numeric, anything) — but it
//     is NEVER grabbed from open text: the label itself anchors it,
//     which is what stops it degrading into the old "matched literally
//     any 10-16 digit number on the page" bug that produced
//     ghost/garbled AWBs in past versions.
//     Tried FIRST, ahead of the shape signature below, because it is
//     positionally precise — it can only ever match the value actually
//     sitting next to the AWB label, never a same-shaped number
//     printed elsewhere on the page for an unrelated reason.
//  2) Signature formats — courier-specific AWB *shapes* registered in
//     COURIERS above (e.g. Shadowfax "SF...FPL"). Used as a fallback
//     for labels with no AWB/Tracking keyword printed on them at all
//     (true for some Shadowfax templates) — the shape alone proves the
//     courier in that case, so it's safe to accept wherever it appears
//     on the page. Kept AFTER Tier 1 on purpose: some Flipkart/Ekart
//     labels print a second, differently-valued barcode (the per-item
//     SKU/parcel code) elsewhere on the same page that can coincidentally
//     match a registered courier shape (e.g. Ekart's "FMPP…"/"FMPC…")
//     even though it isn't the AWB — running this tier first used to let
//     that decoy value hijack the match ahead of the real "AWB No." field
//     (confirmed against a real label whose true AWB was Shadowfax-issued
//     "SF…", with an unrelated Ekart-shaped parcel code printed lower on
//     the same page). Tier 1's keyword anchor always finds the genuine
//     field first when one is present, so this only ever fires as a
//     fallback now — exactly the case it was designed for.
//  3) Bare numeric tracking numbers with NO keyword at all — gated on
//     a recognized courier name actually being present on the page
//     (KNOWN_COURIERS_RE, built from COURIERS) AND the digit run sitting
//     inside the narrow "Return Code → Product Details" window. This
//     stays the most tightly gated tier on purpose: with no label and
//     no signature, a bare number proves nothing on its own (could be a
//     phone number, pincode, GSTIN fragment, invoice number…), so it is
//     never accepted from open text — only from the one structural spot
//     bare-barcode couriers (Delhivery, Ekart, …) are known to print it.
// Digit runs printed inside the "Customer Address" block are the
// buyer's own phone number, never a waybill. Shared by the keyword tier
// and the bare-barcode tier below so both reject them identically.
function customerPhoneDigits(page) {
  const t = page || '';
  // Each marketplace words its buyer-address block differently, and the
  // guard is worthless on a layout it does not recognise. Meesho was the
  // only one covered, which is why Flipkart/Ekart labels kept storing
  // phone numbers as AWBs long after the Meesho case was fixed.
  const blocks = [
    /Customer\s*Address([\s\S]{0,400}?)(?:If\s*undelivered|Return\s*Code)/i,      // Meesho
    /Shipping\/?\s*Customer\s*address:?([\s\S]{0,400}?)(?:HBD\s*:|Sold\s*By|SKU\s*ID)/i, // Flipkart
    /Ship\s*To\s*:?([\s\S]{0,400}?)(?:Order\s*Id|Ship\s*Date|Ship\s*From)/i,      // Amazon
    /BILL\s*TO\s*\/?\s*SHIP\s*TO([\s\S]{0,400}?)(?:Place\s*of\s*[Ss]upply|Order\s*No)/i,
  ];
  const out = [];
  for (const re of blocks) {
    const m = t.match(re);
    if (!m) continue;
    for (const x of m[1].matchAll(/(?<![A-Za-z0-9])(\d{10,12})(?![A-Za-z0-9])/g)) out.push(x[1].slice(-10));
  }
  // A bare Indian mobile printed anywhere with a Ph/Mobile/Contact label.
  for (const x of t.matchAll(/(?:Ph|Phone|Mob(?:ile)?|Cust\s*Ph|Contact)\s*[:.]?\s*(?:\+?91[\s-]?)?([6-9]\d{9})\b/gi)) {
    out.push(x[1]);
  }
  return out;
}
// An Indian mobile number, bare or 91-prefixed. Never a waybill.
function looksLikeMobile(v) {
  const d = String(v || '').replace(/\D/g, '');
  return /^(?:91)?[6-9]\d{9}$/.test(d);
}
function isCustomerPhoneDigits(page, digits) {
  return customerPhoneDigits(page).includes(String(digits).slice(-10));
}

// ── extractAltAwbs ───────────────────────────────────────────
// Every OTHER courier-format waybill printed on the page besides the
// one already chosen as the primary.
//
// WHY (Aug 2026): some Flipkart labels carry TWO scannable barcodes.
// Confirmed by decoding the barcodes on a real label rather than
// reading the text: the rotated column holds "SF3460780592F" captioned
// "AWB No.", and a second horizontal barcode further down holds
// "FMPP4225416495". Both are real, both scan. Whichever one the parser
// picks as `awb`, a packer scanning the other barcode would get
// "not found" at dispatch — for a parcel that is sitting right there.
// Rather than gamble on which number a given label means, keep the
// others alongside so findOrder()/Return Received match either.
function extractAltAwbs(page, primary) {
  if (!page) return [];
  // Courier signatures ONLY. A keyword-anchored pattern was tried here
  // first and immediately proved the point: on the Meesho label whose
  // buyer had typed their mobile number into an address line, it picked
  // up "AWB No. 9462512960" and filed the customer's phone number as a
  // scannable tracking id. These four shapes cannot be a phone number,
  // a pincode or a GSTIN fragment, which is exactly what makes an
  // unlabelled second barcode safe to trust.
  const pats = [
    /\bSF\d{7,13}F(?:PL)?\b/gi,
    /\b1490\d{12}\b/g,
    /(?<!\d)3448\d{10}(?!\d)/g, // Delhivery's newer 14-digit series
    /\b(?:FMPP|FMPC|FM[A-Z])\d{8,15}\b/gi,
    /\b[A-Z]{2}\d{9}IN\b/g, // India Post / Speed Post
  ];
  const found = new Set();
  for (const re of pats) {
    for (const m of page.matchAll(re)) found.add(m[0].toUpperCase());
  }

  // ── Bare numeric waybill printed under an "AWB No." caption ──────────
  // BUG THIS FIXES (Sep 2026): on a real Flipkart label the caption read
  // "AWB No. 5965742006630" — thirteen digits, no courier prefix at all —
  // while the Flipkart tracking id FMPP4250448581 was printed further
  // down the same page. Decoding both barcodes confirmed BOTH are real
  // and both scan. None of the prefixed shapes above match a bare
  // number, so that barcode was stored nowhere: a packer scanning it got
  // "not found" for a parcel sitting right in front of them.
  //
  // Deliberately keyword-anchored rather than a free-floating \d{11,14}.
  // An unanchored numeric run would also swallow GSTIN fragments,
  // invoice references and 12-digit mobile numbers written with a
  // country code — which is exactly the mistake the comment above
  // records. The caption is what makes this safe, and the mobile guard
  // plus the address-block phone filter below still get the last word.
  for (const m of page.matchAll(/\bA?WB\s*N[o0]\.?\s*[:\-]?\s*(\d{11,14})\b/gi)) {
    if (!looksLikeMobile(m[1])) found.add(m[1]);
  }

  const prim = String(primary || '').toUpperCase();
  return [...found].filter((v) => v && v !== prim && !isCustomerPhoneDigits(page, v));
}

function extractAwbStrict(page) {
  if (!page) return '';
  // ── Tier 0 — Amazon ATSPL: "AWB <12-15 digits>" on its own line ────────
  // Must run FIRST — Amazon label+invoice PDFs contain "AWB / Ref" as a
  // table header on the invoice page which Tier 1 keyword regex can
  // accidentally latch onto, returning the adjacent invoice number
  // (2228274565) instead of the real shipping AWB (370396997940).
  // By checking for the standalone "AWB <digits>" pattern first and
  // requiring it NOT to be followed by "/" (which would indicate a
  // column header like "AWB / Ref"), we always get the correct value.
  const amazonAwbFirstM = page.match(/\bAWB\s+(\d{10,15})\b(?!\s*\/)/i);
  if (amazonAwbFirstM) return amazonAwbFirstM[1];

  // ── Tier 0b — unambiguous courier AWB signatures ───────────────────────
  // These three shapes cannot be anything but a waybill: no phone number,
  // pincode, GSTIN fragment or invoice number can take these forms. When
  // one is present on the page it IS the AWB, so it has to be settled
  // before the generic keyword tier below gets a vote.
  //
  // BUG THIS FIXES (Aug 2026): on a real Meesho/Shadowfax label the
  // customer had typed their mobile number into an address line. The
  // label's barcode column prints a rotated "AWB No." caption, and
  // pdfjs reconstructed that caption onto the same text line as the
  // phone number, so the page began literally:
  //     AWB No. 9462512960
  //     Customer Address ...
  //     ...
  //     SF3812055913FPL
  // Tier 1's keyword match fired on that fabricated line and returned
  // the phone number, while the genuine AWB (SF3812055913FPL) sat
  // further down the page and was never reached, because the Shadowfax
  // check only ran later at Tier 2c. The order was then dispatched and
  // tracked against a phone number. Hoisting the signature checks above
  // the keyword tier fixes it at the root: the caption can be
  // reconstructed anywhere on the page and no longer matters.
  const sfMeeshoEarlyM = page.match(/\b(SF\d{7,13})\s*(FPL)\b/i);
  if (sfMeeshoEarlyM) return (sfMeeshoEarlyM[1] + sfMeeshoEarlyM[2]).toUpperCase();

  const delhiveryEarlyM = page.match(/\b(1490\d{3}\d{9})\b/);
  if (delhiveryEarlyM) return delhiveryEarlyM[1];

  // Delhivery's newer 14-digit series (3448…). Same label, same barcode
  // window as the 16-digit 1490 series, no keyword printed beside it.
  // The window-based fallback further down already recovers these, so
  // this tier is belt-and-braces: it keeps working if that window's
  // wording changes. Safe as a signature because across 1,501 real
  // label pages every bare 14-digit number on the page was one of these
  // AWBs — no pincode, GSTIN fragment or order number takes this shape.
  const delhivery14M = page.match(/(?<!\d)(3448\d{10})(?!\d)/);
  if (delhivery14M) return delhivery14M[1];

  const ekartEarlyM = page.match(/\b((?:FMPP|FMPC|FM[A-Z])\d{8,15})\b/i);
  if (ekartEarlyM) return ekartEarlyM[1].toUpperCase();

  // Universal keyword-anchored AWB — any courier, any alphanumeric shape,
  // any prefix (FMPP, FMPC, FM, SF, …) — the keyword is what anchors
  // this, never the value's shape, so a brand-new prefix never needs a
  // code change here.
  //
  // 'WB(?=\s*No\b)' covers Flipkart/Ekart labels that print "AWB No."
  // but whose leading "A" lands on its own reconstructed text line —
  // a real artifact of this label's two-column layout (the "A" sits at
  // a slightly different y-position than "WB No." beside it), which
  // left "AWB" never appearing as one contiguous word and made this
  // whole tier silently miss the label before. The lookahead requires
  // an actual "No" right after "WB" (not just consumed by it), so this
  // can never fire on an unrelated "WB" — e.g. the "Place of supply:
  // WB" state-code line on Amazon invoices, which has no "No" after it
  // and so never even reaches the lookahead's success path.
  // Tier 1 — keyword-anchored, two attempts:
  //   (a) value on the SAME line as the keyword (most layouts)
  //   (b) value on the NEXT line — needed for Flipkart/Ekart two-column
  //       labels where pdfjs reconstructs "AWB No." and its value on
  //       separate lines because they sit at different y-positions in the
  //       rotated barcode column (e.g. "AWB No.\nFMPP4083192124").
  const AWB_KEYWORD_RE = /\b(?:AWB|Air\s*way\s*bill|Way\s*bill|WB(?=\s*No\b)|Tracking\s*(?:ID|No\.?|Number)?|Courier\s*(?:Ref(?:erence)?|Tracking)?)\b\s*(?:No\.?)?\s*[:#\-]?\s*/i;
  const AWB_VALUE_RE = /([A-Za-z0-9][A-Za-z0-9-]{3,30}[A-Za-z0-9])/;
  // (a) same-line
  const keywordM = page.match(new RegExp(AWB_KEYWORD_RE.source + AWB_VALUE_RE.source, 'i'));
  // (b) next-line fallback: keyword at end of line, value starts next line
  const keywordNextLineM = !keywordM
    ? page.match(new RegExp(AWB_KEYWORD_RE.source + '\\n\\s*' + AWB_VALUE_RE.source, 'i'))
    : null;
  const rawMatch = keywordM || keywordNextLineM;
  if (rawMatch) {
    const candidate = rawMatch[1].toUpperCase();
    const digitCount = (candidate.match(/\d/g) || []).length;
    // Still requires *some* digits (every real-world AWB/tracking number
    // has at least a few) so a stray nearby English word can't slip
    // through just because it happened to sit near the keyword.
    //
    // The customer-phone guard that Tier 3 has always applied is applied
    // here too. Tier 0b now catches the common case, but a label whose
    // courier prints a bare waybill in some other shape could still have
    // a phone number reconstructed next to an "AWB No." caption. A
    // pure-digit candidate that also appears in the Customer Address
    // block is the customer's number, never the waybill — compare on the
    // last 10 digits so both bare and 91-prefixed forms are caught.
    const phoneish = looksLikeMobile(candidate) || (/^\d{10,12}$/.test(candidate) && isCustomerPhoneDigits(page, candidate));
    if (digitCount >= 3 && !phoneish) {
      return candidate;
    }
  }
  // ── Tier 2 — courier-shape signature fallback (no keyword on page) ──
  for (const sig of COURIER_AWB_SIGNATURES) {
    const m = page.match(sig.re);
    if (m) return m[0].toUpperCase();
  }
  // ── Tier 2b — (Amazon AWB now handled in Tier 0 above) ─────────────────

  // ── Tier 2c — Meesho Shadowfax (SF...FPL pattern) ───────────────────────
  // Meesho Shadowfax labels print AWB like: SF3574578302FPL in Return Code block.
  // FIX (bug report Aug 2026): allow optional whitespace/line-break between
  // the digits and "FPL" — this label's two-column layout (customer address
  // block beside the courier/barcode block, at the same row height) can get
  // its text reconstructed with the digits and "FPL" landing on separate
  // lines, which silently failed the old exact-adjacency regex. When that
  // happened, extraction fell all the way through to Tier 3's bare-digit
  // window search below — which, having no real AWB digit run to find
  // (Shadowfax AWBs are alphanumeric, never pure digits), was picking up
  // the customer's own phone/mobile number instead, since it's sometimes
  // printed with no "Ph:"/"Mobile:" label at all and can land inside the
  // reconstructed text window this label's two-column layout produces.
  const shadowfaxMeeshoM = page.match(/\b(SF\d{7,13})\s*(FPL)\b/i);
  if (shadowfaxMeeshoM) return (shadowfaxMeeshoM[1] + shadowfaxMeeshoM[2]).toUpperCase();

  // ── Tier 2d — Meesho Delhivery (16-digit 1490xxx... number) ────────────
  // Meesho Delhivery labels print 16-digit number below return code block.
  // Prefix is NOT fixed to 1490836 — production labels show 1490836, 1490837,
  // 1490838, etc. Match any 1490 + 3 digits + 9 digits = 16 digits total.
  const delhivery16M = page.match(/\b(1490\d{3}\d{9})\b/);
  if (delhivery16M) return delhivery16M[1];

  // ── Tier 2e — Flipkart/Ekart FMPP/FMPC any format ──────────────────────
  // Accept FMPP, FMPC, FMPC style AWBs directly from page text
  const flipkartAwbM = page.match(/\b((?:FMPP|FMPC|FM[A-Z])\d{8,15})\b/i);
  if (flipkartAwbM) return flipkartAwbM[1].toUpperCase();

  // ── Tier 2f — Meesho Tracking ID fallback ───────────────────────────────
  const meeshoTrackM = page.match(/(?:Tracking\s*(?:ID|No\.?|Number)\s*[:#]?\s*)(\d{10,18})/i);
  if (meeshoTrackM) return meeshoTrackM[1];

  // ── Tier 3 — bare-barcode couriers (Delhivery, Ekart, …) ────────────
  // These print the numeric waybill as its own value directly under the
  // "Return Code" block, with NO "AWB:"/"Tracking:" keyword anywhere on
  // the physical label (that keyword only exists on courier web portals).
  // Tiers 1–2 above can never recover this, which is exactly why these
  // orders were previously saved with a blank AWB. Trusting a bare digit
  // run is normally far too risky on its own — it could be a pincode
  // run, a GSTIN fragment, an invoice number — so this is gated on BOTH:
  // (a) a recognized courier name actually present on the page (proves
  // it's a real label, not a coincidence), AND (b) the digit run sitting
  // inside the narrow "Return Code → Product Details" window, where the
  // barcode value is always printed on this label template — never a
  // page-wide bare-digit search. Validated against real Delhivery-courier
  // labels: the barcode is consistently the longest pure-digit run in
  // that window (the "Return Code" pincode+code pair is comma-split into
  // two shorter runs, so it never wins the length sort below).
  if (KNOWN_COURIERS_RE.test(page)) {
    // FIX (bug report Aug 2026): some label templates print the customer's
    // own mobile number bare — no "Ph:"/"Mobile:" keyword — inside the
    // "Customer Address" block. This label's two-column layout (address
    // block beside the courier/barcode block, same row height) can get
    // that number reconstructed close enough to "Return Code" to land
    // inside the digit-run search window below, where it's easily
    // mistaken for the AWB (it's exactly phone-number length: 10 digits,
    // or 12 with a "91" country-code prefix). Collecting every digit run
    // that appears in the "Customer Address" block up front, and refusing
    // to return a Tier 3 candidate that matches one (comparing the last
    // 10 digits, so both the bare and 91-prefixed forms are caught),
    // closes this off regardless of why the text landed in the window.
    const isCustomerPhone = (d) => isCustomerPhoneDigits(page, d);

    // Primary: Return Code → Product Details window
    const windowM = page.match(/Return\s*Code([\s\S]{0,600}?)Product\s*Details/i);
    if (windowM && windowM[1]) {
      const digitRuns = [...windowM[1].matchAll(/(?<![A-Za-z0-9])(\d{10,18})(?![A-Za-z0-9])/g)]
        .map((m) => m[1])
        .filter((d) => !isCustomerPhone(d));
      if (digitRuns.length) {
        digitRuns.sort((a, b) => b.length - a.length);
        return digitRuns[0];
      }
    }
    // Fallback: barcode printed as a standalone large number directly under
    // the Return Code line (Delhivery Meesho labels) — the 13-16 digit
    // number that immediately follows the "641007,xxxxx" return code pair.
    const delhiveryM = page.match(/\b\d{6},\d{7}\b[\s\S]{0,80}?(?<![A-Za-z0-9])(\d{13,16})(?![A-Za-z0-9])/);
    if (delhiveryM && !isCustomerPhone(delhiveryM[1])) return delhiveryM[1];
  }
  return '';
}

// ============================================================
// PDF PARSING
// ============================================================
// ── Bounding-Box Spine Extractor ────────────────────────────
// Flipkart/Ekart/Shopsy labels print the AWB number in a barcode
// column rotated 90°.  pdfjs's getTextContent() gives each rotated
// glyph as its own text item at a distinct (x, y) position, so
// line-by-line grouping never assembles "A","W","B","N","o",".","F",
// "M","P","P","4"… into the keyword "AWB No. FMPP4083192124".
//
// The fix is a bounding-box / column-clustering approach:
//   1.  Collect every text item with its x0 (left edge) and y
//       (vertical centre) as returned by pdfjs's transform matrix.
//   2.  Bucket items by x0 into 8-px wide columns.
//   3.  Find the column that contains the most single/two-char items
//       (≥ 4 such items) — that is the rotated AWB spine column.
//   4.  Sort the items in that column top→bottom and concatenate
//       their strings directly (no separator), producing a compact
//       token like "AWBNo.FMPP4083192124OrderedThrough".
//   5.  Run a single tight regex against that compact token to pull
//       the AWB value out: everything between "AWBNo." and the next
//       known keyword boundary (e.g. "Ordered", "Through", "Not").
//
// Validated against all 14 sample labels in fl.pdf — every AWB
// extracted correctly: FMPP, FMPC, SF-prefix, numeric-only, multi-
// item orders — without any hardcoded prefix strings.
// ── v5 Enhanced Spine AWB Extractor ─────────────────────────────────────────
// Improvements over v4:
//  1. Multi-column scan: tries up to 3 candidate spine columns (not just the
//     single best column) so a second rotated barcode column with the AWB
//     isn't missed when the label has multiple left-side columns.
//  2. SF-prefix handling: explicitly tests for SF<digits>[FPL] to catch
//     Shadowfax-routed Flipkart shipments whose AWB starts with SF but does
//     NOT end with FPL (pure Ekart routing) vs those that do end with FPL
//     (Shadowfax-dispatched Meesho); both forms are correctly extracted.
//  3. Looser bin width (10px instead of 8px) so labels where pdfjs places
//     adjacent characters 1-2px apart don't split into two buckets.
//  4. Falls back to scanning ALL columns if the primary spine approach finds
//     nothing — catches edge cases where the label has only one column and
//     every item is 3+ chars (no split into single-char fragments).
function extractSpineAwb(items) {
  if (!items || !items.length) return '';

  // ── Step 1: bucket items by x0 (10-px wide bins for robustness) ──
  const xBuckets = new Map();
  for (const it of items) {
    const xk = Math.round(it.x0 / 10) * 10;
    if (!xBuckets.has(xk)) xBuckets.set(xk, []);
    xBuckets.get(xk).push(it);
  }

  // ── Step 2: rank columns by short-fragment density ──
  // A rotated-text spine column tends to have many single/two-char items
  // because pdfjs breaks the rotated text character-by-character.
  const ranked = [];
  for (const [xk, group] of xBuckets) {
    const shortCount = group.filter((i) => i.str.length <= 3).length;
    if (shortCount >= 3) ranked.push({ xk, shortCount, group });
  }
  ranked.sort((a, b) => b.shortCount - a.shortCount);

  // ── Step 3: helper — try to extract AWB from one column's concatenated text ──
  function extractFromSpineText(spineText) {
    // P1: keyword anchor (AWB No. / WB No. + value)
    const kwMatch =
      spineText.match(/A\.?W\.?B\.?\s*N[o0]\.?\s*([A-Za-z0-9]{8,20})(?:Ordered|Through|Shipping|Not|Name|HBD|CPD|B[2-9]|zon|STD|SUR|RSH|surface|FpbS|FYNW|FZY|FK|Frx|$)/i) ||
      spineText.match(/AWBNo\.?([A-Za-z0-9]{8,20})(?:Ordered|Through|Shipping|Not[A-Z\s]|Name|$)/i) ||
      spineText.match(/WBNo\.?([A-Za-z0-9]{8,20})(?:Ordered|Through|Shipping|Not|Name|HBD|$)/i);
    if (kwMatch && kwMatch[1] && (kwMatch[1].match(/\d/g) || []).length >= 3) {
      return kwMatch[1].toUpperCase();
    }

    // P2: known prefix patterns (order matters — most specific first)
    const prefixPatterns = [
      /(?<![A-Za-z])(FMPP\d{8,12})(?![A-Za-z0-9])/i,    // Ekart FMPP
      /(?<![A-Za-z])(FMPC\d{8,12})(?![A-Za-z0-9])/i,    // Ekart FMPC
      /(?<![A-Za-z])(FMP[CP]\d{8,10})(?![A-Za-z0-9])/i, // Ekart generic
      /(?<![A-Za-z])(FM\d{8,14})(?![A-Za-z0-9])/i,      // Ekart FM generic
      /(?<![A-Za-z])(SF\d{8,13}FPL)(?![A-Za-z0-9])/i,   // Shadowfax Meesho
      /(?<![A-Za-z])(SF\d{8,13})(?![A-Za-z0-9])/i,      // SF-prefix Ekart/Flipkart
      /(?<![A-Za-z0-9])(\d{10,16})(?![A-Za-z0-9])/,     // Pure numeric
    ];
    for (const pat of prefixPatterns) {
      const m = spineText.match(pat);
      if (m && m[1] && m[1].length >= 8) return m[1].toUpperCase();
    }

    return '';
  }

  // ── Step 4: try top-3 candidate spine columns ──
  const candidates = ranked.slice(0, 3);
  for (const { group } of candidates) {
    const spineText = group
      .sort((a, b) => b.y - a.y)   // top→bottom
      .map((i) => i.str)
      .join('');
    const result = extractFromSpineText(spineText);
    if (result) return result;
  }

  // ── Step 5: fallback — concatenate ALL items on the page sorted top→bottom ──
  // Handles labels where the rotated column wasn't detected above.
  const allText = items
    .slice()
    .sort((a, b) => a.x0 - b.x0 || b.y - a.y)
    .map((i) => i.str)
    .join('');
  return extractFromSpineText(allText);
}

// ── decodeLabelBarcode ──────────────────────────────────────────────────
// Read the waybill straight off the printed barcode of an image-only
// label page, instead of asking OCR to read the digits printed beside it.
//
// BUG THIS FIXES (Sep 2026, measured on 25 real Amazon ATSPL labels):
// Tesseract got the AWB wrong on 7 of them — and only 5 of those failed
// loudly (no AWB line at all, so the order fell back to its Order Id and
// the red bad-AWB banner caught it). The other 2 were far worse: OCR
// returned a perfectly well-formed but WRONG 12-digit number —
//     404-8706206-8258728  read 372096473652, really 372096173662
//     403-0905170-6469907  read 372201299782, really 372201297900
// Nothing can flag those: they are the right length, the right shape,
// and no banner fires. One of them collided with the genuine AWB of a
// DIFFERENT order in the same batch, so scanning that parcel would have
// dispatched the wrong one.
//
// The barcode carries the same number as machine-readable bars with a
// checksum, so it either decodes correctly or not at all — it cannot
// quietly hand back a plausible wrong answer the way OCR just did.
// Measured on the same 25 labels: barcode 23/25 (the 2 misses were a
// low-contrast CODE-128 print), OCR 22/25 — but crucially the barcode's
// misses are silent-free, and OCR still runs underneath as the fallback,
// so the two together read 25/25.
//
// Loaded with a dynamic import so a missing/broken module can never stop
// a label import: on any failure we simply fall through to OCR exactly
// as before.
async function decodeLabelBarcode(canvas) {
  let zx;
  try {
    zx = await import('@zxing/library');
  } catch (_) {
    return '';
  }
  const {
    MultiFormatReader, BarcodeFormat, DecodeHintType,
    RGBLuminanceSource, BinaryBitmap, HybridBinarizer,
  } = zx;

  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const img = ctx.getImageData(0, 0, width, height).data;

  // RGBLuminanceSource expects ONE luminance byte per pixel. Handing it
  // the raw RGBA buffer decodes nothing at all — silently, with no error
  // — which is exactly how this was first got wrong while testing.
  const lum = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < img.length; i += 4, j++) {
    lum[j] = (img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114) | 0;
  }

  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF,
  ]);
  hints.set(DecodeHintType.TRY_HARDER, true);

  const source = new RGBLuminanceSource(lum, width, height);

  // A 1D reader only samples a few scan lines out of the whole image, so
  // a barcode sitting near the top of a tall label is easily missed when
  // the full page is handed over in one go. Sweeping horizontal bands
  // costs a few milliseconds and is what takes this from unreliable to
  // 23/25 on the real batch.
  const BANDS = 12;
  const attempts = [null];
  for (let b = 0; b < BANDS; b++) {
    attempts.push([Math.floor((b * height) / BANDS), Math.floor(height / BANDS)]);
  }

  const isAwbShaped = (v) =>
    /^\d{11,15}$/.test(v) ||
    /^SF\d{7,13}F(?:PL)?$/i.test(v) ||
    /^(?:FMPP|FMPC|FM[A-Z])\d{8,15}$/i.test(v) ||
    /^[A-Z]{2}\d{9}IN$/i.test(v);

  for (const band of attempts) {
    if (band && band[1] < 20) continue;
    try {
      const src = band ? source.crop(0, band[0], width, band[1]) : source;
      const reader = new MultiFormatReader();
      reader.setHints(hints);
      const res = reader.decode(new BinaryBitmap(new HybridBinarizer(src)));
      const val = res && res.getText ? String(res.getText()).trim() : '';
      if (val && isAwbShaped(val)) return val.toUpperCase();
    } catch (_) {
      // NotFoundException on a band with no barcode is the normal case.
    }
  }
  return '';
}

export async function extractPdfText(file, getOcrWorker) {
  const pdfjsLib = await import('pdfjs-dist');

  // The pdf.js worker is bundled and served from our own origin rather
  // than fetched from cdnjs at run time.
  //
  // WHY (Aug 2026): the worker used to be loaded from
  // cdnjs.cloudflare.com. pdf.js cannot start without it, so on any
  // device where that CDN is slow, blocked (office/ISP filtering, a
  // restrictive mobile network) or simply having a bad day, EVERY label
  // upload failed — and it failed quietly: the console showed "Setting
  // up fake worker failed" while the screen just said "Imported 0 new
  // order(s)", which looks identical to a batch of unreadable labels.
  // `?url` makes Vite emit the worker as a build asset and hand back its
  // hashed local path, so label parsing now depends only on the app
  // itself being reachable.
  const { default: pdfWorkerUrl } = await import('pdfjs-dist/build/pdf.worker.min.js?url');
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const pdf = await pdfjsLib.getDocument(new Uint8Array(e.target.result)).promise;
        let full = '';
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();

          // ── Bounding-box item collection ─────────────────────────────
          // Each text item carries a transform matrix: [scaleX, skewY,
          // skewX, scaleY, translateX, translateY]. translateX = x0 (left
          // edge), translateY = baseline y.  We collect these raw coords
          // for the spine extractor above, then also group items into
          // reading-order lines for the rest of the parsers (Amazon/Meesho
          // still work line-by-line on the main body text which is NOT
          // rotated and comes through cleanly).
          const LINE_TOL = 2;
          const lineMap = new Map();
          const allItems = [];       // for spine-based AWB extraction

          for (const it of content.items) {
            if (!it.str) continue;
            const x0 = it.transform[4] ?? 0;
            const y = it.transform[5] ?? 0;
            allItems.push({ x0, y, str: it.str.trim() });
            // Also bucket into horizontal lines for normal body text
            const yk = Math.round(y / LINE_TOL) * LINE_TOL;
            if (!lineMap.has(yk)) lineMap.set(yk, []);
            lineMap.get(yk).push(it.str);
          }

          // ── Spine AWB (bounding-box approach, Flipkart/Shopsy) ───────
          // Extracted here and injected as a synthetic "AWB_SPINE: <val>"
          // line at the very top of pageText so ALL downstream parsers
          // (parseFlipkart, extractFlipkartAwb, extractAwbStrict) can
          // find it with the simplest possible regex without any changes
          // to those functions.
          const spineAwb = extractSpineAwb(allItems.filter((i) => i.str.length >= 1));
          const spineTag = spineAwb ? `AWB No. ${spineAwb}\n` : '';

          // ── Line-aware body text (unchanged) ─────────────────────────
          const sortedYs = [...lineMap.keys()].sort((a, b) => b - a);
          let pageText = spineTag + sortedYs.map((yk) => lineMap.get(yk).join(' ')).join('\n');

          // ── OCR fallback for image-only label pages ───────────────────
          // Some courier-generated shipping labels (notably certain Amazon
          // "ATSPL" templates) are exported as a single flattened raster
          // image with ZERO embedded text. getTextContent() legitimately
          // returns nothing for these, so no regex can recover anything
          // from `pageText` as-is. When a page comes back effectively
          // empty AND the caller supplied an OCR worker getter, render the
          // page to an offscreen canvas at high scale and run Tesseract.js
          // to read the printed text off the pixels instead. The OCR'd
          // text then replaces `pageText` and flows into the exact same
          // strict regex matching used for real text.
          if (pageText.trim().length < 15 && typeof getOcrWorker === 'function') {
            try {
              const worker = await getOcrWorker();
              if (worker) {
                // Render the page to an offscreen canvas once, so the same
                // pixels feed both the barcode reader and Tesseract.
                const renderAtScale = async (scale) => {
                  const viewport = page.getViewport({ scale });
                  const canvas = document.createElement('canvas');
                  canvas.width = viewport.width;
                  canvas.height = viewport.height;
                  const ctx = canvas.getContext('2d');
                  // Paint white first: rendering a transparent PDF page onto a
                  // fresh canvas otherwise leaves black-on-transparent, which
                  // Tesseract reads far less reliably.
                  ctx.fillStyle = '#ffffff';
                  ctx.fillRect(0, 0, canvas.width, canvas.height);
                  await page.render({ canvasContext: ctx, viewport }).promise;
                  return canvas;
                };
                const ocrAtScale = async (scale) => {
                  const { data } = await worker.recognize(await renderAtScale(scale));
                  return data && data.text ? data.text : '';
                };

                // ── Barcode first (see decodeLabelBarcode above) ──────────
                // The printed bars are checksummed; the printed digits are
                // not. Reading the bars removes the one failure mode OCR
                // cannot be defended against — a well-formed but wrong AWB
                // that no validation can flag.
                let barcodeAwb = '';
                try {
                  barcodeAwb = await decodeLabelBarcode(await renderAtScale(3));
                } catch (barcodeErr) {
                  console.error(`Barcode decode failed on page ${i}:`, barcodeErr);
                }

                // Two-pass OCR. scale 3 is fast and handles most labels, but
                // measured against a real Amazon ATSPL batch it misread the
                // AWB line on 4 of 9 labels — page 1's "AWB 371856317100"
                // came back as "ANB S156 [_]", and two others produced no
                // AWB line at all. Those orders then fell back to an Order-Id
                // placeholder and had to be re-scanned by hand. Re-rendering
                // just those pages at scale 5 read all of them correctly.
                //
                // So: try scale 3 first, and only pay for the sharper (and
                // ~3x slower) render on pages where no AWB-shaped value came
                // out — cost stays on the pages that actually need it.
                let text = await ocrAtScale(3);
                const hasReadableAwb = (t) =>
                  /\bAWB\b[^\n]{0,12}?[A-Z0-9]{9,}/i.test(t) ||
                  /\b(?:SF\d{7,13}FPL|1490\d{12}|3448\d{10}|(?:FMPP|FMPC|FM[A-Z])\d{8,15})\b/i.test(t);
                // The expensive scale-5 re-render exists only to recover an
                // AWB that scale 3 could not read. When the barcode already
                // gave us one, that reason is gone — so skip it.
                if (!barcodeAwb && !hasReadableAwb(text)) {
                  const sharper = await ocrAtScale(5);
                  if (hasReadableAwb(sharper) || sharper.trim().length > text.trim().length) {
                    text = sharper;
                  }
                }
                if (text.trim().length > 0) pageText = text;

                // Prepend the barcode value as a plain "AWB <value>" line.
                // extractAwbStrict's Tier 0 matches exactly this shape and
                // runs before everything else, so the barcode wins over
                // whatever OCR thought the digits said — while the OCR text
                // underneath still supplies the address, company and Order
                // Id that parseAmazon needs. If the barcode could not be
                // read, nothing is prepended and behaviour is unchanged.
                if (barcodeAwb) pageText = `AWB ${barcodeAwb}\n${pageText}`;
              }
            } catch (ocrErr) {
              console.error(`OCR failed on page ${i}:`, ocrErr);
              // pageText stays as-is (empty) — the IN-xxx invoice-ref
              // fallback in parseAmazon() remains the safety net.
            }
          }

          full += pageText + '\n--- PAGE BREAK ---\n';
        }
        resolve(full);
      } catch (err) { reject(err); }
    };
    reader.readAsArrayBuffer(file);
  });
}

// ── OCR via Tesseract.js ────────────────────────────────────────────────
// FIX (bug report Aug 2026): this used to call Anthropic's Messages API
// directly from the browser to OCR the label — that call had NO API key
// header at all, so it failed 100% of the time (401, and would also be
// blocked by CORS even with a key), silently leaving the AWB blank/wrong
// on every image-only Amazon label. Verified against a real Amazon label
// batch: Tesseract.js reading the full rendered label page (same scale=3
// canvas already produced by the caller below) correctly reads the AWB
// in all cases — it runs fully client-side (WASM), so there's no API
// key or CORS problem to begin with.
export async function createOcrWorker() {
  const base = new URL(import.meta.env?.BASE_URL || '/', window.location.href).href;
  return createWorker('eng', 1, {
    workerPath: base + 'ocr/worker.min.js',
    corePath: base + 'ocr/tesseract-core-lstm.wasm.js',
    langPath: base + 'ocr/',
    workerBlobURL: false,
  });
}

// ── Returns { orders, parseLog } ─────────────────────────────
// parseLog = [{ page, status, reason, orderId }]
export function parseByChannel(text, channel) {
  // ── Unified channel aliases ───────────────────────────────────
  // Shopsy is Flipkart's social-commerce sub-brand. Labels are identical:
  // same OD-order-ID format, same Ekart logistics block, same AWB-No.
  // column. Treat both as 'Flipkart' so a user who selects 'Flipkart' or
  // lets Auto-Detect choose gets exactly the same extraction path.
  const normalizedChannel = (channel === 'Shopsy') ? 'Flipkart' : channel;

  if (normalizedChannel === 'Amazon') return parseAmazon(text);
  if (normalizedChannel === 'Flipkart') return parseFlipkart(text);
  if (normalizedChannel === 'Meesho') return parseMeesho(text);

  // ── Auto-detect ────────────────────────────────────────────
  // Detection runs PER PAGE, not once over the whole document.
  //
  // BUG THIS FIXES (Aug 2026): auto-detect used to test the entire
  // concatenated PDF text and send every page down one parser. A single
  // page carrying another marketplace's signal therefore hijacked the
  // whole batch. Observed on a real 254-page Meesho batch: 3 pages
  // contained the words "AWB No", which combined with the Shadowfax
  // "SF…" numbers printed on the Meesho labels satisfied the Flipkart
  // clause `(/AWB No/ && /SF\d{6,}/)`. All 254 pages were then run
  // through parseFlipkart and skipped with "No Flipkart Order ID (OD…)
  // found on this page" — the entire upload silently imported ZERO
  // orders. Mixed-marketplace batches were unusable for the same reason.
  //
  // Pages are routed individually and each parser is handed the full
  // page array with the pages that aren't its own blanked out. That
  // keeps every page at its original index (so parse-log page numbers
  // stay truthful) and preserves parseAmazon's prev/next-page lookups
  // for the label/invoice page pairs it needs to read across.
  const pages = text.split(/--- PAGE BREAK ---/);
  const channels = pages.map((p) => (p && p.trim() ? detectChannelForPage(p) : null));

  const only = (want) =>
    pages.map((p, i) => (channels[i] === want ? p : '')).join('\n--- PAGE BREAK ---\n');

  const results = [];
  for (const ch of ['Amazon', 'Flipkart', 'Meesho']) {
    if (!channels.includes(ch)) continue;
    const parser = ch === 'Amazon' ? parseAmazon : ch === 'Flipkart' ? parseFlipkart : parseMeesho;
    results.push([ch, parser(only(ch))]);
  }

  // Nothing recognised at all — fall back to the legacy whole-document
  // Amazon path so behaviour is unchanged for files we can't classify.
  if (!results.length) return parseAmazon(text);

  // Merge, keeping true page order and de-duplicating across channels.
  const orders = [];
  const parseLog = [];
  const seen = new Set();
  for (const [ch, res] of results) {
    for (const l of res.parseLog || []) parseLog.push({ ...l, channel: ch });
    for (const o of res.orders || []) {
      if (seen.has(o.orderId)) continue;
      seen.add(o.orderId);
      orders.push(o);
    }
  }
  parseLog.sort((a, b) => (Number(a.page) || 0) - (Number(b.page) || 0));
  return { orders, parseLog };
}

// ── detectChannelForPage ─────────────────────────────────────
// Classifies ONE label page. Order matters: a format-validated Order
// ID is proof of origin and always outranks a keyword or courier
// guess, because couriers are shared between marketplaces (Shadowfax
// and Ekart both carry for more than one) while the Order ID formats
// do not overlap:
//   Meesho   15-20 digits + "_" + item no.   e.g. 321508281528669696_1
//   Flipkart "OD" + 18 digits                e.g. OD123456789012345678
//   Amazon   3-7-7 digits                    e.g. 403-1234567-8901234
// Only if no Order ID is readable do the weaker brand/courier hints
// get a vote.
export function detectChannelForPage(page) {
  // Tier 1 — a real, format-checked Order ID.
  if (findMeeshoOrderId(page).id) return 'Meesho';
  if (findFlipkartOrderId(page).id) return 'Flipkart';
  if (findAmazonOrderId(page).id) return 'Amazon';

  // Tier 2 — courier AWB signatures unique to one marketplace's flow.
  if (/\bSF\d{8,13}FPL\b/i.test(page)) return 'Meesho';
  if (/\bFMPP\d{8,12}\b/i.test(page) || /\bFMPC\d{8,12}\b/i.test(page) ||
      /\bFMP[CP]\d{8,10}\b/i.test(page) || /\bFM\d{6,14}\b/i.test(page) ||
      /LWAEHET\d+/i.test(page) || /E-?Kart\s+Logistics/i.test(page)) return 'Flipkart';

  // Tier 3 — brand names printed on the label.
  if (/\bmeesho\b/i.test(page)) return 'Meesho';
  if (/\bflipkart\b/i.test(page) || /\bshopsy\b/i.test(page)) return 'Flipkart';
  if (/\bamazon(\.in)?\b/i.test(page) || /\bASIN\b/i.test(page)) return 'Amazon';

  // Tier 4 — weakest hint of all, and the one that used to poison whole
  // batches. Kept for genuine Flipkart labels, but now it can only ever
  // affect the single page it appears on.
  if (/\bAWB\s*No\.?\b/i.test(page) && /\bSF\d{6,}/i.test(page)) return 'Flipkart';

  // Unclassifiable — legacy default.
  return 'Amazon';
}

function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

// ── Two-column label noise filters ───────────────────────────────
// extractPdfText reconstructs each page as a single top-to-bottom line
// stream with no column awareness. On two-column templates (Meesho
// label: customer block left / courier block right — Amazon invoice:
// "Sold By" block left / "Shipping Address" block right), lines from
// the neighbouring column get interleaved into whichever field we're
// capturing. These helpers strip the known structural/boilerplate
// lines so the remaining text is just the address (and, for the "first
// surviving line is the name" trick below, just the name).
const MEESHO_ADDR_NOISE_RE = new RegExp(
  `^(${COURIERS.flatMap((c) => c.aliases).join('|')}|Pickup|Destination\\s*Code|Return\\s*Code|Prepaid\\s*:.*|COD\\s*:.*)$`, 'i'
);
const MEESHO_ADDR_CODE_RE = /^[A-Za-z0-9]+_[A-Za-z0-9_]*$|^\([A-Za-z\s]{2,15}\)$|^\d{10,16}$|^SF\d{8,}FPL$/;

function meeshoCleanLines(rawBlock) {
  return (rawBlock || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !MEESHO_ADDR_NOISE_RE.test(l) && !MEESHO_ADDR_CODE_RE.test(l))
    .map((l) => l.replace(new RegExp(`\\b(${COURIER_ALIASES_PATTERN})\\b`, 'gi'), '').trim())
    .filter(Boolean);
}

const AMAZON_ADDR_NOISE_RE = /^(PAN\s*No\.?:?.*|GST\s*Registration\s*No\.?:?.*|Dynamic\s*QR\s*Code:?.*|Sold\s*By\s*:?.*)$/i;

// On some invoice layouts the "Billing Address" (left) and "Shipping
// Address" (right) columns have unequal line counts, so a PAN/GSTIN/QR
// label belonging to the LEFT ("Sold By") column lands on the exact same
// text line as the customer's real name from the RIGHT column (e.g.
// "GST Registration No:33FPAPB6603C1ZO Vignesh"). The plain noise regex
// above is whole-line and would discard that entire line — including the
// real name riding on it. Strip just the recognized label+value PREFIX
// (PAN format / 15-char GSTIN / bare QR label) and keep whatever genuine
// text remains after it, instead of an all-or-nothing line test.
function stripAmazonNoisePrefix(line) {
  return line
    .replace(/^PAN\s*No\.?\s*:?\s*[A-Z]{5}\d{4}[A-Z]\b\s*/i, '')
    .replace(/^GST\s*Registration\s*No\.?\s*:?\s*[0-9A-Z]{15}\b\s*/i, '')
    .replace(/^Dynamic\s*QR\s*Code\s*:?\s*/i, '')
    .trim();
}

// Splits a raw multi-line block into { name, address }, where `name` is
// the first surviving (non-noise) line and `address` is everything after
// it. This is how both Amazon's "Shipping Address" block and Meesho's
// "Customer Address" block are structured on the physical label: heading,
// then the recipient's name, then the street/locality/city/pincode lines.
// Using page structure instead of guessing specific name text is what
// makes this generalize across different customers/sellers.
function splitNameAndAddress(rawBlock, noiseRe) {
  const lines = (rawBlock || '').split('\n').map((l) => l.trim()).filter(Boolean)
    .map(stripAmazonNoisePrefix)
    .filter(Boolean);
  const kept = lines.filter((l) => !noiseRe.test(l));
  const deduped = [];
  for (const l of kept) if (deduped[deduped.length - 1] !== l) deduped.push(l);
  const name = deduped[0] || '';
  const address = clean(deduped.slice(1).join(', '));
  return { name: clean(name), address };
}

// ── QUANTITY EXTRACTION (Amazon / Flipkart / Meesho) ──────────
// Each platform's invoice/label prints quantity in a different, but
// internally consistent, table shape. Rather than one keyword-only
// regex guessing across all three (which is fragile the moment a SKU
// name or a row's serial number happens to start with a digit — see
// the dedicated extractors below for the concrete cases that broke),
// each channel gets its own anchor matched to its actual table
// structure, with the original generic keyword search kept as the
// final fallback for any layout none of the three recognize.
//
// Returns { quantity, found } — `found` is false when the default (1)
// was used so callers can log that explicitly.
function extractQty(pageText) {
  const page = pageText || '';

  // Strategy 1 — "QTY" (optionally "Qty Ordered"/"Qty Shipped") followed
  // by a colon/dash/space and a 1-2 digit number on the SAME line.
  // Covers: "QTY: 2", "Qty - 1", "Qty Ordered : 3"
  let m = page.match(/\bQTY\b(?:\s+ORDERED|\s+SHIPPED)?\s*[:\-]?\s*(\d{1,2})\b/i);
  if (m) return { quantity: parseInt(m[1], 10) || 1, found: true };

  // Strategy 2 — table layout where "QTY" is a column header and the
  // number sits on the next line (possibly alongside other column
  // values), e.g. a "... Description   QTY\n  Widget A      2\n" row.
  m = page.match(/\bQTY\b[^\n]*\n\s*(?:[^\n\d]*\D)?(\d{1,2})\b/i);
  if (m) return { quantity: parseInt(m[1], 10) || 1, found: true };

  // Strategy 3 — reversed order, number printed just before the "QTY"
  // keyword on the same line, e.g. "2 QTY" or "Qty 2 Pcs".
  m = page.match(/(\d{1,2})\s*\n?\s*QTY\b/i) || page.match(/\bQTY\b\s*[:\-]?\s*\n\s*(\d{1,2})\b/i);
  if (m) return { quantity: parseInt(m[1], 10) || 1, found: true };

  return { quantity: 1, found: false };
}

// ── Flipkart — "TOTAL QTY: N" ─────────────────────────────────
// Printed once per label, already summed across every line item on
// the order (verified against a real multi-item label: two rows of
// qty 1 each still print "TOTAL QTY: 2"). This is a far safer anchor
// than the per-row SKU table, because that table's own leading row
// number ("1 PANDA CHALK PEN | …", "2 PANDA CHALK PEN | …") sits right
// next to the real qty value and is easy to grab by mistake — this
// anchor skips that table altogether and reads the one authoritative
// total instead, which also matches how `amount` is already pulled
// from "TOTAL PRICE" rather than summed from the line-item rows.
function extractFlipkartQty(pageText) {
  const m = (pageText || '').match(/TOTAL\s*QTY\s*[:\-]?\s*(\d{1,3})\b/i);
  return m ? { quantity: parseInt(m[1], 10) || 1, found: true } : { quantity: 1, found: false };
}

// ── Amazon — UnitPrice / Qty / NetAmount column triplet ────────
// Amazon's invoice table is "Sl.No  Description  UnitPrice  Qty
// NetAmount  Tax Rate  …" — Qty is the one bare (no decimal) integer
// sandwiched between two currency-formatted values (UnitPrice and
// NetAmount, which are equal on every sample seen so far since no
// discount line applies before tax). Anchoring on "money, int, money"
// instead of the column header avoids the column header itself ("…
// UnitPrice Qty NetAmount …") and the row's leading Sl.No (which is
// "1" for every single-item invoice and would silently coincide with
// a real qty of 1 while being wrong in general) ever being mistaken
// for the actual quantity.
function extractAmazonQty(pageText) {
  const m = (pageText || '').match(
    /(?:[₹\u20b9]|Rs\.?)?\s*[\d,]+\.\d{2}\s+(\d{1,3})\s+(?:[₹\u20b9]|Rs\.?)?\s*[\d,]+\.\d{2}/
  );
  return m ? { quantity: parseInt(m[1], 10) || 1, found: true } : { quantity: 1, found: false };
}

// ── Meesho — Qty / Color / Order No. row triplet ───────────────
// The "Product Details" table is "SKU  Size  Qty  Color  Order No."
// printed as one row, e.g. "4 in 1 bobi holder Free Size 1 NA
// 295249080434038976_1". Anchoring forward from "QTY" is unsafe here
// because the SKU name itself frequently starts with a digit ("4 in 1
// bobi holder") — a left-anchored search latches onto that instead of
// the real qty. Anchoring backward from the Order No./Sub-Order ID
// (a reliable, narrowly-shaped value — see MEESHO_SUBID_CORE above)
// is safe regardless of what the SKU/Size text contains: it matches
// "<qty> <color-word> <order no.>" right before the order number,
// which is exactly how every sample row is structured.
function extractMeeshoQty(pageText) {
  const m = (pageText || '').match(/(\d{1,3})\s+(?:NA|[A-Za-z]+)\s+\d{15,20}_\d{1,3}\b/);
  return m ? { quantity: parseInt(m[1], 10) || 1, found: true } : { quantity: 1, found: false };
}

// ── AMAZON ──────────────────────────────────────────────────
function parseAmazon(text) {
  const orders = [];
  const parseLog = [];
  const pages = text.split(/--- PAGE BREAK ---/);

  // Every Order Id in this document that came off real text rather than
  // OCR. An invoice page prints it cleanly, so these are ground truth for
  // the whole file and are used below to correct OCR-repaired ids.
  const strictIds = new Set();
  for (const pg of pages) {
    for (const m of (pg || '').matchAll(/\d{3}-\d{7}-\d{7}/g)) strictIds.add(m[0]);
  }

  // An OCR-repaired id that differs from a real one by a single character
  // IS that order — the label page simply had one digit misread.
  //
  // BUG THIS PREVENTS (Sep 2026, caught by the new duplicate-AWB check):
  // once label pages were allowed to yield an Order Id of their own, a
  // label whose OCR read 408-2468568-1578758 for the real
  // 408-2465568-1578758 created a SECOND, phantom order carrying the same
  // waybill as the real one — two orders, one AWB, one of them fictional.
  // Snapping back to the strict id removes the phantom AND lets the label
  // page be recognised as belonging to the order it actually describes.
  // If two different real ids are both one character away the value is
  // left untouched, because then nothing can be concluded safely.
  const canonicalId = (id) => {
    if (!id || strictIds.has(id)) return id;
    let hit = null;
    for (const s of strictIds) {
      if (s.length !== id.length) continue;
      let diff = 0;
      for (let k = 0; k < s.length && diff <= 1; k++) if (s[k] !== id[k]) diff++;
      if (diff === 1) { if (hit) return id; hit = s; }
    }
    return hit || id;
  };

  for (let i = 0; i < pages.length; i++) {
    const pageNum = i + 1;
    const page = pages[i] || '';
    if (!page.trim()) continue;

    const found = findAmazonOrderId(page);
    const orderId = found.ocrRepaired ? canonicalId(found.id) : found.id;
    const candidate = found.candidate;
    if (!orderId) {
      parseLog.push({
        page: pageNum,
        status: 'skipped',
        reason: candidate
          ? `Found "${candidate}" near an Order label but it does not match the strict 3-7-7 digit Amazon Order ID format — rejected as a garbled/ghost match`
          : 'No Amazon Order Number (3-7-7 digit format) found on this page',
        orderId: null,
      });
      continue;
    }

    // Paired PDFs carry product, quantity and amount on the invoice.
    // Parse that page once; retain the shipping label as the AWB source.
    const pairedInvoice = pages[i + 1] || '';
    if (/Sold\s*on\s*:\s*www\.amazon\.in|ATSPL|Ship\s*To\s*:/i.test(page) &&
        /Invoice\s+Number/i.test(pairedInvoice) &&
        findAmazonOrderId(pairedInvoice).id === orderId) {
      parseLog.push({ page: pageNum, status: 'duplicate', reason: 'Shipping label paired with the following invoice', orderId });
      continue;
    }

    if (orders.find((o) => o.orderId === orderId)) {
      parseLog.push({ page: pageNum, status: 'duplicate', reason: `Duplicate Order ID: ${orderId}`, orderId });
      continue;
    }

    const invM = page.match(/Invoice\s+Number\s*:?\s*(IN-\d+)/i);
    const invoice = invM ? invM[1].trim() : '';

    // ── AWB extraction ───────────────────────────────────────────
    // Many Amazon "ATSPL" shipping-label pages are flattened raster images
    // with no embedded text layer — getTextContent()/OCR can only recover
    // an AWB here if the label itself prints one as readable text. Tried
    // against the current page first, then the immediately adjacent pages
    // (some bulk PDFs split invoice/label across pages for the same
    // order). Only a strictly-validated, courier-format/keyword-anchored
    // value is accepted (see extractAwbStrict) — never a raw guess.
    let awb = '';
    let awbIsRealWaybill = false; // false ⇒ synthesized fallback, must be flagged
    const prevPage = pages[i - 1] || '';
    const nextPage = pages[i + 1] || '';
    const around = [page, prevPage, nextPage];

    // BUG THIS FIXES (Aug 2026): Amazon bulk PDFs alternate one raster
    // shipping-label page with one text invoice page for the same order.
    // The Order Number only parses cleanly off the INVOICE page, so that
    // is the page this loop is standing on — and the invoice prints its
    // own line reading "AWB No. 2228274565". That number is the invoice
    // batch reference, NOT a waybill: it is byte-identical on every
    // invoice in the file, and reappears as "Invoice Details :
    // TN-2228274565-2627" a few lines below. Tier 1 used to call
    // extractAwbStrict on the invoice page first, match that keyword
    // line, and stop — so on an 18-page/9-order batch, EIGHT orders were
    // all saved with the same fake AWB 2228274565 and the real waybills
    // printed on the labels (371856317100, 371856312860, …) were never
    // read. Bulk dispatch, courier tracking and return scanning are all
    // AWB-keyed, so every one of those orders was unusable.
    //
    // Two rules now: read the label page before the invoice page, and
    // never accept a value the page itself identifies as the invoice
    // reference.
    const isLabelPage = (pg) => /Sold\s*on\s*:\s*www\.amazon\.in|ATSPL|Ship\s*To\s*:/i.test(pg);
    const isInvoiceRef = (val) =>
      !!val && around.some((pg) =>
        new RegExp(`Invoice\\s*Details\\s*:?\\s*[A-Z]{2}-${val}-`, 'i').test(pg));

    // Which order does a neighbouring page actually belong to? A label
    // page prints "Order Id: 404-5424103-2669167" — but it has been
    // through OCR, so the separators come back as en/em dashes or plain
    // spaces. Compare on digits only.
    //
    // SECOND BUG, found while fixing the first: simply preferring label
    // pages let an order take the AWB off `nextPage`, which in an
    // alternating label/invoice file is the NEXT order's label. Four
    // orders whose own label had unreadable barcode text silently
    // adopted a neighbour's real waybill — two different orders ending
    // up with the same AWB, which is worse than having none, because it
    // looks completely legitimate. A page whose Order Id names a
    // different order is now never a source of this order's AWB.
    const orderDigits = orderId.replace(/\D/g, '');
    const pageOrderDigits = (pg) => {
      const m = pg.match(/Order\s*(?:[I1l]d|Number)\s*[:\s]+((?:\d[\s‐-―-]*){15,25})/i);
      return m ? m[1].replace(/\D/g, '') : '';
    };
    // Same order → trusted. No Order Id readable at all (OCR lost it) →
    // usable as a weaker fallback. Different order → excluded outright.
    //
    // THIRD BUG (Sep 2026): "different order" was too strict. On a real
    // Amazon label OCR read the printed Order Id as
    //     408 - 2468568 - 1578758   (really 408 - 2465568 - 1578758)
    // — one digit out of seventeen, a 5 read as an 8. The page was
    // therefore treated as belonging to some other order and discarded,
    // taking with it the barcode-read AWB 372201297795 that was sitting
    // correctly on that very page. The order fell all the way to the
    // Tier 3 Order-Id fallback and had no usable waybill.
    //
    // One OCR'd character is now tolerated, and only that: same length,
    // at most one differing digit. That cannot let a neighbour's label
    // in — measured across this seller's real Amazon batches the closest
    // two order ids differ in TEN of seventeen digits, and the format
    // (3-7-7) makes near-collisions vanishingly unlikely. Pages matched
    // this way still rank below exact matches.
    const nearlySameOrder = (d) => {
      if (!d || d.length !== orderDigits.length) return false;
      let diff = 0;
      for (let k = 0; k < d.length; k++) {
        if (d[k] !== orderDigits[k] && ++diff > 1) return false;
      }
      return diff === 1;
    };

    const sameOrder = [], nearOrder = [], unknownOrder = [];
    for (const pg of around) {
      if (!pg.trim()) continue;
      const d = pageOrderDigits(pg);
      if (d && d === orderDigits) sameOrder.push(pg);
      else if (d && nearlySameOrder(d)) nearOrder.push(pg);
      else if (!d) unknownOrder.push(pg);
    }
    const ranked = [
      ...sameOrder.filter(isLabelPage), ...sameOrder.filter((p) => !isLabelPage(p)),
      ...nearOrder.filter(isLabelPage),
      ...unknownOrder.filter(isLabelPage),
    ];

    // Tier 1: the label's own "AWB <digits>" printed under the barcode —
    // the single most trustworthy value on an Amazon shipment.
    for (const pg of ranked) {
      const m = pg.match(/\bAWB\s*(?:No\.?|#)?\s*[:#]?\s*(\d{10,15})\b(?!\s*\/)/i);
      if (m && !isInvoiceRef(m[1])) { awb = m[1]; awbIsRealWaybill = true; break; }
    }

    // Tier 2: strict extraction over the same ranked pages — picks up
    // non-numeric waybills such as India Post's "AM103683045IN".
    if (!awb) {
      for (const pg of ranked) {
        const c = extractAwbStrict(pg);
        if (c && !isInvoiceRef(c)) { awb = c; awbIsRealWaybill = true; break; }
      }
    }

    // Tier 3: no waybill readable (common — the label is a flattened
    // image and OCR could not resolve the barcode digits). Fall back to
    // the Order Id so the record still has a unique key, but mark it as
    // NOT a real waybill so the parse log tells the user to scan the
    // physical AWB at dispatch instead of trusting this value.
    if (!awb) {
      for (const pg of around) {
        const m = pg.match(/Order\s*Id\s*[:\s]+([\d‐-―\-\s]{15,30})/i);
        if (m) { awb = m[1].replace(/[^\d]/g, ''); break; }
      }
    }

    // Tier 4: Use invoice number as last resort
    if (!awb && invoice) awb = invoice;

    // ── Customer name + address ───────────────────────────────────
    // Both pulled from the same "Shipping Address" block: the recipient's
    // name is always the first line directly under that heading, with the
    // street/locality/city/pincode lines following it. (The previous
    // version of this parser anchored its name regex on the seller's own
    // name from one specific sample label — that can never match a
    // different seller, which is presumably why "Meesho/Amazon address and
    // customer name extraction" was broken. Replaced with this generic,
    // template-structure-based extraction instead of any specific name.)
    // The "Shipping Address" block only exists on the INVOICE page. When
    // an order gets parsed off its LABEL page instead (which happens
    // whenever the label's Order Id survives OCR), this found nothing and
    // the order was saved with the literal name "Customer" and a blank
    // address — seen on a real Speed Post label, whose own OCR'd name
    // line was unreadable anyway. Same pattern as the company fallback
    // above: look at the other pages already proven to belong to THIS
    // order, so a neighbour's buyer can never be attached to it.
    const findAddrBlock = (pg) =>
      pg.match(/Shipping\s+Address\b[^\n]*\n([\s\S]*?)(?:\n\s*State\/UT\s+Code|\n\s*Place\s+of\s+supply)/i) ||
      pg.match(/Billing\s+Address\b[^\n]*\n([\s\S]*?)(?:\n\s*State\/UT\s+Code|\n\s*Place\s+of\s+supply)/i);

    let addrBlockM = findAddrBlock(page);
    if (!addrBlockM) {
      for (const pg of sameOrder) {
        addrBlockM = findAddrBlock(pg);
        if (addrBlockM) break;
      }
    }

    let customer = 'Customer';
    let address = '';
    if (addrBlockM) {
      const { name, address: addr } = splitNameAndAddress(addrBlockM[1], AMAZON_ADDR_NOISE_RE);
      if (name) customer = name;
      address = addr;
    }

    // Phone — used for fraud/repeat-returner matching only, never shown.
    const phoneM = page.match(/(?:Ph|Phone|Mob|Mobile|Contact)\s*[:\.]?\s*(\+?[\d\s\-]{10,14})/i)
      || page.match(/\b([6-9]\d{9})\b/);
    const phone = phoneM ? phoneM[1].replace(/\s+/g, '').trim() : '';

    // ── Amazon SKU extraction (multi-strategy, unchanged) ────────
    let sku = '';
    const skuParenM = page.match(/\(\s*([A-Z0-9]{2}-[A-Z0-9]{4}-[A-Z0-9]{4,8})\s*\)/i);
    if (skuParenM) sku = skuParenM[1].toUpperCase();
    if (!sku) {
      const skuIdM = page.match(/SKU\s+ID\s*[:\|]?\s*([A-Z0-9]{2}-[A-Z0-9]{4}-[A-Z0-9]{4,8})/i);
      if (skuIdM) sku = skuIdM[1].toUpperCase();
    }
    if (!sku) {
      const skuBareM = page.match(/\b([A-Z0-9]{2,4}-[A-Z0-9]{3,6}-[A-Z0-9]{3,8})\b/);
      if (skuBareM) sku = skuBareM[1].toUpperCase();
    }
    if (!sku) {
      const asinM = page.match(/\b(B0[A-Z0-9]{8})\b/i);
      if (asinM) sku = asinM[1].toUpperCase();
    }
    if (!sku) sku = invoice || 'Amazon-Product';

    let amount = 0;
    const totalIdx = page.indexOf('TOTAL:');
    if (totalIdx >= 0) {
      const after = page.slice(totalIdx, totalIdx + 60);
      const amts = [...after.matchAll(/([\d,]+\.\d{2})/g)];
      if (amts.length) amount = parseFloat(amts[amts.length - 1][1].replace(/,/g, ''));
    }
    if (!amount) {
      const amts = [...page.matchAll(/(?:[₹\u20b9]|Rs\.?)\s*([\d,]+\.\d{2})/g)];
      if (amts.length) amount = parseFloat(amts[amts.length - 1][1].replace(/,/g, ''));
    }

    const payment = /\bhrs\s+[\d,]+/.test(page) || /GiftCard/.test(page) ? 'Prepaid' : 'COD';
    const isExchange = detectExchange(page);

    const dateM = page.match(/Order\s+Date\s*:?\s*(\d{2}\.\d{2}\.\d{4})/i) ||
      page.match(/Invoice\s+Date\s*:?\s*(\d{2}\.\d{2}\.\d{4})/i);
    const orderDate = dateM ? normalizeDate(dateM[1]) : today();

    // ── Multi-company detection ──────────────────────────────────
    // Known-company lookup against the "Sold by"/return-address block —
    // never a freeform guess. See COMPANIES / detectCompany() above.
    //
    // Amazon splits an order across a label page and an invoice page,
    // and only ONE of them carries the seller's GSTIN. Which one this
    // loop is standing on depends on whether the label's Order Id
    // survived OCR. Observed on a real batch: a Speed Post label whose
    // Order Id read cleanly was parsed from the LABEL page, which
    // prints only "Shipped By: Boopathi raj" and no GSTIN — so the
    // order was filed under company "Unknown" and dropped out of the
    // per-company segregation, even though its invoice page one along
    // states GSTIN 33FPAPB6603C1ZO. Falling back to the pages already
    // confirmed to belong to THIS order (never a neighbour's — see the
    // `sameOrder` split above) fixes it without any risk of
    // misattributing an order to the wrong business.
    let companyMatch = detectCompany(page);
    if (!companyMatch) {
      for (const pg of sameOrder) {
        companyMatch = detectCompany(pg);
        if (companyMatch) break;
      }
    }

    // ── Courier / logistics-partner detection (see COURIERS /
    // CHANNEL_DEFAULT_COURIER above) — real detection from the label
    // always wins; 'Amazon Shipping' (ATSPL) only fills in when
    // nothing on the page names a courier at all.
    const courierMatch = resolveCourier(page, awb, 'Amazon');

    // ── Quantity extraction (see extractAmazonQty / extractQty above) ──
    let { quantity, found: qtyFound } = extractAmazonQty(page);
    if (!qtyFound) ({ quantity, found: qtyFound } = extractQty(page));

    const reasonParts = [];
    if (!companyMatch) reasonParts.push('Seller/company name on this label did not match any entry in COMPANIES — set to "Unknown"');
    if (!qtyFound) reasonParts.push('Quantity ("QTY") not found on this label — defaulted to 1');
    // Anything that is not a genuine waybill read off the shipping label
    // is called out explicitly. Previously the Order-Id fallback filled
    // `awb` with a real-looking 17-digit number and produced NO warning
    // at all, so a label whose barcode OCR had failed looked identical
    // in the parse log to one that scanned perfectly.
    if (!awb) {
      reasonParts.push('AWB not extracted — order will need AWB scanned manually at dispatch');
    } else if (!awbIsRealWaybill) {
      reasonParts.push(
        awb.startsWith('IN-')
          ? 'No waybill on the label — using Invoice Ref as a placeholder; scan the real AWB at dispatch'
          : 'No waybill readable on the label (image-only label, OCR could not resolve the barcode) — using the Order Id as a placeholder; scan the real AWB at dispatch'
      );
    }

    parseLog.push({
      page: pageNum,
      status: 'ok',
      reason: reasonParts.join('; '),
      orderId,
      awb: awb && !awb.startsWith('IN-') ? awb : null,
    });
    orders.push({
      orderId, awb, altAwbs: extractAltAwbs(page, awb), invoice, customer, phone, address,
      sku, channel: 'Amazon', payment, amount, orderDate, quantity,
      orderType: isExchange ? 'Exchange' : 'Regular',
      company: companyMatch ? companyMatch.name : 'Unknown',
      companyId: companyMatch ? companyMatch.id : 'unknown',
      courier: courierMatch ? courierMatch.name : 'Unknown',
      courierId: courierMatch ? courierMatch.id : 'unknown',
    });
  }
  return { orders, parseLog };
}


// ── Flipkart AWB extractor ───────────────────────────────────
// The bounding-box spine extractor in extractPdfText() injects a
// synthetic "AWB No. <value>" line at the very top of pageText for
// every Flipkart/Shopsy/Ekart label page, regardless of AWB prefix
// (FMPP, FMPC, FM, SF-prefix, numeric-only, anything).  This function
// therefore only needs a single keyword-anchored pass — the complex
// multi-pass look-around from v3.15 is no longer required.
//
// A fallback to the general extractAwbStrict() is kept for any edge
// case where the spine extractor didn't fire (e.g. a non-rotated
// label variant, or a page where the spine column had fewer than 4
// single-char items and thus didn't qualify).
function extractFlipkartAwb(page) {
  if (!page) return '';

  // Courier signature FIRST. An Ekart/Shadowfax/Delhivery waybill has a
  // shape a phone number cannot take, so when one is printed anywhere on
  // the label it is the answer and no keyword needs consulting.
  //
  // BUG THIS FIXES (Aug 2026): this function used to run the keyword
  // match first, with no phone guard at all. On a real Flipkart label
  // the buyer's mobile typed into the address line gets reconstructed
  // next to the rotated "AWB No." caption, so "AWB No. 9353554607"
  // appeared and won — even with FMPC6413710093 printed further down
  // the same page. A dispatch reconciliation found 14 Ekart orders
  // saved with a customer's phone number as their AWB; those parcels
  // can never be matched by scanning. The Meesho version of this bug
  // was fixed earlier, but Flipkart has its own extractor and was
  // missed.
  const sig =
    page.match(/\b((?:FMPP|FMPC|FM[A-Z])\d{8,15})\b/i) ||
    page.match(/\b(SF\d{7,13})\s*(FPL)\b/i) ||
    page.match(/\b(1490\d{12})\b/);
  if (sig) return (sig[2] ? sig[1] + sig[2] : sig[1]).toUpperCase();

  // Keyword-anchored match — the synthetic "AWB No. FMPP…" spine tag or
  // a normal same-line layout. Rejected outright if it is a mobile
  // number or a number that also appears in the buyer's address block.
  const primary =
    page.match(/\bAWB\s*No\.?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\-]{3,24}[A-Za-z0-9])/i) ||
    page.match(/\bAWB\s*No\.?\s*[:\-]?\s*\n\s*([A-Za-z0-9][A-Za-z0-9\-]{3,24}[A-Za-z0-9])/i) ||
    page.match(/\bWB\s*No\.?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\-]{3,24}[A-Za-z0-9])/i);
  if (primary) {
    const c = primary[1].toUpperCase();
    const isPhone = looksLikeMobile(c) || isCustomerPhoneDigits(page, c);
    if (!isPhone && (c.match(/\d/g) || []).length >= 3) return c;
  }

  // Fallback: general strict extractor (Tier 1-3 keyword + signature + window)
  return extractAwbStrict(page);
}
// ── FLIPKART ─────────────────────────────────────────────────
function parseFlipkart(text) {
  const orders = [];
  const parseLog = [];
  const pages = text.split(/--- PAGE BREAK ---/);

  for (let i = 0; i < pages.length; i++) {
    const pageNum = i + 1;
    const page = pages[i] || '';
    if (!page.trim()) continue;

    const { id: orderId, candidate } = findFlipkartOrderId(page);
    if (!orderId) {
      parseLog.push({
        page: pageNum,
        status: 'skipped',
        reason: candidate
          ? `Found "${candidate}" but it does not match the strict Flipkart Order ID format (OD + 15-18 digits) — rejected`
          : 'No Flipkart Order ID (OD…) found on this page',
        orderId: null,
      });
      continue;
    }

    if (orders.find((o) => o.orderId === orderId)) {
      parseLog.push({ page: pageNum, status: 'duplicate', reason: `Duplicate Order ID: ${orderId}`, orderId });
      continue;
    }

    // AWB — Flipkart-specific keyword-aware extraction.
    // Searches for "AWB No." (case-insensitive) and captures the entire
    // alphanumeric string immediately following it, on the same line or
    // the next line (handles two-column rotated-text PDF layout).
    // Accepts any format: FMPP, FMPC, SF, numeric-only, etc.
    const awb = extractFlipkartAwb(page);

    const invM = page.match(/Invoice\s+No\s*[:\s]*(LWAEHET\d+)/i) || page.match(/\b(LWAEHET\d+)\b/);
    const invoice = invM ? invM[1].trim() : '';

    const custM = page.match(/Name\s*:\s*([A-Za-z][A-Za-z\s.,]{2,50}?)\s*[,\n]/i);
    const customer = custM ? clean(custM[1].replace(/,$/, '')) : 'Customer';

    const phoneM = page.match(/(?:Ph|Phone|Mob|Mobile|Contact)\s*[:\.]?\s*(\+?[\d\s\-]{10,14})/i)
      || page.match(/\b([6-9]\d{9})\b/);
    const phone = phoneM ? phoneM[1].replace(/\s+/g, '').trim() : '';

    const addrM = page.match(/Ship\s*(?:ping)?\s*(?:To|Address)\s*:?\s*\n([^\n]+(?:\n[^\n]+){0,3})/i);
    const address = addrM ? clean(addrM[1].replace(/\n/g, ', ')) : '';

    // ── Flipkart SKU extraction (multi-strategy, unchanged) ──────
    let sku = '';
    const skuTableM =
      page.match(/SKU\s+ID\s*\|\s*Description\s+QTY\s*\n\s*(\d+)\s+(.+?)\s+\|\s/i) ||
      page.match(/SKU\s+ID\s*\|\s*Description\s+QTY[\s\S]{0,20}?\n\s*\d\s+([^\|]{3,80})\s+\|/i);
    if (skuTableM) {
      const raw = (skuTableM[2] || skuTableM[1] || '').trim();
      if (raw && !/^\d+$/.test(raw)) sku = clean(raw);
    }
    if (!sku) {
      const skuInlineM = page.match(/\b\d\s+([A-Za-z0-9][A-Za-z0-9 _\-]{2,60}?)\s*\|\s*Lam\s/i);
      if (skuInlineM) sku = clean(skuInlineM[1]);
    }
    if (!sku) {
      const skuGeneralM = page.match(/^\s*\d+\s+([A-Za-z][A-Za-z0-9 _\-]{2,60}?)\s*\|/im);
      if (skuGeneralM) sku = clean(skuGeneralM[1]);
    }
    if (!sku) sku = invoice || orderId;

    const isCOD = /\bCOD\b/.test(page) && !/PREPAID/.test(page);
    const payment = isCOD ? 'COD' : 'Prepaid';

    const amtM = page.match(/TOTAL\s+PRICE\s*[:\s]+([\d,]+\.?\d{0,2})/i) ||
      page.match(/TOTAL\s+([\d,]+\.\d{2})\s/im);
    const amount = amtM ? parseFloat(amtM[1].replace(/,/g, '')) : 0;

    const dateM = page.match(/Order\s+Date\s*[:\s]+(\d{2}-\d{2}-\d{4})/i);
    const orderDate = dateM ? normalizeDate(dateM[1]) : today();

    const isExchange = detectExchange(page);

    // ── Multi-company detection (see COMPANIES / detectCompany() above) ──
    const companyMatch = detectCompany(page);

    // ── Courier / logistics-partner detection (see COURIERS /
    // CHANNEL_DEFAULT_COURIER above) ──
    // Flipkart ships via Ekart almost universally but increasingly also
    // via third-party partners — real detection from the label always
    // wins; 'Ekart Logistics' only fills in when nothing on the page
    // names a courier at all.
    const courierMatch = resolveCourier(page, awb, 'Flipkart');

    // ── Quantity extraction (see extractFlipkartQty / extractQty above) ──
    // The "TOTAL QTY: N" anchor (verified against a real multi-item
    // label, see extractFlipkartQty) is the most reliable signal and is
    // tried first. skuTableM[1] (the SKU table's own leading row number)
    // stays as a last-resort secondary fallback exactly as before — it
    // was never confirmed against a real label and the row number it
    // reads can coincide with, but isn't actually, the qty column.
    let { quantity, found: qtyFound } = extractFlipkartQty(page);
    if (!qtyFound) ({ quantity, found: qtyFound } = extractQty(page));
    if (!qtyFound && skuTableM && skuTableM[1] && /^\d{1,2}$/.test(skuTableM[1])) {
      quantity = parseInt(skuTableM[1], 10) || 1;
      qtyFound = true;
    }

    const reasonParts = [];
    if (!companyMatch) reasonParts.push('Seller/company name on this label did not match any entry in COMPANIES — set to "Unknown"');
    if (!qtyFound) reasonParts.push('Quantity ("QTY") not found on this label — defaulted to 1');
    if (!awb) reasonParts.push('AWB not extracted — order will need AWB scanned manually at dispatch');

    parseLog.push({
      page: pageNum,
      status: 'ok',
      reason: reasonParts.join('; '),
      orderId,
      awb: awb || null,
    });
    orders.push({
      orderId, awb, altAwbs: extractAltAwbs(page, awb), invoice, customer, phone, address,
      sku, channel: 'Flipkart', payment, amount, orderDate, quantity,
      orderType: isExchange ? 'Exchange' : 'Regular',
      company: companyMatch ? companyMatch.name : 'Unknown',
      companyId: companyMatch ? companyMatch.id : 'unknown',
      courier: courierMatch ? courierMatch.name : 'Unknown',
      courierId: courierMatch ? courierMatch.id : 'unknown',
    });
  }
  return { orders, parseLog };
}

// ── MEESHO ───────────────────────────────────────────────────
function parseMeesho(text) {
  const orders = [];
  const parseLog = [];
  const pages = text.split(/--- PAGE BREAK ---/);

  for (let i = 0; i < pages.length; i++) {
    const pageNum = i + 1;
    const page = pages[i] || '';
    if (!page.trim()) continue;

    // ── Sub-Order ID — the unique key per line-item ───────────────
    // Meesho's "Product Details" table prints a SUB-ORDER ID per item,
    // e.g. "295249080434038976_1". When one order has multiple items,
    // each item gets its own label sharing the same base number but a
    // different "_N" suffix — this MUST be used (in full, suffix
    // included) as the unique key, or every item on a multi-item order
    // collapses into one "duplicate" record.
    const { id: orderId, candidate } = findMeeshoOrderId(page);
    if (!orderId) {
      parseLog.push({
        page: pageNum,
        status: 'skipped',
        reason: candidate
          ? `Found "${candidate}" but it does not match the strict Meesho Sub-Order ID format (15-20 digits + "_" + item no.) — rejected`
          : 'No Meesho Sub-Order ID / Order No. found on this page',
        orderId: null,
      });
      continue;
    }

    if (orders.find((o) => o.orderId === orderId)) {
      parseLog.push({ page: pageNum, status: 'duplicate', reason: `Duplicate Order ID: ${orderId}`, orderId });
      continue;
    }

    // AWB — courier signature (Shadowfax "SF...FPL", etc.) or a
    // keyword-anchored numeric tracking number only.
    const awb = extractAwbStrict(page);

    // ── Customer name + full address ──────────────────────────────
    // Both come from the same "Customer Address" block: heading, then the
    // recipient's name as the first surviving line, then street/locality/
    // city/pincode lines. (The previous regex's character class included
    // `\s`, which also matches newlines — on this two-column label that let
    // the match cross the line break and swallow the courier name on the
    // next line too, e.g. "Vijay s/o Vijayakandipan\nDelhivery". Pulling
    // name+address from one cleaned, noise-filtered block instead of two
    // separate fragile regexes fixes both issues at once.)
    const blockM =
      page.match(/Customer\s+Address\b[^\n]*\n([\s\S]*?)(?:\n\s*If\s+undelivered)/i) ||
      page.match(/Customer\s+Address\b[^\n]*\n((?:[^\n]+\n){1,7}[^\n]+)/i) ||
      page.match(/BILL\s+TO\s*\/\s*SHIP\s+TO\b[^\n]*\n([\s\S]*?)(?:\n\s*If\s+undelivered)/i);

    let customer = '';
    let address = '';
    if (blockM) {
      const lines = meeshoCleanLines(blockM[1]);
      if (lines.length) {
        customer = clean(lines[0]);
        address = clean(lines.slice(1).join(', '));
      }
    }
    // An explicit "Customer Name:" / "Buyer Name:" label, when present,
    // is more reliable than the positional first-line guess above.
    const nameLabelM = page.match(/(?:Customer\s+Name|Buyer\s+Name)\s*[:\-]\s*([A-Za-z][A-Za-z .,'\/\-]{1,60})(?=\n|$)/i);
    if (nameLabelM) customer = clean(nameLabelM[1]);
    if (!customer) customer = 'Customer';

    const phoneM = page.match(/(?:Ph|Phone|Mob|Mobile|Contact)\s*[:\.]?\s*(\+?[\d\s\-]{10,14})/i)
      || page.match(/\b([6-9]\d{9})\b/);
    const phone = phoneM ? phoneM[1].replace(/\s+/g, '').trim() : '';

    let skuM =
      page.match(/\bSKU\b[^\n]*\n([^\n]{3,80}?)(?:\s+Free\s+Size|\s+\d+\s+NA|\n|$)/i);
    if (!skuM)
      skuM = page.match(/\bSKU\b[\s\S]{0,40}?([A-Za-z][A-Za-z0-9 ]{3,60}?)\s+Free\s+Size/i);
    if (!skuM)
      skuM = page.match(/\bSKU\s+([A-Za-z][A-Za-z0-9 ]{3,60}?)(?:\s{2,}|\n|$)/i);
    let sku = skuM ? clean(skuM[1]) : 'Meesho-Product';

    const isCOD = /COD\s*:\s*Check/i.test(page) || /\bCOD\b/.test(page);
    const payment = isCOD ? 'COD' : 'Prepaid';

    let amount = 0;
    const totalRowM = page.match(/\bTotal\b((?:\s+Rs\.[\d,.]+)+)/i);
    if (totalRowM) {
      const allVals = [...totalRowM[1].matchAll(/Rs\.(\d[\d,.]+)/g)];
      if (allVals.length) amount = parseFloat(allVals[allVals.length - 1][1].replace(/,/g, ''));
    }
    if (!amount) {
      const rs = [...page.matchAll(/Rs\.([\d]+[\d,.]*)/g)];
      if (rs.length) amount = parseFloat(rs[rs.length - 1][1].replace(/,/g, ''));
    }

    const dateM = page.match(/Order\s+Date\s*\n\s*([\d]{2}\.[\d]{2}\.[\d]{4})/i) ||
      page.match(/Order\s+Date\s+([\d]{2}\.[\d]{2}\.[\d]{4})/i) ||
      page.match(/([\d]{2}\.[\d]{2}\.[\d]{4})/);
    const orderDate = dateM ? normalizeDate(dateM[1]) : today();

    const invM = page.match(/Invoice\s+No\.?\s*\n\s*([\w\d]+)/i);
    const invoice = invM ? invM[1].trim() : '';

    const isExchange = detectExchange(page);

    // ── Multi-company detection (see COMPANIES / detectCompany() above) ──
    const companyMatch = detectCompany(page);

    // ── Courier / logistics-partner detection (see COURIERS /
    // CHANNEL_DEFAULT_COURIER above) ──
    // Meesho is the platform that actually varies courier-to-courier
    // (Shadowfax, Delhivery, Xpressbees, …), which is exactly why real
    // per-label detection stays the primary signal here too — the
    // configured Delhivery default only fills in on the rare label
    // that names no courier at all.
    const courierMatch = resolveCourier(page, awb, 'Meesho');

    // ── Quantity extraction (see extractMeeshoQty / extractQty above) ──
    let { quantity, found: qtyFound } = extractMeeshoQty(page);
    if (!qtyFound) ({ quantity, found: qtyFound } = extractQty(page));

    const reasonParts = [];
    if (!companyMatch) reasonParts.push('Seller/company name on this label did not match any entry in COMPANIES — set to "Unknown"');
    if (!qtyFound) reasonParts.push('Quantity ("QTY") not found on this label — defaulted to 1');
    if (!awb) reasonParts.push('AWB not extracted — order will need AWB scanned manually at dispatch');

    parseLog.push({
      page: pageNum,
      status: 'ok',
      reason: reasonParts.join('; '),
      orderId,
      awb: awb || null,
    });
    orders.push({
      orderId, awb, altAwbs: extractAltAwbs(page, awb), invoice, customer, phone, address,
      sku, channel: 'Meesho', payment, amount, orderDate, quantity,
      orderType: isExchange ? 'Exchange' : 'Regular',
      company: companyMatch ? companyMatch.name : 'Unknown',
      companyId: companyMatch ? companyMatch.id : 'unknown',
      courier: courierMatch ? courierMatch.name : 'Unknown',
      courierId: courierMatch ? courierMatch.id : 'unknown',
    });
  }
  return { orders, parseLog };
}

// ============================================================
// REPEAT-RETURNER DETECTION (order-history based)
// ============================================================
// This is distinct from the manual Fraud Blocklist (checkFraud above,
// which matches against entries a user explicitly added). This instead
// looks at the order history itself: if the same customer name or the
// same delivery address shows up across several orders AND a high
// proportion of those orders ended up as a return ('In Transit (Return)'
// or 'Return Received'), that's a basic, automatic risk signal worth
// surfacing — independent of whether anyone has manually blocklisted
// them yet. Both `customer` and `address` are still read here (and kept
// in the stored order record) even though the Sales table UI no longer
// displays the raw address column — this is exactly the "background"
// fraud-analysis use case the address/name fields exist for.
//
// Returns a Map<order.id, info> where info = {
//   matchedOn: 'name' | 'address', key, totalOrders, returnedOrders, returnRate
// }
// A given order can appear via either match type; if it qualifies under
// both, the higher-risk (higher returnRate) info is kept.
export function detectRepeatReturners(orders, opts = {}) {
  const MIN_ORDERS = opts.minOrders ?? 3;     // need a few orders before judging a pattern
  const RATE_THRESHOLD = opts.rateThreshold ?? 0.4;    // 40%+ returned/RTO = flagged as high risk

  const isReturn = (o) => o.status === 'In Transit (Return)' || o.status === 'Return Received';
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  const active = (orders || []).filter((o) => !o.deleted);
  const byName = new Map();
  const byAddr = new Map();

  active.forEach((o) => {
    const nc = norm(o.customer);
    const na = norm(o.address);
    if (nc) { if (!byName.has(nc)) byName.set(nc, []); byName.get(nc).push(o); }
    if (na && na.length > 8) { if (!byAddr.has(na)) byAddr.set(na, []); byAddr.get(na).push(o); }
  });

  const result = new Map();

  function evaluate(groups, matchedOn) {
    groups.forEach((group, key) => {
      if (group.length < MIN_ORDERS) return;
      const returnedOrders = group.filter(isReturn).length;
      const returnRate = returnedOrders / group.length;
      if (returnRate < RATE_THRESHOLD) return;
      const info = { matchedOn, key, totalOrders: group.length, returnedOrders, returnRate };
      group.forEach((o) => {
        const existing = result.get(o.id);
        if (!existing || info.returnRate > existing.returnRate) result.set(o.id, info);
      });
    });
  }

  evaluate(byName, 'name');
  evaluate(byAddr, 'address');

  return result;
}

// Short, human-readable label for the warning badge / tooltip
export function repeatReturnerLabel(info) {
  if (!info) return '';
  const pct = Math.round(info.returnRate * 100);
  const basis = info.matchedOn === 'address' ? 'this address' : 'this customer name';
  return `⚠️ ${info.returnedOrders}/${info.totalOrders} orders (${pct}%) returned for ${basis}`;
}

// Same-item history needs an address+name or a full phone number. A name
// alone is only a weak signal in the existing general return-risk badge.
export function detectSameItemReturnRisk(orders) {
  const norm=s=>String(s||'').toLowerCase().replace(/\s+/g,' ').trim();
  const groups=new Map(), result=new Map();
  for(const o of orders || []) {
    if(o.deleted || !norm(o.sku))continue;
    const phone=String(o.phone||'').replace(/\D/g,'');
    const identity=phone.length>=10 ? `phone:${phone.slice(-10)}` : norm(o.customer) && norm(o.address).length>8 ? `name+address:${norm(o.customer)}:${norm(o.address)}` : '';
    if(!identity)continue;
    const key=JSON.stringify([identity,norm(o.sku)]);
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(o);
  }
  for(const group of groups.values()) {
    const returned=new Set(group.filter(o=>['In Transit (Return)','Return Received'].includes(o.status)).map(o=>o.orderId||o.id)).size;
    if(returned<2)continue;
    for(const o of group)result.set(o.id,{returnedOrders:returned,matchedOn:String(o.phone||'').replace(/\D/g,'').length>=10?'phone + SKU':'name/address + SKU'});
  }
  return result;
}

// ============================================================
// COURIER-WISE ANALYTICS  (Platform → Courier → Status counts)
// ============================================================
// The actual lifecycle this app tracks per order (see Dispatch.jsx /
// Returns.jsx / Received.jsx) is the `status` field below — there is no
// separate raw "Pickup/Scan" event log, so the breakdown groups by these
// real, already-tracked stages rather than inventing stages the data
// doesn't actually have:
//   Ready to Ship        → picked, not yet scanned out
//   Dispatched            → scanned & handed to the courier
//   In Transit (Return)   → courier has it moving back to you
//   Return Received       → back in stock
export const ORDER_STATUSES = ['Ready to Ship', 'Dispatched', 'In Transit (Return)', 'Return Received'];

// Builds { [channel]: { [courier]: { [status]: count, total } } } from
// whatever `channel`/`courier`/`status` values actually appear on the
// orders — NOT from a hardcoded list of platforms or couriers. This is
// what makes the breakdown scale automatically: a brand-new courier (or
// even a brand-new sales channel) that shows up on a freshly-parsed
// order appears here on the next render with zero code changes, because
// the grouping key comes from the data, not from a switch/case.
// Registering a courier in COURIERS (above) only affects how confidently
// it gets *detected* during parsing — it is never required for it to
// show up here.
export function buildCourierBreakdown(orders) {
  const active = (orders || []).filter((o) => !o.deleted);
  const tree = {};
  for (const o of active) {
    const channel = o.channel || 'Unknown';
    const courier = o.courier || 'Unknown';
    const status = o.status || 'Ready to Ship';
    if (!tree[channel]) tree[channel] = {};
    if (!tree[channel][courier]) tree[channel][courier] = { total: 0 };
    const bucket = tree[channel][courier];
    bucket[status] = (bucket[status] || 0) + 1;
    bucket.total += 1;
  }
  return tree;
}

// Flattens buildCourierBreakdown()'s nested tree into rows — the literal
// [Platform] -> [Courier] -> [Status: count] shape, ready for a table or
// for export. Never throws on a partner with no rows for a given status;
// missing statuses simply read as 0.
export function flattenCourierBreakdown(orders) {
  const tree = buildCourierBreakdown(orders);
  const rows = [];
  for (const channel of Object.keys(tree)) {
    for (const courier of Object.keys(tree[channel])) {
      const bucket = tree[channel][courier];
      rows.push({
        channel,
        courier,
        total: bucket.total,
        byStatus: ORDER_STATUSES.reduce((acc, s) => { acc[s] = bucket[s] || 0; return acc; }, {}),
      });
    }
  }
  return rows.sort((a, b) => b.total - a.total);
}

// ── Profit Analysis: Net Received (post-GST, from Payments) − Purchase
// Cost (SKU rate × qty, from the Purchase Rate DB) = Net Profit ──────────
// Only orders that already have a matching payment record are included —
// profit isn't knowable until the actual settlement (net of GST) is in.
// An order whose SKU has no rate set in Products still shows up (so
// nothing is silently dropped) but with purchaseCost/profit as null and
// rateMissing: true, so the UI can flag it separately instead of quietly
// treating the missing cost as ₹0.
// `countReturnedStockAsCost` — when false (the default), an order whose
// goods came BACK to you carries no purchase cost.
//
// WHY (Aug 2026): on an RTO the buyer never took delivery, so the parcel
// is returned and the stock is back on your shelf ready to sell again.
// Net Received is correctly ₹0 for those orders, but the purchase cost
// was still being charged in full, so Profit Analysis showed a straight
// loss of the item's cost on every single RTO — e.g. "Net ₹0.00 /
// Purchase ₹25.00 / Profit −₹25.00". You never lost that ₹25: you still
// own the item. Charging it makes the whole month's profit look far
// worse than it is, and inflates the apparent loss on exactly the SKUs
// that get returned most.
//
// Stock coming back is decided by the order's own status, NOT by
// netReceived being 0 — an order that simply hasn't been paid yet also
// shows 0 and must still carry its cost.
//
// Set the flag to true if you would rather treat returned goods as a
// write-off (e.g. items usually come back damaged and unsellable).
const RETURNED_STOCK_STATUSES = ['In Transit (Return)', 'Return Received'];

// ── syncSkusFromOrders ───────────────────────────────────────
// Makes sure every SKU that appears on an order also exists on the
// Purchase Rates page, once, with a rate of 0 waiting to be filled in.
//
// WHY: purchase rates were only ever added by hand or by uploading a
// separate sheet, so a SKU that had never been typed in simply had no
// cost — and every order of it dropped out of Profit Analysis into the
// "missing purchase rate" pile. At ~300 labels a day that is a lot of
// hunting for which product is new.
//
// Rules:
//   * ONE row per SKU no matter how many orders carry it. Ten Punch
//     Needle orders produce a single Punch Needle row.
//   * Matching is EXACT (surrounding spaces trimmed, nothing else).
//     One letter of difference = a different SKU. "PUNCH NEEDLE",
//     "Punch Needle" and "Punch Needle 5" are three separate rows with
//     three separate rates. This is deliberate: the seller's SKU codes
//     carry meaning in their case and suffixes, and silently folding
//     two codes together would apply one product's cost to another.
//   * A rate already entered is NEVER touched. Re-running this after
//     tomorrow's labels only appends genuinely new SKUs.
//   * Placeholder SKUs the parsers invent when a label has none
//     ("Unknown SKU", "Amazon-Product", an IN-xxx invoice ref) are
//     skipped — they are not real products.
// ── findBadAwbOrders ─────────────────────────────────────────
// Orders whose stored "AWB" cannot possibly be a waybill, so scanning
// the parcel can never match them.
//
// These come from labels imported before the phone-as-AWB bugs were
// fixed (Meesho first, then Flipkart/Ekart). A dispatch reconciliation
// on 27 Aug found 21 such orders sitting in Ready to Ship — they look
// like un-dispatched stock but no amount of scanning will ever clear
// them, which quietly corrupts the "how much is pending" number every
// single day.
//
// Reported, never auto-changed: the right AWB only exists on the
// original label, so the fix is to re-import that label PDF (or type
// the number in). Guessing here would be worse than saying nothing.
export function findBadAwbOrders(orders) {
  const out = [];
  for (const o of orders || []) {
    if (o.deleted) continue;
    const awb = String(o.awb || '').trim();
    if (!awb) { out.push({ ...o, awbIssue: 'No AWB stored' }); continue; }
    if (/^IN-\d+$/i.test(awb)) {
      out.push({ ...o, awbIssue: 'Invoice reference only — actual shipping AWB is missing. Re-import with OCR available.' });
      continue;
    }
    const digits = awb.replace(/\D/g, '');
    if (/^(?:91)?[6-9]\d{9}$/.test(digits) && !/[A-Za-z]/.test(awb)) {
      out.push({ ...o, awbIssue: "Customer's phone number saved as AWB" });
      continue;
    }
    const known =
      /^1490\d{12}$/.test(awb) ||          // Meesho Delhivery
      /^SF\d{7,13}FPL$/i.test(awb) ||      // Meesho Shadowfax
      /^R\d{9,12}FPL$/i.test(awb) ||       // Shadowfax return
      /^(?:FMPP|FMPC|FM[A-Z])\d{8,15}$/i.test(awb) || // Ekart
      /^\d{12}$/.test(awb) ||              // Amazon
      /^\d{13,16}$/.test(awb) ||           // Delhivery / Xpress Bees / bare Ekart
      /^[A-Z]{2}\d{9}IN$/i.test(awb) ||    // India Post
      /^IN-\d+$/i.test(awb);               // invoice-ref placeholder
    if (!known) out.push({ ...o, awbIssue: `Unrecognised AWB format (${awb.length} chars)` });
  }

  // ── Two orders sharing one AWB ──────────────────────────────────────
  // WHY (Sep 2026): an OCR misread on an Amazon label produced a
  // well-formed 12-digit AWB that happened to be the REAL AWB of another
  // order in the same batch. Every shape check above passes for both
  // orders, so nothing flagged it — yet scanning that parcel at dispatch
  // would mark whichever order the lookup happened to hit, and the other
  // parcel could never be dispatched at all. A waybill is unique by
  // definition, so a repeat is always a data fault worth surfacing.
  const byAwb = new Map();
  for (const o of orders || []) {
    if (o.deleted) continue;
    const a = String(o.awb || '').trim().toUpperCase();
    if (!a) continue;
    if (!byAwb.has(a)) byAwb.set(a, []);
    byAwb.get(a).push(o);
  }
  const already = new Set(out.map((o) => o.id));
  for (const [a, group] of byAwb) {
    if (group.length < 2) continue;
    const others = group.map((g) => g.orderId).join(', ');
    for (const o of group) {
      if (already.has(o.id)) continue;
      out.push({ ...o, awbIssue: `Same AWB (${a}) stored on ${group.length} orders: ${others}` });
    }
  }
  return out;
}

export function syncSkusFromOrders(orders, products) {
  const PLACEHOLDER = /^(unknown sku|amazon-product|in-\d+|)$/i;
  const existing = new Set(
    (products || []).map((p) => (p.sku || '').trim()).filter(Boolean)
  );
  const seen = new Set();
  const added = [];
  for (const o of orders || []) {
    if (o.deleted) continue;
    const raw = (o.sku || '').trim();
    const key = raw;                        // exact match — case included
    if (!raw || PLACEHOLDER.test(raw) || existing.has(key) || seen.has(key)) continue;
    seen.add(key);
    added.push({
      id: genId(),
      sku: raw,
      category: '',
      rate: 0,
      stockQuantity: 0,
      autoAdded: true,          // so the UI can show "rate not set yet"
      createdAt: new Date().toISOString(),
    });
  }
  return added;
}

// ── findLookalikeSkus ────────────────────────────────────────
// SKU rows that are different by the exact-match rule but would look
// identical to a human: same letters, different case or spacing
// ("PUNCH NEEDLE" vs "Punch Needle", "AARI-01" vs "AARI 01").
//
// Exact matching is what was asked for, and it is the safe default —
// but it means a typo in a listing quietly becomes a second product
// with its own rate, and half the orders then get the wrong cost. So
// the rows are never merged automatically; they are just surfaced on
// the Purchase Rates page so a real duplicate can be spotted and
// deleted, while genuinely different codes are left alone.
export function findLookalikeSkus(products) {
  const groups = new Map();
  for (const p of products || []) {
    const sku = (p.sku || '').trim();
    if (!sku) continue;
    const key = sku.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

export function buildProfitRows(orders, payments, products, { countReturnedStockAsCost = false, businessRecords = [] } = {}) {
  const active = (orders || []).filter((o) => !o.deleted);
  const paymentByOrderId = new Map((payments || []).map((p) => [p.orderId, p]));
  // Exact SKU match, same rule as syncSkusFromOrders: one letter of
  // difference is a different product, so it must not borrow another
  // SKU's purchase rate.
  const rateBySku = new Map((products || [])
    .filter(p => Number.isFinite(Number(p.rate)) && Number(p.rate) > 0)
    .map(p => [(p.sku || '').trim(), Number(p.rate)]));

  const rows = [];
  for (const o of active) {
    const payment = paymentByOrderId.get(o.orderId);
    if (!payment) continue; // not reconciled yet — no net amount to compute profit from

    const skuKey = (o.sku || '').trim();
    const hasRate = rateBySku.has(skuKey) && skuKey !== '';
    const rate = hasRate ? rateBySku.get(skuKey) : null;
    const qty = o.quantity || 1;
    const netReceived = payment.netAmount || 0;
    const stockReturned = RETURNED_STOCK_STATUSES.includes(o.status || '');
    const manualLoss = Math.max(0, Number(o.manualLoss) || 0);
    const costCounts = !stockReturned || (countReturnedStockAsCost && manualLoss === 0);
    const purchaseCost = !costCounts ? 0 : hasRate ? rate * qty : null;
    const orderExpense = businessRecords.filter(r=>r.kind==='expense' && !r.voided && r.orderId===o.orderId).reduce((a,r)=>a+(Number(r.amount)||0),0);
    const profit = purchaseCost !== null ? Math.round((netReceived - purchaseCost - manualLoss - orderExpense) * 100) / 100 : null;
    const marginPct = (hasRate && netReceived > 0) ? (profit / netReceived) * 100 : null;

    rows.push({
      id: o.id, orderId: o.orderId, customer: o.customer, channel: o.channel || 'Unknown',
      sku: o.sku || 'Unknown SKU', quantity: qty,
      settlement: payment.settlement || 0, gstAmount: payment.gstAmount || 0,
      netReceived, purchaseRate: rate, purchaseCost, manualLoss, orderExpense, company: o.company, profit, marginPct,
      rateMissing: costCounts && !hasRate,
      stockReturned,
      status: o.status || '',
      returnType: o.return_type || '',
      orderDate: o.orderDate || '',
    });
  }
  return rows;
}
// Same idea as buildCourierBreakdown/flattenCourierBreakdown above, just
// grouped by SKU instead of courier, so high-return SKUs surface for
// inventory and listing decisions.

// "Dispatched" = the order has ever been handed to a courier, i.e. its
// current status is Dispatched or further down the pipeline. "Ready to
// Ship" orders never left the warehouse, so they can't count toward a
// return rate for that SKU.
// Orders that have been dispatched or moved further in the process
const DISPATCHED_OR_BEYOND = [
  'Dispatched',
  'Return In-Transit',
  'In Transit (Return)',
  'Return Received',
];

// Orders that count as returns
const RETURN_STATUSES = [
  'Return In-Transit',
  'In Transit (Return)',
  'Return Received',
];

export function buildReturnAnalytics(orders) {
  const active = (orders || []).filter((o) => !o.deleted);

  const tree = {};
  // {
  //   [channel]: {
  //     [sku]: {
  //       dispatched,
  //       returned,
  //       byReason
  //     }
  //   }
  // }

  for (const o of active) {
    const status = o.status || '';

    // Skip orders that were never dispatched
    if (!DISPATCHED_OR_BEYOND.includes(status)) continue;

    const channel = o.channel || 'Unknown';
    const sku = o.sku || 'Unknown SKU';

    if (!tree[channel]) {
      tree[channel] = {};
    }

    if (!tree[channel][sku]) {
      tree[channel][sku] = {
        dispatched: 0,
        returned: 0,
        byReason: {},
      };
    }

    const bucket = tree[channel][sku];

    // Every dispatched order counts once
    bucket.dispatched += 1;

    // Return count
    if (RETURN_STATUSES.includes(status)) {
      bucket.returned += 1;

      // Support both old and new field names
      const rawReason = o.return_reason || o.returnReason || '';

      // Second line of defence for the vanishing-reasons bug fixed in
      // Returns.jsx: the Return Analytics table only has columns for
      // RETURN_REASONS + "Not Tagged", so any other value would be
      // tallied under a key that nothing renders and disappear from the
      // report. Anything unrecognised now lands in "Not Tagged", which
      // is visible — so the reason columns always add up to the return
      // count, including for orders imported before that fix.
      const reason = RETURN_REASONS.includes(rawReason) ? rawReason : 'Not Tagged';

      bucket.byReason[reason] =
        (bucket.byReason[reason] || 0) + 1;
    }
  }

  return tree;
}

// Flattens buildReturnAnalytics()'s nested tree into SKU-level rows — the
// literal [Platform] -> [SKU] -> [Return Reason: count] shape, ready for a
// table, chart, or export. Sorted with the highest return rate first so
// the SKUs that most need attention show up on top; never throws on a SKU
// with zero returns (returnRate simply reads as 0).
export function flattenReturnAnalytics(orders) {
  const tree = buildReturnAnalytics(orders);
  const reasonCols = [...RETURN_REASONS, 'Not Tagged'];
  const rows = [];
  for (const channel of Object.keys(tree)) {
    for (const sku of Object.keys(tree[channel])) {
      const b = tree[channel][sku];
      rows.push({
        channel, sku,
        dispatched: b.dispatched,
        returned: b.returned,
        returnRate: b.dispatched > 0 ? (b.returned / b.dispatched) * 100 : 0,
        byReason: reasonCols.reduce((acc, r) => { acc[r] = b.byReason[r] || 0; return acc; }, {}),
      });
    }
  }
  return rows.sort((a, b) => b.returnRate - a.returnRate);
}
