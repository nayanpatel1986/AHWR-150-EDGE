#!/usr/bin/env bash
# Builds the single-click installer folder AHWR-Edge-Setup_<version>/ and its zip
# from the COMMITTED tree of this repository plus the Windows components listed in
# installer/components.lock.json (downloaded beforehand; every file is verified).
#
#   installer/build.sh <components-dir> <output-dir> [version]
#
# <components-dir> holds pgsql/, timescaledb/, telegraf/, node/, python/ and nssm/
# (one zip each, as named in the lock file) and wheels/ (asyncua and its wheels for
# win_amd64 / CPython 3.12). Needs git, node/npm 20+, python3 and zip.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
COMP=$(cd "${1:?components dir}" && pwd)
OUT=${2:?output dir}
VERSION=${3:-$(date +%Y.%m.%d)}
NAME="AHWR-Edge-Setup_$VERSION"
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
STAGE="$OUT/$NAME"

if ! git -C "$REPO" diff --quiet HEAD --; then
    echo "Commit or stash local changes first: the package is built from HEAD." >&2; exit 1
fi
rm -rf "$STAGE" "$OUT/$NAME.zip" "$OUT/$NAME.zip.sha256"
mkdir -p "$STAGE/app" "$STAGE/components" "$STAGE/certs" "$STAGE/setup"

echo "1/6 application from $(git -C "$REPO" rev-parse --short HEAD)"
git -C "$REPO" archive --format=tar HEAD | tar -x -C "$STAGE/app"
rm -rf "$STAGE/app/installer"

echo "2/6 backend dependencies"
( cd "$STAGE/app/app/backend" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error )
if find "$STAGE/app/app/backend/node_modules" -name '*.node' | grep -q .; then
    echo "A native Node module was installed; it would not run on Windows." >&2; exit 1
fi

echo "3/6 installer scripts"
cp "$REPO"/installer/*.bat "$REPO/installer/rig-settings.ini" "$REPO/installer/README.txt" "$STAGE/"
cp "$REPO"/installer/setup/*.ps1 "$REPO"/installer/setup/*.psm1 "$STAGE/setup/"
cp "$REPO/installer/certs-README.txt" "$STAGE/certs/README.txt"
printf '%s\n' "$VERSION" > "$STAGE/VERSION.txt"
git -C "$REPO" rev-parse HEAD > "$STAGE/app/COMMIT.txt"

echo "4/6 components (verified against components.lock.json)"
python3 - "$REPO/installer/components.lock.json" "$COMP" "$STAGE/components" <<'PY'
import hashlib, json, os, shutil, sys
lock, src, dst = sys.argv[1:4]
def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()
data = json.load(open(lock))
for c in data['components']:
    if c['name'] == 'python-wheels':
        os.makedirs(os.path.join(dst, c['dir']), exist_ok=True)
        for w in c['files']:
            p = os.path.join(src, 'wheels', w['file'])
            if sha(p) != w['sha256']: sys.exit(f"checksum mismatch: {p}")
            shutil.copy2(p, os.path.join(dst, c['dir'], w['file']))
        continue
    p = os.path.join(src, c['name'], c['file'])
    if not os.path.exists(p): p = os.path.join(src, c['file'])
    if sha(p) != c['sha256']: sys.exit(f"checksum mismatch: {p}")
    shutil.copy2(p, os.path.join(dst, c['file']))
    print(f"   {c['name']:12} {c['version']:10} {c['file']}")
json.dump(data, open(os.path.join(dst, 'components.json'), 'w'), indent=1)
PY

echo "5/6 Windows conventions"
python3 - "$STAGE" <<'PY'
import os, sys
stage = sys.argv[1]
bom, n_bom, n_crlf = b'\xef\xbb\xbf', 0, 0
for dirpath, dirs, files in os.walk(stage):
    if 'node_modules' in dirpath.split(os.sep): continue
    for f in files:
        p = os.path.join(dirpath, f)
        low = f.lower()
        data = open(p, 'rb').read()
        new = data
        # Windows PowerShell 5.1 reads BOM-less scripts as ANSI: mark every script as UTF-8.
        if low.endswith(('.ps1', '.psm1')) and not data.startswith(bom):
            new = bom + new; n_bom += 1
        # cmd.exe and Notepad users: CRLF for batch, ini and the installer's text files.
        if low.endswith(('.bat', '.cmd', '.ini')) or (low.endswith('.txt') and os.path.dirname(p) in (stage, os.path.join(stage, 'certs'))):
            fixed = new.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
            if fixed != new: new = fixed; n_crlf += 1
        if new != data: open(p, 'wb').write(new)
print(f"   UTF-8 BOM added to {n_bom} PowerShell file(s); CRLF in {n_crlf} file(s)")
PY

echo "6/6 checksums and zip"
python3 - "$STAGE" <<'PY'
import hashlib, os, sys
stage = sys.argv[1]
skip = {'SHA256SUMS.txt', 'rig-settings.ini'}
rows = []
for dirpath, dirs, files in os.walk(stage):
    for f in files:
        rel = os.path.relpath(os.path.join(dirpath, f), stage).replace(os.sep, '/')
        if rel in skip or rel.startswith('certs/'): continue
        h = hashlib.sha256()
        with open(os.path.join(dirpath, f), 'rb') as fh:
            for b in iter(lambda: fh.read(1 << 20), b''): h.update(b)
        rows.append(f"{h.hexdigest()}  {rel}")
rows.sort(key=lambda r: r[66:])
open(os.path.join(stage, 'SHA256SUMS.txt'), 'w', newline='\r\n').write('\n'.join(rows) + '\n')
print(f"   {len(rows)} files listed")
PY
( cd "$OUT" && zip -qr -X "$NAME.zip" "$NAME" && shasum -a 256 "$NAME.zip" > "$NAME.zip.sha256" )
du -sh "$STAGE" "$OUT/$NAME.zip" | sed 's/^/   /'
echo "Built $OUT/$NAME.zip"
