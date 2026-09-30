import copy, unittest
import oms_backup as b
class BackupTests(unittest.TestCase):
 def doc(self):
  tables={t:[] for t in b.TABLES};tables['oms_orders']=[{'id':'001','data':{'awb':'000123456789012345678','transactions':[{'amount':400}]}}]
  return dict(format=b.FORMAT,version=1,tables=tables,manifest={t:dict(count=len(r),sha256=b.digest(b.ordered(r))) for t,r in tables.items()})
 def test_roundtrip(self):
  import json
  d=b.validate(json.loads(b.canonical(self.doc())))
  self.assertEqual(d['tables']['oms_orders'][0]['data']['awb'],'000123456789012345678')
 def test_tamper_rejected(self):
  d=self.doc();d['tables']['oms_orders'][0]['data']['transactions'][0]['amount']=1
  with self.assertRaises(ValueError):b.validate(d)
 def test_partial_rejected(self):
  d=self.doc();del d['tables']['oms_products']
  with self.assertRaises(ValueError):b.validate(d)
 def test_row_order_independent(self):
  rows=[{'id':'b'},{'id':'a'}];self.assertEqual(b.digest(b.ordered(rows)),b.digest(b.ordered(list(reversed(rows)))))

class UploadTests(unittest.TestCase):
 def test_retention_only_after_verified_download_and_only_owned_files(self):
  import pathlib, json
  from unittest.mock import patch
  payload=BackupTests().doc();uploaded={};deleted=[]
  def cmd(*a):
   if a[1]=='copyto':
    if a[2].startswith('omscrypt:'):pathlib.Path(a[3]).write_bytes(uploaded[a[2]])
    else:uploaded[a[3]]=pathlib.Path(a[2]).read_bytes()
    return ''
   if a[1]=='lsjson':return json.dumps([{'Name':'oms-20000101T000000Z.json'},{'Name':'important.json'},{'Name':'oms-20990101T000000Z.json'}])
   if a[1]=='deletefile':deleted.append(a[2]);return ''
   raise AssertionError(a)
  with patch.object(b,'remote_target',return_value='omscrypt:LavanyaOMS-backups'),patch.object(b,'capture',return_value=payload),patch.object(b,'status'),patch.object(b,'command',side_effect=cmd):b.backup('test')
  self.assertEqual(deleted,['omscrypt:LavanyaOMS-backups/oms-20000101T000000Z.json'])
 def test_corrupt_download_never_runs_retention(self):
  import pathlib
  from unittest.mock import patch
  calls=[]
  def cmd(*a):
   calls.append(a)
   if a[1]=='copyto' and a[2].startswith('omscrypt:'):pathlib.Path(a[3]).write_text('corrupt')
   return ''
  with patch.object(b,'remote_target',return_value='omscrypt:LavanyaOMS-backups'),patch.object(b,'capture',return_value=BackupTests().doc()),patch.object(b,'command',side_effect=cmd):
   with self.assertRaises(ValueError):b.backup('test')
  self.assertFalse(any(a[1] in ['lsjson','deletefile'] for a in calls))

if __name__=='__main__':unittest.main()
