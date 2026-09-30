# Google Drive backup — VPS administrator setup (RC4)

இந்த வசதி code-இல் உள்ளது; இன்னும் Google Drive / VPS-இல் இயக்கப்படவில்லை.
இது Linux + systemd server-க்கான வழிமுறை. VPS OS தெரிந்ததும் பொருத்தத்தை உறுதிசெய்யவும்.

## என்ன சேமிக்கப்படும்

OMS-இன் எட்டு public tables முழுவதும், nested payment transactions, claims, attendance, inventory records, customer profiles, reconciliation history உட்பட. ஒரே repeatable-read snapshot-இல் export செய்கிறது. AWB / Order ID strings அப்படியே இருக்கும். Supabase Auth users/passwords, Storage photos/videos, SQL schema/functions/RLS policies இதில் இல்லை. Source ZIP மற்றும் database migrations-ஐ தனியாக பாதுகாக்க வேண்டும். Evidence URL-இல் உள்ள file-ஐ backup செய்ததாகக் கருத வேண்டாம்.

Browser full JSON backup-இலிருந்து இது வேறு server format. Server backup-ஐ browser recovery upload-இல் பயன்படுத்த வேண்டாம்.

## நிறுவுதல் (administrator)

1. Dedicated Linux user `lavanya-backup` உருவாக்கவும். `/opt/lavanya-backup` code, `/etc/lavanya-backup` credentials, `/var/lib/lavanya-backup` status/lock directory அமைக்கவும். Credentials directory permission 700, credential files 600; backup user மட்டுமே படிக்க வேண்டும்.
2. Python 3.10+, venv, rclone நிறுவவும். `oms_backup.py`, `requirements.txt` ஆகியவற்றை `/opt/lavanya-backup`-க்கு copy செய்து:

```sh
python3 -m venv /opt/lavanya-backup/venv
/opt/lavanya-backup/venv/bin/pip install -r /opt/lavanya-backup/requirements.txt
```

3. `backup.env.example` → `/etc/lavanya-backup/backup.env`. `pg_service.conf.example` → `/etc/lavanya-backup/pg_service.conf`. Supabase database host/user/port மற்றும் provider CA தேவைப்பட்டால் நிரப்பவும். Verified TLS பயன்படுத்தவும். **Publishable API key database password அல்ல.** PostgreSQL நேரடி connection அல்லது session pooler பயன்படுத்தவும்; transaction pooler வேண்டாம்.
4. `/etc/lavanya-backup/pgpass`-இல் PostgreSQL password அமைக்கவும் (`host:port:database:user:password`; colons/backslashes pgpass விதிப்படி escape செய்யவும்). இவை Vite `.env` அல்லது ZIP-இல் சேர்க்கக்கூடாது. Database role-க்கு எட்டு tables read permission மற்றும் `oms_business_records` status record எழுதும் permission வேண்டும். RLS காரணமாக முழு தரவு மறையாத server role தேவை; அதற்கான credential server-இல் மட்டும்.
5. Dedicated Google Drive folder உருவாக்கவும். Backup user-ஆக, `RCLONE_CONFIG=/etc/lavanya-backup/rclone.conf rclone config` மூலம் Google OAuth இணைக்கவும். முதலில் Drive remote; அதன் மேல் **crypt remote `omscrypt`** அமைக்கவும். Crypt password/salt மற்றும் OAuth config-ஐ server-க்கு வெளியே பாதுகாப்பாக வைத்திருக்கவும்; இவற்றின்றி encrypted backup-ஐ மீட்க முடியாது. Google password-ஐ chat-இல் பகிர வேண்டாம்.
6. crypt remote-க்குள் தனி `LavanyaOMS-backups` folder மட்டுமே பயன்படுத்தப்படுகிறது. Script வேறு பெயர்களை ஏற்காது. Config-ஐ OAuth refresh செய்ய backup user எழுதக்கூடியதாக அமைக்கவும்.
7. `.service`, `.timer` files-ஐ `/etc/systemd/system/`-க்கு copy செய்யவும். Credentials owner/permissions உறுதிசெய்த பிறகு:

