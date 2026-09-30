# Lavanya OMS — புதிதாகத் தொடங்குதல் (புதிய Supabase + VPS + Domain)

பழைய Supabase project-ஐ **delete செய்ய வேண்டாம்**. அது அப்படியே backup-ஆக இருக்கட்டும்.
புதிய project காலியாகத் தொடங்கும்.

Chat-ல் ஒருபோதும் அனுப்பக் கூடாதவை: secret key, database password, VPS password.

---

## 1. புதிய Supabase project (15 நிமிடம்)
1. supabase.com → **New project**
   - Name: `lavanya-oms-live`
   - Region: **Mumbai**
   - Database password: ஒரு வலுவான password போட்டு, பாதுகாப்பாக எழுதி வைக்கவும்.
   - (புதிய project உருவாக்க அனுமதி இல்லை என்றால், பழைய TEST project-ஐ **Pause** செய்துவிட்டு மீண்டும் முயலுங்கள்.)
2. **Authentication → Users → Add user → Create new user**
   - உங்கள் login email, password போடுங்கள்.
   - **Auto Confirm** tick செய்யுங்கள்.
   - உருவான user-ஐ click செய்து **User UID**-ஐ copy செய்யுங்கள்.
3. **Authentication → Sign In / Providers** → "Allow new users to sign up" → **OFF**.
4. **SQL Editor** → `deploy/000_new_project_setup.sql`-ஐத் திறங்கள்.
   - `PUT-UID-HERE` இடத்தில் உங்கள் UID-ஐப் போடுங்கள்.
   - **Run** அழுத்துங்கள். "OMS database ready" என்று வர வேண்டும்.
5. **Project Settings → API Keys**-ல் இருந்து **Project URL** மற்றும் **publishable key** இரண்டையும் copy செய்யுங்கள்.

## 2. உங்கள் computer-ல் சோதனை (15 நிமிடம்)
1. **SETUP_ENV.cmd** → `L` → URL, key, UID-ஐ paste செய்யுங்கள்.
2. **PREFLIGHT.cmd** → "ALL REQUIRED CHECKS PASSED" வர வேண்டும்.
3. **START_WINDOWS.cmd** → `http://localhost:5174` → login செய்யுங்கள். காலியான OMS திறக்கும்.
4. ஒரு label PDF upload → அதை scan → refresh. Order அப்படியே இருக்க வேண்டும்.

## 3. VPS (20 நிமிடம்)
Windows **PowerShell** திறந்து:
```
ssh root@VPS-IP
```
உள்ளே இதை அப்படியே paste செய்யுங்கள்:
```
apt update && apt install -y debian-keyring debian-archive-keyring apt-transport-https curl ufw
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
mkdir -p /var/www/lavanya-oms
exit
```
பிறகு இந்த folder-க்குள் PowerShell திறந்து:
```
scp deploy\Caddyfile.static root@VPS-IP:/etc/caddy/Caddyfile
ssh root@VPS-IP "systemctl reload caddy"
```

## 4. Domain → VPS
1. Domain DNS எங்கே இருக்கிறதோ (domain வாங்கிய site அல்லது Vercel) அங்கே A record-களை மாற்றுங்கள்:
   - `@` (lavanyaoms.co.in) → **VPS-IP**
   - `www` → **VPS-IP**
2. பழைய Vercel/CNAME record இருந்தால் அதை நீக்குங்கள்.
3. மாற்றம் பரவ 5 நிமிடம் முதல் சில மணி நேரம் ஆகலாம்.

## 5. Software-ஐ ஏற்றுதல்
1. **DEPLOY_TO_VPS.cmd** → VPS-IP → root password (3 முறை கேட்கும்).
2. `https://lavanyaoms.co.in` → **Ctrl+F5** → 🔒 வர வேண்டும் → login செய்யுங்கள்.
3. இனி ஒவ்வொரு update-க்கும் இதே **DEPLOY_TO_VPS.cmd** ஒன்றே போதும்.

## 6. நாளையிலிருந்து
- எல்லோரும் **https://lavanyaoms.co.in** மட்டும் பயன்படுத்த வேண்டும்.
- Purchase Rates, opening stock-ஐ புதிதாகப் போட வேண்டும் (புதிய project காலியாக இருக்கும்).
- தினமும் மாலை: Business Workspace → Backup → **Download full JSON**.
- Stock மாற்றங்களை ஒரே computer-ல் மட்டும் செய்யுங்கள்.
