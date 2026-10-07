#!/usr/bin/env python3
"""Did a split drop a module-scope declaration?

Four times now a file has been divided into a directory and something declared at module
scope in the original has gone missing: scopeOptions, legal, statusChip, issued. Each one
is invisible until the line that reads it runs, which for a settings page means the page
renders an error surface and nothing else.

The render check does not catch it, because rendering an error is a render. The layout
check caught it by accident, because an error message contains a file path and therefore
overflows a phone viewport - a layout symptom of a wiring fault.

This compares every split against what it came from:

  - every module-scope name in the original, against the union of the modules it became
  - every module-scope name declared more than once across the result, which means a copy
    survived alongside the moved one

Usage: python3 frontend/audit-split-loses.py <original-file> <new-file-or-dir> ...
"""
import os
import re
import subprocess
import sys


def module_scope(src):
    """Names declared at column 0, which is what a split can drop or duplicate."""
    names = set()
    for m in re.finditer(r'^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)', src, re.M):
        names.add(m.group(1))
    for m in re.finditer(r'^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)', src, re.M):
        names.add(m.group(1))
    return names


def strip(src):
    src = re.sub(r'/\*[\s\S]*?\*/', '', src)
    src = re.sub(r'(?m)^\s*//.*$', '', src)
    return src


def originals(spec):
    """The version to compare against.

    A file that has been split has a re-export surface at HEAD rather than the original,
    so the revision is part of the spec: 'rev:path'. Without it, HEAD is used, and the
    file is read from disk if that revision does not name it.
    """
    rev, path = 'HEAD', spec
    if spec.startswith('rev:'):
        rev, path = spec[4:].split(':', 1)
    try:
        return subprocess.run(['git', 'show', rev + ':' + path],
                              capture_output=True, text=True, check=True).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return open(path).read()


def members(target):
    if os.path.isdir(target):
        return [os.path.join(target, f) for f in sorted(os.listdir(target))
                if f.endswith('.js')]
    return [target]


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    problems = 0
    was = module_scope(strip(originals(sys.argv[1])))

    # The union across every output, not each one on its own: a name is accounted for if
    # it is in the directory or in the root, and comparing each separately reported
    # downloadAttachment and messageRow as dropped from a split that moved neither.
    seen = {}
    for target in sys.argv[2:]:
        for f in members(target):
            for n in module_scope(strip(open(f).read())):
                seen.setdefault(n, []).append(os.path.basename(f))

    print('  %s -> %d declared, %d accounted for' % (
        os.path.basename(sys.argv[1]), len(was), len(was & set(seen))))
    for n in sorted(was - set(seen)):
        homes = [h for h in seen.get(n, [])]
        print('    DROPPED    %s%s' % (n, '  (still read in %s)' % ', '.join(homes) if homes else ''))
        problems += 1
    for n in sorted(n for n, homes in seen.items() if len(homes) > 1):
        print('    DUPLICATED %s  in %s' % (n, ', '.join(seen[n])))
        problems += 1
    print('\n  %d problem(s)' % problems if problems else '\n  nothing lost, nothing duplicated')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())