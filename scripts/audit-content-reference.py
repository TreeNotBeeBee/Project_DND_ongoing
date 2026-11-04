"""Match every local 2024 spell against an actual heading in the official PDF.
Usage: python scripts/audit-content-reference.py <official.pdf>
"""
import hashlib
import json
import pathlib
import re
import sys
import fitz

root=pathlib.Path(__file__).resolve().parent.parent
pdf_path=pathlib.Path(sys.argv[1])
digest=hashlib.sha256(pdf_path.read_bytes()).hexdigest()
expected="8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87"
if digest!=expected:raise SystemExit("Unverified official PDF revision")
local=json.loads((root/'src/content/raw/srd-2024.json').read_text(encoding='utf-8'))['spells']
normalize=lambda value:re.sub(r'[^a-z0-9]','',value.lower())
by_name={normalize(entry['name']):entry for entry in local}
found={}
document=fitz.open(pdf_path)
for page in document:
    if not 107<=page.number+1<=175:continue
    for block in page.get_text('dict')['blocks']:
        for line in block.get('lines',[]):
            spans=[span for span in line['spans'] if span['font'].startswith('GillSans-SemiBold') and span['color']==9183776]
            if not any(abs(span['size']-12)<0.01 for span in spans):continue
            name=''.join(span['text'] for span in spans).strip()
            entry=by_name.get(normalize(name))
            if entry:found[entry['index']]={"id":"spell:"+entry['index'],"name":name,"sourcePage":page.number+1}
missing=[entry['index'] for entry in local if entry['index'] not in found]
if missing:raise SystemExit("Missing official spell headings: "+', '.join(missing))
payload={"ruleset":"srd-5.2.1","source":"https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf","pdfSha256":digest,"license":"CC-BY-4.0","spellCount":len(found),"spells":sorted(found.values(),key=lambda entry:entry['id'])}
(root/'src/content/official-spell-index.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({"officialSpellHeadingsMatched":len(found),"missing":missing}))
