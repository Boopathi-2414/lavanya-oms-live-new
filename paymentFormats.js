// ============================================================
// MARKETPLACE PAYMENT FILE PARSERS
// ============================================================
// One place that turns a Meesho, Flipkart or Amazon payout file into the
// same normalised shape, so Payments.jsx never has to care which
// marketplace a file came from:
//
//   { orderId, settlement, taxableValue, gstPct, gstAmount, date, source }
//
//   settlement   — money that actually reaches the bank for this order
//   taxableValue — the sale value GST is charged on (GST-inclusive)
//   gstAmount    — GST contained in taxableValue
//
// Two rules apply to every format:
//
//  1. ROWS ARE AGGREGATED PER ORDER. All three marketplaces write more
//     than one line for the same order — Meesho a Shipped line plus a
//     Return/Exchange line, Amazon an "Order" line plus "Shipping
//     Services" and "Refund" lines, Flipkart a sale line plus a refund
//     line. Reading only the first line and skipping the rest (what the
//     Meesho-only importer used to do) leaves the settlement wrong: on
//     the real July files that produced ₹9,63,892 against a true file
//     total of ₹9,62,674. Summing the lines makes a returned order net
//     to zero by itself, which is exactly right.
//
//  2. GST IS TAKEN FROM THE SALE VALUE, NEVER FROM THE PAYOUT. The
//     marketplace's commission does not reduce the seller's GST
//     liability, so computing GST from the settled amount understates it
//     and overstates profit.
import * as XLSX from 'xlsx';
import { money, summarizeTransactions } from './paymentLedger.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const num = (v) => {
  if (v === null || v === undefined) return 0;
  const n = parseFloat(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
// Find the row that actually holds the column headings, skipping the
// supplier-panel / disclaimer preamble every one of these exports has.
function findHeaderRow(sheet, patterns, maxScan = 20) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
    const cells = (rows[i] || []).map(norm);
    if (patterns.some((re) => cells.some((c) => re.test(c)))) return i;
  }
  return 0;
}
function col(row, patterns) {
  for (const re of patterns) {
    for (const k of Object.keys(row)) if (re.test(norm(k))) return row[k];
  }
  return '';
}
// A cell that exists but holds the NUMBER 0 is a real value.
//
// BUG THIS FIXES (Sep 2026): the two checks below used to be written
// `String(col(row, X) || '').trim() !== ''`. In JavaScript `0 || ''` is
// `''`, so a numeric zero read as "this column isn't in the file":
//   • a fully-returned order's return line has Total Sale Amount = 0, so
//     the row silently fell back to using the SETTLEMENT as its taxable
//     value. Measured on 150 returned orders: taxable came out as
//     sale + (−settlement) instead of sale + sale-return — e.g. ₹23.58
//     where it should have been ₹0 — and GST was charged on it.
//   • a genuinely 0% GST catalogue (supplier 3375073) read as "no rate
//     stated", so the Flipkart fallback rate was applied to it and
//     invented a tax that is not owed.
const filled = (v) => v !== null && v !== undefined && String(v).trim() !== '';
function has(row, patterns) {
  for (const re of patterns) {
    for (const k of Object.keys(row)) if (re.test(norm(k))) return true;
  }
  return false;
}

// Stable identity excludes filename/row number so overlapping exports deduplicate.
// Two identical rows in a file retain their multiplicity via occurrence number.
function rowMetadata(row, sheet, rowNumber) {
  const canonical = JSON.stringify(Object.entries(row).map(([k, v]) => [norm(k), String(v ?? '').trim()]).sort((a,b) => a[0].localeCompare(b[0])));
  let a=2166136261,b=2246822519,c=3266489917,d=668265263;
  for (let i=0;i<canonical.length;i++) {const n=canonical.charCodeAt(i);a=Math.imul(a^n,16777619);b=Math.imul(b^n,2246822519);c=Math.imul(c^n,3266489917);d=Math.imul(d^n,668265263);}
  const fingerprint=[a,b,c,d].map(n=>(n>>>0).toString(16).padStart(8,'0')).join('');
  const reason=String(col(row,[/reason/,/^description$/,/transactiontype/,/^type$/]) || '').trim();
  const transactionRef=String(col(row,[/^transactionid$/,/transactionreference/,/^neftid$/,/settlementid/]) || '').trim();
  const deductions=Object.entries(row).filter(([k,v]) => !/^(total|finalsettlementamount|settlementamount|banksettlementvalue.*|netamount)$/.test(norm(k)) && num(v)<0 && /^[-₹\d,.\s]+$/.test(String(v))).map(([label,v])=>({label,amount:num(v)}));
  return {fingerprint,reason,transactionRef,deductions,sourceSheet:sheet,sourceRow:rowNumber};
}

