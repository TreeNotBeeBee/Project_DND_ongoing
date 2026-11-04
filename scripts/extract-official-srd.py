"""Extract the licensed primary reference for offline rules verification.

Usage: python scripts/extract-official-srd.py <official.pdf> <output.json>
Requires PyMuPDF; the original PDF is never modified.
"""
import hashlib
import json
import pathlib
import sys
import fitz

source_path = pathlib.Path(sys.argv[1])
output_path = pathlib.Path(sys.argv[2])
expected_hash = "8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87"
digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
if digest != expected_hash:
    raise SystemExit("Official SRD PDF differs from the verified revision; review before updating reference.")
document = fitz.open(source_path)
pages = [{"pdfPage": page.number + 1, "label": page.get_label(), "text": page.get_text(sort=True)} for page in document]
payload = {
    "ruleset": "srd-5.2.1", "source": "https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf",
    "sha256": digest, "license": "CC-BY-4.0", "pages": pages,
}
output_path.parent.mkdir(parents=True, exist_ok=True)
output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"pages": len(pages), "sha256": digest}))
