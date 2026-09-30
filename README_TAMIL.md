# முதலில் படிக்கவும் — RC4

முழு source package. புதிய claims / server backup changes உட்பட. முன்னைய RC3 installation repair உள்ளது.

1. புதிய folder-இல் ZIP Extract செய்யவும்; பழைய TEST `.env`-ஐ copy செய்யவும்.
2. `VITE_AUTHORIZED_UID` உள்ளிட்ட `.env.example` fields நிரப்பப்பட்டுள்ளதா பார்க்கவும்.
3. TEST database-இல் `deploy/001_business_records.sql` முன்பே இயக்கியிருந்தால் மீண்டும் தேவையில்லை. வேறு project என்றால் UID policy மாற்றி administrator மூலம் பயன்படுத்தவும்.
4. `REPAIR_WINDOWS.cmd` இயக்கவும் (Node 22, internet தேவை).
5. Business Workspace → Claims-இல் submission deadline மற்றும் pending claim-க்கு next follow-up date பதிவு செய்யவும்.
6. Google Drive backup இன்னும் இயங்காது. VPS administrator-க்கு `deploy/backup/SETUP_TAMIL.md` கொடுக்கவும்.

முழு handover நிலை: `HANDOVER_TAMIL.md`. Windows/live database/VPS/scanner acceptance tests அடுத்த கட்டம்.

---

# Lavanya OMS 6.15.0 RC4

இது முழு web application source ZIP. புதிய அம்சங்கள் கொண்ட release candidate; live VPS / live multi-user / physical scanner இறுதி ஒப்புதல் இன்னும் கிடைக்கவில்லை. பழைய production software-ஐ உடனடியாக மாற்ற வேண்டாம்.

## முக்கிய மாற்றங்கள்

- Pickup Dashboard: dispatch செய்த வரலாறு return ஆனாலும் குறையாது. Return transit status mapping, இந்திய தேதி கணக்கு சரி செய்யப்பட்டது.
- 396-order export சரிபார்ப்பு: Amazon 2 + Flipkart 2 + Shadowfax 168 + Delhivery 193 = 365 dispatch. Pending 31; return transit 95; received 7.
- Navy / teal / white theme. Business Workspace → Brand-ல் உங்கள் PNG/JPEG/WebP logo upload செய்யலாம் (300 KB வரை). நீங்கள் வழங்கிய Lavanya’s Mart logo மாற்றமின்றி login மற்றும் sidebar-ல் சேர்க்கப்பட்டுள்ளது.
- ஒரே பொதுவான SKU stock: physical opening count, purchase receipt, dispatch கழித்தல், Return QC-ல் நல்ல பொருள் மட்டும் சேர்த்தல்; damaged quantity தனியாகக் கணக்கு.
- SKU filter, equal allocation பழைய Purchase Rates பகுதியில் தொடர்கிறது. அதிலும் இப்போது live derived stock காட்டப்படும்.
- Low-stock / reorder: கடந்த 30 நாள் dispatch அளவு, supplier lead days, safety stock அடிப்படையில் பரிந்துரை. 60 நாட்களில் dispatch இல்லாத stock slow-moving எனக் காட்டப்படும்.
- Today dashboard: pending dispatch, unpaid dispatched orders, return transit, inspection pending, claim due, reorder.
- Claims: order, reason, deadline, requested, received, remaining, status, evidence URL, claim reference, edit history.
- Expenses: packing, rent, salary, ads உள்ளிட்ட செலவுகள். Order expenses அந்த order profit-ல்; பிற company expenses overall profit-ல். Business Workspace company breakdown-ல் அனைத்துச் செலவுகளும் கணக்கிடப்படும்.
- Bank comparison: selected orders-ன் cumulative settlement vs bank credit; ₹1 வித்தியாசமும் தெரியும்.
- Supplier receipt / rejected quantity / late delivery / price history.
- Staff attendance: நாள் ஒன்றுக்கு ஊழியருக்கு ஒரு பதிவு; திருத்த history.
- Backup: முழு JSON, automatic local latest-synced recovery copy, import-க்கு முன் local copy, restore preview. Restore missing IDs மட்டும் சேர்க்கும்; ஏற்கெனவே உள்ள பதிவை overwrite செய்யாது.
- Excel report-ல் nested data blank ஆகாது. PaymentTransactions தனி sheet. மிகப் பெரிய JSON cell-க்கு full JSON backup பயன்படுத்த வேண்டும்.
- Damage புதிய return import-ல் Quality Issue-யிலிருந்து தனியாக வகைப்படுத்தப்படும். பழைய Quality Issue records ஆதாரம் இல்லாமல் மாற்றப்படவில்லை.

