# Lavanya OMS 6.15.0 RC4 — 28 September 2026

## இந்த package-இல் செய்தவை
- RC3 Supabase dependency pin, install checks, Windows repair launcher தொடர்கிறது.
- நான்கு company claim calendar; submission deadline தனி, next follow-up date தனி; notes/edit history; இன்று/overdue/அடுத்த மூன்று நாட்கள் நினைவூட்டல்; pending submitted claim-க்கு follow-up date கட்டாயம்.
- Claim tracker receipt profit-இல் இருமுறை சேராது; settlement credit Payment Entry வழியாகவே பதிவு செய்ய வேண்டும்.
- Google Drive crypt remote server backup script; eight OMS tables consistent snapshot; SHA256 manifest; upload/download byte verification; verified upload பிறகே 30-day retention.
- Server backup last attempt/success/failure, 36-hour stale warning மற்றும் last restore drill time Business Workspace → Backup-இல்.
- Separate empty test database restore drill: rows insert → counts/content verify → rollback. Production restore அல்ல.
- முன்னைய pickup fixes, logo/theme, shared exact-SKU stock, purchase/QC, attendance, expenses, bank comparison, local backup ஆகியவை தொடர்கின்றன.

## இப்போது சரிபார்த்தவை
Production build; 12 JavaScript logic tests; 6 backup format/integrity/retention unit tests. புதிய அம்சங்களின் live/browser acceptance இந்த சுற்றில் செய்யப்படவில்லை. பழைய RC2 browser results historical மட்டுமே.

## அடுத்த கட்டத்தில் கட்டாயம்
1. உங்கள் Windows PC-இல் RC4 install/login, TEST cloud migration மற்றும் refresh persistence.
2. Claims/attendance/stock/payment/pickup full acceptance.
3. Physical scanner rapid scans, offline/reconnect/duplicate test.
4. VPS OS/IP, DNS/HTTPS, Google OAuth + crypt settings, server database credentials; first verified Drive backup and restore drill.
5. Multi-device stock concurrency: தற்போதும் server-side atomic stock locking / oversell prevention இல்லை. இது implementation pending; testing மட்டும் அல்ல. ஒரே SKU count/order-ஐ ஒரே நேரத்தில் பலர் மாற்றும் production workflow-க்கு இதை முடிக்க வேண்டும்.

## Backup வரம்பு
OMS public table data மட்டுமே. Supabase Auth users/passwords, Storage evidence files மற்றும் schema/policies/functions தனியாக பாதுகாக்கப்பட வேண்டும். Drive connection அமைக்காத நிலையில் automated backup இயங்காது. App மூடப்பட்டபோது claim email/WhatsApp/push reminders இல்லை; workspace-இல் reminders இருக்கும். Backup failure-க்கும் dashboard warning தான்; email இல்லை.

## October 1 இலக்கு
இந்த package handover தயாரிப்புக்கான release candidate. மேலுள்ள சோதனைகள் மற்றும் setup முடியும் வரை production-ready என சான்றளிக்கப்படவில்லை. பழைய project மற்றும் data backup-ஐ வைத்துக்கொண்டு TEST project-இல் தொடங்கவும்.
