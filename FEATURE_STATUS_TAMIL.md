# கேட்ட அம்சங்களின் நிலை — 6.15.0 RC4

இது code + local tests நிலை. Live cloud / VPS / physical scanner / multi-user acceptance இன்னும் நிறைவடையவில்லை.

| கேட்ட அம்சம் | இப்போது உள்ளது | மீதமுள்ளது / வரம்பு |
|---|---|---|
| முழு inventory automation | Physical count, purchase receipt, dispatch deduction, QC good return restock, damaged count; 4 company shared exact SKU | Server-side locking / oversell block, repeated exchange movement cycles இல்லை |
| Reorder / low stock | 30-day dispatch, supplier lead days, safety stock, suggested buy | Supplier-க்கு தானாக purchase order அனுப்பாது |
| இன்றைய வேலை dashboard | Dispatch, unpaid, transit, QC, due claims, reorder | Background push/email reminders இல்லை |
| Claims | 4 company/date schedule, separate submission + follow-up dates, due/overdue/3-day reminders, missing-date review, amounts, evidence link, edit history | Marketplace-க்கு தானாக claim submit ஆகாது. Actual deadline manually பதிவு; direct photo/video storage upload இல்லை |
| Payment reconciliation | Existing payment transaction import/dedup, negative/claim credits, simple bank difference | Split payout periods / orderless fees advanced matching இல்லை |
| Profit + expenses | Order settlement/GST/cost/manual loss, order expenses, company expense totals | Missing cost rates நிரப்ப வேண்டும்; company-wide expense arbitrary allocation செய்யப்படாது |
| Return reasons | RTO/customer counts; Damage category for new imports; SKU return analytics | பழைய Quality Issue data ஆதாரம் இல்லாமல் Damage-ஆக மாற்றப்படவில்லை |
| Dead / slow stock | Stock available and no dispatch in 60 days indication | Offer/combo தானாக marketplace-ல் உருவாக்காது |
| Supplier performance | Accepted/rejected quantity, late receipt, unit-price history | Supplier API integration இல்லை |
| Backup + restore preview | Full JSON, local recovery, Google Drive encrypted server-backup code, 30-day retention, verified download, restore-drill script | VPS/Drive connection + actual backup/restore test pending; Auth/Storage/schema backup separate; destructive rollback இல்லை |
| Attendance | Employee/day status and edit history | Payroll / employee access roles இல்லை |
| Fraud / repeat return | Existing blocklist and repeat-return warning logic retained | புதிய release-ன் real new-label + multi-device acceptance test செய்ய வேண்டும் |
| Logo / theme / domain | Supplied Lavanya’s Mart logo, navy/teal theme, lavanyaoms.co.in proxy config | VPS OS, DNS, HTTPS/live deployment இன்னும் உறுதி செய்யப்படவில்லை |

## அடுத்த சோதனை வரிசை

1. TEST database-ல் SQL migration செய்து RC4 login / refresh / reload.
2. நான்கு company-க்கும் தலா ஒரு TEST claim உருவாக்கி date, count, amount சரிபார்க்கவும். ஒரு claim submitted, ஒரு claim part paid, ஒரு claim closed ஆக்கி pending counts சரிபார்க்கவும். Claim tracker-ன் received field மட்டும் profit-ஐ உயர்த்தக் கூடாது; Payment Entry-ல் credit import ஆனால்தான் உயர வேண்டும்.
3. Attendance: 5 employees, same-day correction, reload persistence.
4. இரண்டு SKU: opening 10, purchase 4, dispatch 2, good return 1 → sellable 13. Damaged return stock-ல் சேரக் கூடாது. Duplicate receive/QC stock-ஐ இருமுறை அதிகரிக்கக் கூடாது.
5. Physical scanner: 10 / 100 rapid scans; refresh, network interruption, reconnect, second-device verification.
6. Multi-device concurrent update risk, database RLS, backup recovery. Server-side locking இல்லாத வரம்பைச் சரிசெய்து/கட்டுப்படுத்தி ஏற்க வேண்டும்.
7. VPS + HTTPS smoke test; test data தனியாக வைத்துப் production தொடங்குதல்.

அக்டோபர் 1 தொடக்க இலக்கு இருந்தாலும், மேற்கண்ட live gates PASS என்று ஆதாரம் இல்லாமல் production-ready என்று குறிக்க முடியாது.