## இப்போது உங்கள் கணினியில் test செய்ய

1. பழைய app-ல் Export All எடுத்துப் பாதுகாக்கவும். பழைய ZIP/folder-ஐ வைத்திருக்கவும்.
2. புதிய ZIP-ஐ புதிய folder-ல் extract செய்யவும். பழைய folder-க்கு மேலே copy செய்ய வேண்டாம்.
3. Supabase TEST project SQL Editor-ல் `deploy/001_business_records.sql`-ஐ இயக்கவும். இது புதிய business table மட்டும் உருவாக்கும்; பழைய orders/payments-ஐ மாற்றாது. UID தற்போதைய test admin-க்கே அமைக்கப்பட்டுள்ளது.
4. `.env.example`-ஐ `.env` என்று copy செய்யவும். பழைய test `.env`-இன் URL/public key-ஐ அமைக்கவும். `VITE_AUTHORIZED_UID=31f9ac9d-ba24-475a-831f-694e454c8de6`; `VITE_ENVIRONMENT=test`.
5. Node.js 22 கொண்ட கணினியில் `START_WINDOWS.cmd` திறக்கவும். அல்லது folder CMD-ல் `npm ci`, பிறகு `npm run dev`.
6. http://localhost:5174 திறந்து test admin login செய்யவும். பழைய 5174 app ஓடினால் அதை மட்டும் Ctrl+C மூலம் நிறுத்த வேண்டும்; production app-ஐ நிறுத்த வேண்டாம்.
7. Dashboard refresh செய்து cloud sync வெற்றி உறுதிப்படுத்தவும். Business table migration இல்லாவிட்டால் cloud load தோல்வியடையும்.
8. முதலில் 2 SKU physical stock count கொடுத்து test purchase / dispatch / return QC செய்து பார்க்கவும். Opening count-ல் ஏற்கெனவே உள்ள பொருட்களுக்கு வரலாற்று purchase-ஐ மீண்டும் பதிவு செய்ய வேண்டாம்.

## Stock / profit பயன்படுத்தும் விதம்

- எல்லா 4 companies-க்கும் exact SKU ஒன்றே என்றால் ஒரே stock. ஒரே physical product-க்கு 6 வேறு SKU இருந்தால் equal allocation மூலம் மொத்த stock-ஐ பகிரவும். 6 SKU-க்கும் ஒரே மொத்த எண்ணை copy செய்தால் stock அதிகமாகக் காட்டும்.
- Stock tracking count கொடுத்த நேரத்திலிருந்து தொடங்கும். பழைய dispatch-ஐ மீண்டும் கழிக்காது. புதிய dispatch தானாகக் கழியும். ஒரு order-ன் தற்போதைய dispatch நிகழ்வு ஒருமுறை மட்டுமே கணக்கிடப்படும்.
- Return received மட்டும் stock-ல் சேராது; Return QC-ல் inspection செய்ய வேண்டும். Count செய்யும்போது QC செய்யாத parcels-ஐ sellable opening count-ல் சேர்க்க வேண்டாம்.
- Wrong/empty/damaged item loss = item loss மட்டும். ₹165 shipping charge payment settlement-ல் இருந்தால் manual loss-ல் மீண்டும் போட வேண்டாம்.
- Claim tracker received field-ஐ மாற்றுவதால் payment உருவாகாது. அதே claim credit payment report-ல் import ஆக வேண்டும்; இதனால் duplicate profit வராது. -165 + 50 = -115; -165 + 400 -100 item loss = +135.
- Purchase receipt unit cost historical supplier record. Profit valuation Purchase Rates master-இலிருந்தே வருகிறது; purchase receipt rate பழைய order profit-ஐ தானாக மாற்றாது.
- Missing purchase rates இருந்தால் முழுமையான profit கிடையாது. Business Workspace total all expenses-ஐக் கழிக்கும்; Profit Analysis settled orders மட்டுமே காட்டும்.
- Expense பதிவு செய்யும் முன் settlement-ல் ஏற்கெனவே அந்தச் செலவு கழிக்கப்பட்டதா பாருங்கள்; மீண்டும் பதிவு செய்தால் duplicate expense ஆகும்.

