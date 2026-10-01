#!/usr/bin/env python3
"""Reconstruct the ordinary Agent checkpoint in a new disposable Git index.

Requires the two public commits in the supplied repository's object database.
Does not check out files, update a branch, run candidate code, or access a network.
Writes reconstructed blobs/trees and the explicitly supplied new index only.
"""
import argparse
import gzip
import hashlib
import os
from pathlib import Path, PurePosixPath
import subprocess

BASE = '9363f44d186e152f5c829aa106d5645ce3ed02a0'
BASE_TREE = '4e0f24d474b588958ab7ac61037f7910071dc907'
UPSTREAM = 'f05fe636c120baa469037efe7d7391c3d9503635'
UPSTREAM_TREE = '7f5575e17a8f52f638b145830f9a4fc4e4bf650f'
MATERIALIZED_TREE = '9d05f563a18d881180a87f3db1c30e2cbfe12e2d'
RETARGET_TREE = '89f12b971e7e704622b491e00ab084938717de16'
CANDIDATE_TREE = 'ee3ced1a7d0325dc445abe867b18c44693093435'
PATCH_SHA256 = '5f4ff9d14a11ff1d1d8399e5e82609c9428196026e114ab30e27794dc3fd92c1'
GZIP_SHA256 = 'a467153ce698f102e764502e4ab805405fd5975b2bddecf24a4c9ead54f3b61a'
REPLACEMENTS = {
    '@pellux/goodvibes-sdk': '@goodvibes-jev/engine/sdk',
    '@pellux/goodvibes-terminal-shell': '@goodvibes-jev/engine/terminal-shell',
    '@pellux/goodvibes-toolchain': '@goodvibes-jev/engine/toolchain',
    '@pellux/goodvibes-transport-core': '@goodvibes-jev/engine/transport-core',
    '@pellux/goodvibes-daemon': '@goodvibes-jev/daemon',
}
SUFFIXES = {'.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.sh'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--index', required=True, help='New, nonexistent disposable index path')
    parser.add_argument('--patch', default=str(Path(__file__).with_name('residual.patch.gz')))
    args = parser.parse_args()
    index = Path(args.index).resolve()
    if index.exists():
        raise SystemExit('Refusing to overwrite an existing index')
    env = os.environ | {'GIT_INDEX_FILE': str(index)}

    def git(*argv, data=None):
        return subprocess.check_output(['git', '-C', args.repo, *argv], input=data, env=env)

    if git('rev-parse', BASE+'^{tree}').decode().strip() != BASE_TREE:
        raise SystemExit('Wrong public base tree')
    if git('rev-parse', UPSTREAM+'^{tree}').decode().strip() != UPSTREAM_TREE:
        raise SystemExit('Wrong upstream tree')
    compressed = Path(args.patch).read_bytes()
    if hashlib.sha256(compressed).hexdigest() != GZIP_SHA256:
        raise SystemExit('Compressed patch hash mismatch')
    patch = gzip.decompress(compressed)
    if hashlib.sha256(patch).hexdigest() != PATCH_SHA256:
        raise SystemExit('Patch hash mismatch')
    git('read-tree', BASE)
    git('read-tree', '--prefix=products/agent/', UPSTREAM_TREE)
    if git('write-tree').decode().strip() != MATERIALIZED_TREE:
        raise SystemExit('Materialized tree mismatch')
    changed = 0
    for record in git('ls-tree', '-r', '-z', MATERIALIZED_TREE, 'products/agent').split(b'\0'):
        if not record:
            continue
        metadata, raw_path = record.split(b'\t', 1)
        mode, kind, sha = metadata.decode().split()
        path = raw_path.decode()
        if kind != 'blob' or PurePosixPath(path).suffix not in SUFFIXES:
            continue
        raw = git('cat-file', 'blob', sha)
        try:
            before = raw.decode('utf-8').replace('\r\n', '\n').replace('\r', '\n')
        except UnicodeDecodeError:
            continue
        after = before
        for old, new in REPLACEMENTS.items():
            after = after.replace(old, new)
        if after != before:
            sha = git('hash-object', '-w', '--stdin', data=after.encode()).decode().strip()
            git('update-index', '--cacheinfo', mode, sha, path)
            changed += 1
    if changed != 775 or git('write-tree').decode().strip() != RETARGET_TREE:
        raise SystemExit('Retargeted tree mismatch')
    git('apply', '--cached', '--check', '--binary', '-', data=patch)
    git('apply', '--cached', '--binary', '-', data=patch)
    result = git('write-tree').decode().strip()
    if result != CANDIDATE_TREE:
        raise SystemExit('Final candidate tree mismatch: '+result)
    print(result)


if __name__ == '__main__':
    main()
