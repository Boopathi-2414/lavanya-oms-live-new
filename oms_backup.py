#!/usr/bin/env python3
"""Server-only OMS table backups. Credentials never belong in Vite environment."""
import argparse, datetime as dt, fcntl, hashlib, json, os, pathlib, re, subprocess, tempfile

TABLES = ('oms_orders','oms_payments','oms_products','oms_trash','oms_fraud_list','customer_profiles','oms_reconciliation_history','oms_business_records')
FORMAT = 'LavanyaOMS-ServerBackup'

def now(): return dt.datetime.now(dt.timezone.utc).isoformat()
def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
def digest(value): return hashlib.sha256(canonical(value)).hexdigest()
def ordered(rows): return sorted(rows, key=lambda row: canonical(row))
def command(*args): return subprocess.run(args, check=True, capture_output=True, text=True).stdout

def validate(doc):
    if doc.get('format') != FORMAT or doc.get('version') != 1 or set(doc.get('tables', {})) != set(TABLES):
        raise ValueError('Not a complete supported OMS server backup')
    for table in TABLES:
        rows = doc['tables'][table]
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows): raise ValueError('Invalid table rows')
        meta = doc['manifest'][table]
        if meta['count'] != len(rows) or meta['sha256'] != digest(ordered(rows)): raise ValueError('Backup integrity mismatch: '+table)
    return doc

def connect(service):
    import psycopg
    return psycopg.connect(service=service, connect_timeout=20)

def status(service, state, **updates):
    # Only writes the service status record, never orders/payments.
    from psycopg.types.json import Jsonb
    with connect(service) as db:
        row=db.execute("SELECT data FROM public.oms_business_records WHERE id='server-backup-status' FOR UPDATE").fetchone()
        data=dict(row[0]) if row else {}
        data.update(id='server-backup-status',kind='backupStatus',**updates)
        if state is not None:data.update(status=state,at=now())
        db.execute("INSERT INTO public.oms_business_records(id,data,updated_at) VALUES (%s,%s,now()) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=now()",('server-backup-status',Jsonb(data)))

def capture(service):
    from psycopg import sql
    with connect(service) as db:
        db.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        db.execute('SET LOCAL row_security=off')
        db.execute('SET LOCAL statement_timeout=120000')
        tables={}
        for table in TABLES:
            tables[table]=ordered([r[0] for r in db.execute(sql.SQL('SELECT to_jsonb(t) FROM public.{} t').format(sql.Identifier(table)))])
    return dict(format=FORMAT,version=1,createdAt=now(),tables=tables,manifest={t:dict(count=len(r),sha256=digest(r)) for t,r in tables.items()})

def remote_target():
    remote=os.environ.get('OMS_BACKUP_REMOTE','')
    if not re.fullmatch(r'[A-Za-z0-9_-]+:LavanyaOMS-backups',remote):
        raise ValueError('Use a dedicated encrypted remote: NAME:LavanyaOMS-backups')
    name=remote.split(':')[0]
    listing=command('rclone','listremotes','--long')
    if not any(re.fullmatch(re.escape(name)+r':\s+crypt\s*',line) for line in listing.splitlines()):
        raise ValueError('Backup remote must be rclone crypt over Google Drive')
    return remote