// ── Format detection ─────────────────────────────────────────
export function detectPaymentFormat(wb) {
  const names = wb.SheetNames.map((n) => n.toLowerCase());
  if (names.some((n) => /order\s*payments/.test(n))) return 'meesho';
  if (names.includes('orders') && names.some((n) => /gst_details|mp fee rebate|tcs_recovery/.test(n))) return 'flipkart';
  for (const n of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' }).slice(0, 25);
    const flat = rows.map((r) => r.map(norm).join('|'));
    if (flat.some((l) => l.includes('settlementid') && l.includes('orderid'))) return 'amazon';
    if (flat.some((l) => l.includes('suborderno'))) return 'meesho';
    if (flat.some((l) => l.includes('banksettlementvalue'))) return 'flipkart';
  }
  return 'generic';
}

// ── Meesho ───────────────────────────────────────────────────
// "Order Payments" sheet. Taxable value = Total Sale Amount + Total Sale
// Return Amount (Meesho's own B + C — the return column is negative, so
// a fully returned order nets to zero and attracts no GST).
function parseMeesho(wb) {
  const sheetName = wb.SheetNames.find((n) => /order\s*payments/i.test(n)) || wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const OID = [/^(sub)?order(id|no|number)$/, /suborderno/];
  const hdr = findHeaderRow(sheet, OID);
  const data = XLSX.utils.sheet_to_json(sheet, { defval: '', range: hdr });
  const SETTLE = [/finalsettlementamount/, /settlement/];
  const GSTP   = [/productgst/, /gst%/, /^gst$/];
  const SALE   = [/^totalsaleamount/, /totalsaleamount/];
  const SALERET= [/^totalsalereturnamount/, /totalsalereturnamount/];
  const DATE   = [/paymentdate/, /settlementdate/];
  const out = [];
  for (const [rowIndex, row] of data.entries()) {
    const orderId = String(col(row, OID) || '').trim();
    if (!orderId || !/\d/.test(orderId)) continue;
    // Does the FILE carry a sale-amount column at all? That — not
    // whether this particular line happens to be non-zero — is what
    // decides between the sale basis and the old settlement basis.
    const hasSale = has(row, SALE);
    // A stated rate of 0 is a real rate — several of this seller's
    // catalogues are genuinely 0% GST. It must NOT be mistaken for "the
    // file didn't say", or the fallback rate would be applied to
    // zero-rated goods and invent a tax that isn't owed.
    const gstStated = filled(col(row, GSTP));
    out.push({
      ...rowMetadata(row, sheetName, hdr + rowIndex + 2),
      orderId,
      settlement: num(col(row, SETTLE)),
      taxableValue: hasSale ? num(col(row, SALE)) + num(col(row, SALERET)) : num(col(row, SETTLE)),
      gstPct: num(col(row, GSTP)),
      gstStated,
      gstAmount: null,          // derived from gstPct below
      date: col(row, DATE) || '',
      source: 'Meesho',
    });
  }
  return out;
}

// ── Flipkart ─────────────────────────────────────────────────
// "Orders" sheet: Bank Settlement Value is the payout, Sale Amount is
// the GST-inclusive sale, Refund is negative on a returned order.
// Prefer Item GST Rate in Orders when supplied. Some report versions
// omit it; only those rows use the user's fallback rate.
function parseFlipkart(wb) {
  const sheetName = wb.SheetNames.find((n) => /^orders$/i.test(n)) || wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const OID = [/^orderid$/, /orderid/];
  const hdr = findHeaderRow(sheet, [/^orderid$/, /banksettlementvalue/]);
  const data = XLSX.utils.sheet_to_json(sheet, { defval: '', range: hdr });
  const SETTLE = [/banksettlementvalue/, /settlementvalue/];
  const SALE   = [/^saleamountrs$/, /^saleamount/, /saleamount/];
  const REFUND = [/^refundrs$/, /^refund/];
  const DATE   = [/paymentdate/];
  const GSTP   = [/^itemgstrate/, /^productgst/];
  const out = [];
  for (const [rowIndex, row] of data.entries()) {
    const orderId = String(col(row, OID) || '').trim();
    if (!/^OD\d{10,}/i.test(orderId)) continue;   // skips the sub-header rows
    out.push({
      ...rowMetadata(row, sheetName, hdr + rowIndex + 2),
      orderId,
      settlement: num(col(row, SETTLE)),
      taxableValue: num(col(row, SALE)) + num(col(row, REFUND)),
      gstPct: num(col(row, GSTP)), gstStated: filled(col(row, GSTP)),
      gstAmount: null,
      date: col(row, DATE) || '',
      source: 'Flipkart',
    });
  }
  return out;
}