## இன்னும் வெளியீட்டு வரம்புகள்

- Physical scanner speed, actual authenticated Supabase writes, VPS HTTPS deployment, பல சாதனங்களில் simultaneous changes ஆகியவை இந்த release-ல் live சோதிக்கப்படவில்லை.
- Negative available stock எச்சரிக்கை மட்டுமே. Server-side stock reservation / atomic oversell prevention இல்லை. ஒரே order அல்லது physical count-ஐ பல சாதனங்களில் ஒரே நேரத்தில் மாற்ற வேண்டாம்.
- ஒரே parcel-ன் repeated exchange / redispatch stock movement cycles தனித்த movement ledger ஆக இன்னும் இல்லை.
- Marketplace நேரடி API integration / automated cancellation / listing stock push இல்லை. File imports மற்றும் பொதுவான stock view உள்ளது.
- Claim photo/video direct storage upload இல்லை; evidence HTTPS link இணைக்கலாம். Company logo upload உள்ளது.
- Attendance உள்ளது; payroll / employee-wise permissions இல்லை. இந்த build ஒரு authorised admin account-க்காக அமைக்கப்பட்டுள்ளது.
- Bank comparison complete cumulative order settlement-க்கானது; split-period payouts, Order ID இல்லாத platform fees முழுமையாக auto-match ஆகாது.
- Browser backup சாதனத்தில்தான் இருக்கும். Off-site scheduled database backup-ஐ VPS/Supabase நிர்வாகி தனியாக அமைக்க வேண்டும். JSON download செய்து வேறு இடத்தில் பாதுகாக்கவும்.
- Recovery existing IDs-ஐ rollback செய்யாது. Full destructive restore இந்த UI-ல் இல்லை.
- Historical data auto-delete / auto-migration / production deployment செய்யப்படவில்லை.

## சோதனை நிலை

`npm test` — stock, date, backup, claim profit, invalid input, damage mapping unit tests.
`tests/pickup-export-results.json` — உங்கள் 396-order export-ன் read-only கணக்கு.
`tests/browser-results.json` — local browser mock Supabase workflow result; live cloud test அல்ல.
`npm run build` — successful build. PDF library eval / large bundle warnings இன்னும் உள்ளன; இது dependency/security audit முடிந்ததாக அர்த்தமல்ல.

VPS-க்கு `deploy/VPS_SETUP.md` படிக்கவும். Logo, VPS operating system, domain கிடைத்தபின் deployment-specific configuration உறுதி செய்யலாம்.

## RC2 — Claim calendar
நான்கு company வாரியாகவும் deadline வாரியாகவும் To submit / Follow up count, requested amount, remaining amount பார்க்கலாம். Today / company / date filters உள்ளன. Company order-இலிருந்து வரும். Marketplace deadline-ஐ நீங்கள் பதிவு செய்ய வேண்டும்; தானாக policy deadline கணிக்கப்படாது. Domain configuration: lavanyaoms.co.in; DNS/TLS/live deployment இன்னும் செய்யப்படவில்லை.


## RC3 installation repair
பழைய dev CMD-இல் Ctrl+C அழுத்தி நிறுத்தவும். புதிய ZIP-ஐ தனி folder-இல் Extract செய்யவும். பழைய TEST .env-ஐ புதிய folder-க்கு copy செய்யவும். REPAIR_WINDOWS.cmd-ஐ double-click செய்யவும். Internet தேவை; dependencies மீண்டும் நிறுவப்படும். Node.js 22 பயன்படுத்தவும். INSTALL_LOG.txt-இல் installation பிழைகள் பதிவாகும். Cloud data அழிக்கப்படாது. Windows execution நேரடியாகச் சோதிக்கப்படவில்லை.