def backup(service):
    remote=remote_target()
    doc=validate(capture(service))
    filename=dt.datetime.now(dt.timezone.utc).strftime('oms-%Y%m%dT%H%M%SZ.json')
    with tempfile.TemporaryDirectory(prefix='oms-backup-') as folder:
        source=pathlib.Path(folder)/filename;source.write_bytes(canonical(doc))
        target=remote+'/'+filename
        command('rclone','copyto',str(source),target)
        check=pathlib.Path(folder)/'download-check.json'
        command('rclone','copyto',target,str(check))
        if hashlib.sha256(source.read_bytes()).digest()!=hashlib.sha256(check.read_bytes()).digest():
            raise ValueError('Drive download verification failed; retention skipped')
    status(service,'success',lastSuccessAt=now(),filename=filename,retentionDays=30)
    # Delete only our exact timestamped files older than 30 days, after verified upload.
    cutoff=dt.datetime.now(dt.timezone.utc)-dt.timedelta(days=30)
    entries=json.loads(command('rclone','lsjson',remote,'--files-only','--max-depth','1'))
    for entry in entries:
        name=entry.get('Name','')
        match=re.fullmatch(r'oms-(\d{8}T\d{6}Z)\.json',name)
        if match and dt.datetime.strptime(match[1],'%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc)<cutoff:
            command('rclone','deletefile',remote+'/'+name)
    print('PASS: verified Drive upload; retention applied. Restore drill is separate.')

def restore_drill(service, source_service, filename):
    from psycopg import sql
    from psycopg.types.json import Jsonb
    if service==source_service or not service.endswith('_restore_test'):
        raise ValueError('Use a separate service ending _restore_test')
    doc=validate(json.loads(pathlib.Path(filename).read_text()))
    with connect(source_service) as source, connect(service) as target:
        # Compare configured host/port/database before any writes. Operator must also ensure aliases do not refer to production.
        if (source.info.host,source.info.port,source.info.dbname)==(target.info.host,target.info.port,target.info.dbname):
            raise ValueError('Source and restore target are the same database')
        try:
            guard=target.execute("SELECT token FROM public.oms_restore_test_guard WHERE token='EMPTY_TEST_DATABASE_ONLY'").fetchone()
            if not guard:raise ValueError('Restore test guard missing')
            target.execute('SET LOCAL statement_timeout=120000')
            target.execute('SET LOCAL lock_timeout=5000')
            for table in TABLES:
                target.execute(sql.SQL('LOCK TABLE public.{} IN EXCLUSIVE MODE').format(sql.Identifier(table)))
                if target.execute(sql.SQL('SELECT EXISTS(SELECT 1 FROM public.{})').format(sql.Identifier(table))).fetchone()[0]:
                    raise ValueError('Restore test requires empty OMS tables: '+table)
            for table in TABLES:
                rows=doc['tables'][table]
                if not rows: continue
                cols=list(rows[0])
                if any(set(row)!=set(cols) for row in rows):raise ValueError('Inconsistent row shape')
                columns=sql.SQL(',').join(map(sql.Identifier,cols))
                target.execute(sql.SQL('INSERT INTO public.{} ({}) SELECT {} FROM jsonb_populate_recordset(NULL::public.{},%s)').format(sql.Identifier(table),columns,columns,sql.Identifier(table)),(Jsonb(rows),))
            for table in TABLES:
                rows=ordered([r[0] for r in target.execute(sql.SQL('SELECT to_jsonb(t) FROM public.{} t').format(sql.Identifier(table)))])
                if digest(rows)!=doc['manifest'][table]['sha256']:raise ValueError('Restored content differs: '+table)
        finally:
            target.rollback()  # Drill never commits or replaces operational data.
    status(source_service,None,lastRestoreAt=now(),lastRestoreFile=pathlib.Path(filename).name)
    print('PASS: all eight tables restored and content hashes matched; test transaction rolled back.')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['backup','verify','restore-drill']);parser.add_argument('--file');parser.add_argument('--test-service');args=parser.parse_args()
    service=os.environ.get('OMS_DB_SERVICE','lavanya_oms')
    os.umask(0o077)
    lock_path=pathlib.Path(os.environ.get('OMS_BACKUP_LOCK','/var/lib/lavanya-backup/job.lock'))
    lock_path.parent.mkdir(parents=True,exist_ok=True)
    with lock_path.open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        try:
            if args.action=='backup':backup(service)
            elif args.action=='verify':validate(json.loads(pathlib.Path(args.file).read_text()));print('PASS: backup table hashes and counts match')
            else:restore_drill(args.test_service or '',service,args.file)
        except Exception as error:
            # Avoid logging connection strings, table data or provider response bodies.
            if args.action=='backup':
                try:status(service,'failed')
                except Exception:pass
            print('FAILED:',type(error).__name__,'— check server configuration, credentials, connectivity and backup files.')
            raise SystemExit(1)
if __name__=='__main__': main()