```sh
sudo systemctl daemon-reload
sudo systemctl start lavanya-backup.service
sudo journalctl -u lavanya-backup.service -n 40 --no-pager
```

முதலாவது verified upload PASS ஆன பிறகே:

```sh
sudo systemctl enable --now lavanya-backup.timer
sudo systemctl list-timers lavanya-backup.timer
```

Schedule: தினமும் இந்திய நேரம் 02:00 (அதிகபட்சம் 5 நிமிட random delay). Server அணைந்திருந்தால் அடுத்த startup-இல் missed run நடைபெறும். User PC திறந்து இருக்க வேண்டியதில்லை.

## Upload, retention, dashboard

Upload செய்த backup மீண்டும் download செய்யப்பட்டு SHA-256 ஒப்பிடப்படும். அது வென்ற பிறகே exact `oms-YYYYMMDDTHHMMSSZ.json` filename கொண்ட 30 நாட்களைத் தாண்டிய files நீக்கப்படும். மற்ற Drive files தொடப்படாது. Drive trash policy காரணமாக storage உடனடியாக விடுவிக்கப்படாமல் இருக்கலாம். Backup failure dashboard-இல் காட்டப்படும்; database itself unreachable என்றால் status update முடியாது, 36 மணி நேரம் verified backup இல்லாததை stale warning காட்டும். App refresh / cloud sync மூலம் status வரும். Email / WhatsApp அனுப்புதல் இல்லை.

## மீட்புச் சோதனை — live deployment-க்கு முன் செய்ய வேண்டும்

இது data restore drill; production-க்கு automatic restore கிடையாது.

1. தனி TEST Supabase project/database தயாரித்து OMS-இன் அதே schema, policies, தேவையான auth identity உருவாக்கவும். எட்டு OMS tables-உம் காலியாக இருக்க வேண்டும். Production-ஐ test target-ஆக பயன்படுத்த வேண்டாம்; host aliases கூட ஒரே database-ஐக் குறிக்கக்கூடாது.
2. TEST database-இல் மட்டும் இந்த guard table உருவாக்கவும்:

```sql
CREATE TABLE public.oms_restore_test_guard(token text PRIMARY KEY);
INSERT INTO public.oms_restore_test_guard VALUES ('EMPTY_TEST_DATABASE_ONLY');
```

3. pg_service.conf-இல் `lavanya_restore_test` service மற்றும் தனி pgpass entry அமைக்கவும்.
4. Backup user environment-இல் crypt remote வழியாக ஒரு backup download செய்யவும்:

```sh
rclone copyto omscrypt:LavanyaOMS-backups/EXACT_BACKUP_FILENAME.json /var/lib/lavanya-backup/drill.json
/opt/lavanya-backup/venv/bin/python /opt/lavanya-backup/oms_backup.py verify --file /var/lib/lavanya-backup/drill.json
/opt/lavanya-backup/venv/bin/python /opt/lavanya-backup/oms_backup.py restore-drill --file /var/lib/lavanya-backup/drill.json --test-service lavanya_restore_test
```

Commands-க்கு backup.env-இல் உள்ள variables export செய்யப்பட்டிருக்க வேண்டும். Backup user-க்கு மட்டுமே decrypted file access இருக்க வேண்டும். சோதனைக்குப் பிறகு drill.json-ஐ நீக்கவும்.

Drill எட்டு tables-ஐ காலியான TEST database transaction-இல் insert செய்து record counts/content hashes ஒப்பிட்டு **rollback** செய்கிறது. Existing data அழிக்காது. PASS ஆனால் dashboard-இல் last restore drill time பதிவு செய்யும். உண்மையான disaster recovery-க்கு administrator மூலம் reviewed restore மற்றும் app login/RLS/storage verification தனியாக தேவை.

## Reference documentation
- https://rclone.org/drive/
- https://rclone.org/crypt/
- https://rclone.org/commands/rclone_copyto/
- https://www.psycopg.org/psycopg3/docs/basic/transactions.html
