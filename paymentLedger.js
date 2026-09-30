// Payment amounts are rounded once per transaction to paise, then summed.
export function money(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.sign(n) * Math.round((Math.abs(n) + Number.EPSILON * Math.max(1, Math.abs(n))) * 100) / 100;
}
export const sumMoney = (rows, field) => rows.reduce((sum, row) => sum + Math.round(money(row[field]) * 100), 0) / 100;

export function paymentMonth(date) {
  if (typeof date === 'number' && date > 20000 && date < 100000) {
    return new Date(Math.round((date - 25569) * 86400000)).toISOString().slice(0, 7);
  }
  const s = String(date || '').trim();
  const iso = s.match(/^(\d{4})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const indian = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (indian) return `${indian[3]}-${indian[2].padStart(2, '0')}`;
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? 'Unknown' : `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}`;
}

export function summarizeTransactions(transactions) {
  const settlement = sumMoney(transactions, 'settlement');
  const gstAmount = sumMoney(transactions, 'gstAmount');
  const rates = [...new Set(transactions.map(t => t.gstPct))];
  return { settlement, gstAmount, taxableValue: sumMoney(transactions, 'taxableValue'),
    netAmount: money(settlement - gstAmount), gstPct: rates.length === 1 ? rates[0] : null,
    date: transactions[0]?.date || '', gstBasis: 'transactions', transactions };
}

// Old aggregate-only payments have no transaction identity. Never add a file
// blindly to those totals: that can double count an already imported payout.
export function mergePaymentTransactions(existing, incoming) {
  if (existing && !Array.isArray(existing.transactions)) return { blockedLegacy: true, payment: existing, added: 0 };
  const transactions = [...(existing?.transactions || [])];
  const known = new Set(transactions.map(t => t.key));
  let added = 0;
  for (const t of incoming.transactions || []) {
    if (known.has(t.key)) continue;
    known.add(t.key); transactions.push(t); added++;
  }
  if (existing && added === 0) return { payment: existing, added: 0 };
  return { payment: { ...existing, ...summarizeTransactions(transactions) }, added };
}

export function paymentMonthlySummary(payments) {
  const groups = new Map();
  for (const p of payments || []) {
    for (const t of p.transactions || [p]) {
      const month = paymentMonth(t.date);
      if (!groups.has(month)) groups.set(month, []);
      groups.get(month).push(t);
    }
  }
  return [...groups].map(([month, tx]) => [month, { count: tx.length, ...summarizeTransactions(tx) }])
    .sort((a, b) => b[0].localeCompare(a[0]));
}