// ── Amazon ───────────────────────────────────────────────────
// The Unified Transaction report. Easiest of the three: it states the
// GST as an AMOUNT ("Total sales tax liable"), so no percentage maths is
// needed. `product sales` is the value BEFORE GST, so the GST-inclusive
// taxable value is product sales + that tax. `total` is the net payout
// for the line, and Shipping Services / Refund lines carry their own
// totals for the same order — which is why the aggregation step matters.
function parseAmazon(wb) {
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const hdr = findHeaderRow(sheet, [/^settlementid$/, /^datetime$/], 30);
  const data = XLSX.utils.sheet_to_json(sheet, { defval: '', range: hdr });
  const OID    = [/^orderid$/];
  const SALES  = [/^productsales$/];
  const SHIPCR = [/^shippingcredits$/];
  const TAX    = [/^totalsalestaxliable/, /salestaxliable/];
  const TOTAL  = [/^total$/];
  const DATE   = [/^datetime$/, /transactionreleasedate/];
  const out = [];
  for (const [rowIndex, row] of data.entries()) {
    const orderId = String(col(row, OID) || '').trim();
    if (!/^\d{3}-\d{7}-\d{7}$/.test(orderId)) continue;  // real Amazon order ids only
    const gst = num(col(row, TAX));
    out.push({
      ...rowMetadata(row, sheetName, hdr + rowIndex + 2),
      orderId,
      settlement: num(col(row, TOTAL)),
      taxableValue: num(col(row, SALES)) + num(col(row, SHIPCR)) + gst,
      gstPct: 0, gstStated: true,
      gstAmount: gst,          // stated directly by Amazon
      date: col(row, DATE) || '',
      source: 'Amazon',
    });
  }
  return out;
}

// ── Generic / hand-made sheet ────────────────────────────────
function parseGeneric(wb) {
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const OID = [/^(sub)?order(id|no|number)$/];
  const hdr = findHeaderRow(sheet, OID);
  const data = XLSX.utils.sheet_to_json(sheet, { defval: '', range: hdr });
  const SETTLE = [/settlement/, /^amount$/];
  const GSTP   = [/gst/, /^tax/];
  const DATE   = [/paymentdate/, /settlementdate/, /^date$/, /date/];
  const out = [];
  for (const [rowIndex, row] of data.entries()) {
    const orderId = String(col(row, OID) || '').trim();
    if (!orderId) continue;
    const s = num(col(row, SETTLE));
    out.push({
      ...rowMetadata(row, sheetName, hdr + rowIndex + 2),
      orderId, settlement: s, taxableValue: s,
      gstPct: num(col(row, GSTP)), gstStated: filled(col(row, GSTP)), gstAmount: null,
      date: col(row, DATE) || '', source: 'Sheet',
    });
  }
  return out;
}

// ── Public entry point ───────────────────────────────────────
// `fallbackGstPct` is applied only to rows whose file gives neither a
// GST rate nor a GST amount (Flipkart's report, mainly).
export function parsePaymentWorkbook(wb, { fallbackGstPct = 0 } = {}) {
  const format = detectPaymentFormat(wb);
  const raw = format === 'meesho' ? parseMeesho(wb)
    : format === 'flipkart' ? parseFlipkart(wb)
    : format === 'amazon' ? parseAmazon(wb)
    : parseGeneric(wb);

  let usedFallback = 0, missingGstCount = 0;
  const groups = new Map(), occurrences = new Map();
  for (const r of raw) {
    let gstPct=r.gstPct;
    if (!r.gstStated && r.gstAmount == null) {
      missingGstCount++;
      if (fallbackGstPct > 0) {gstPct=fallbackGstPct;usedFallback++;}
    }
    // Preserve negative sale/refund tax. Do not clamp refund periods to zero.
    const gstAmount=money(r.gstAmount != null ? r.gstAmount : r.taxableValue * gstPct / (100 + gstPct));
    const settlement=money(r.settlement);
    const occurrence=(occurrences.get(r.fingerprint)||0)+1;
    occurrences.set(r.fingerprint,occurrence);
    const excelDate=typeof r.date==='number' ? XLSX.SSF.parse_date_code(r.date) : null;
    const date=excelDate ? `${excelDate.y}-${String(excelDate.m).padStart(2,'0')}-${String(excelDate.d).padStart(2,'0')}` : r.date;
    const tx={...r, date, gstPct, gstAmount, settlement, netAmount:money(settlement-gstAmount),
      key:`${r.source}:${r.fingerprint}:${occurrence}`, identityBasis:'source-row-content'};
    if (!groups.has(r.orderId)) groups.set(r.orderId,[]);
    groups.get(r.orderId).push(tx);
  }
  const rows=[...groups].map(([orderId, transactions])=>({orderId,source:transactions[0].source,
    ...summarizeTransactions(transactions),lines:transactions.length}));
  return {format,rows,usedFallback,missingGstCount,rawLines:raw.length};
}
