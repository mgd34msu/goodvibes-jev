#!/usr/bin/env python3
"""Reconstruct only the ordinary TUI checkpoint from verified public inputs."""
import argparse, hashlib, io, json, re, subprocess, tarfile
from pathlib import Path, PurePosixPath

parser = argparse.ArgumentParser()
parser.add_argument('--upstream-repository', required=True)
parser.add_argument('--archive', required=True)
parser.add_argument('--output', required=True, help='new empty output directory')
args = parser.parse_args()
packet = Path(__file__).resolve().parent
manifest = json.loads((packet / 'manifest.json').read_text())
archive = Path(args.archive).read_bytes()
assert hashlib.sha256(archive).hexdigest() == manifest['overlay']['sha256'], 'overlay archive hash mismatch'
output = Path(args.output)
assert not output.exists(), 'output must not already exist'
files = {}
omit = set(manifest['omittedUpstream']) | set(manifest['untrackedIgnoredUpstream'])

def ingest(raw, prefix, overlay=False):
    with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
        for member in tar:
            if not member.isfile():
                assert member.isdir(), 'non-regular archive member refused'
                continue
            name = PurePosixPath(member.name)
            assert not name.is_absolute() and '..' not in name.parts, 'unsafe archive path'
            if overlay:
                if not str(name).startswith('overlay/products/tui/'):
                    continue
                path = str(name)[len('overlay/'):]
            else:
                if str(name) in omit:
                    continue
                path = prefix + str(name)
            files[path] = (0o100755 if member.mode & 0o111 else 0o100644, tar.extractfile(member).read())

upstream = subprocess.check_output(['git', '-C', args.upstream_repository, 'archive', manifest['upstream']['commit']])
ingest(upstream, 'products/tui/')
ingest(archive, '', overlay=True)
changed = 0
for path, (mode, data) in list(files.items()):
    if Path(path).suffix not in manifest['retargeting']['extensions']:
        continue
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        continue
    for old, new in manifest['retargeting']['prefixes'].items():
        text = re.sub(r'''(?<=["'])''' + re.escape(old) + r'''(?=/|["'])''', new, text)
    if text.encode() != data:
        changed += 1
        files[path] = (mode, text.encode())
assert changed == manifest['retargeting']['changedFiles'], 'retargeted file count mismatch'
for target, source in [('products/tui/src/runtime/store/index.ts', 'store-index.ts'), ('products/tui/migration-proof.md', 'migration-proof.md')]:
    files[target] = (0o100644, (packet / source).read_bytes())
rows = ''.join(f'{mode:o}\0{path}\0{hashlib.sha256(data).hexdigest()}\n' for path, (mode, data) in sorted(files.items()))
assert len(files) == manifest['productFiles'], 'product file count mismatch'
assert hashlib.sha256(rows.encode()).hexdigest() == manifest['orderedProductModePathSha256Digest'], 'product contents/modes mismatch'
output.mkdir(parents=True)
for path, (mode, data) in files.items():
    target = output / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    target.chmod(mode & 0o777)
print(json.dumps({'productFiles': len(files), 'verifiedProductDigest': hashlib.sha256(rows.encode()).hexdigest(), 'expectedTreeAfterApplyingWorkspaceLockPatchToPublicBase': manifest['sourceTree']}))
