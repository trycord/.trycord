#!/usr/bin/env python3
"""One-shot splitter for frontend/js/components.js. Rewrites components/media.js and
components/nav.js from the committed version of components.js.

The first attempt had `write(A if reqs else '' + body)`, which Python reads as
`write((A if reqs else '') + body)`... except it does not: the conditional binds looser
than `+`, so it wrote `A if reqs else ('' + body)` and threw the body away whenever
there were imports. Both files came out as three lines of import. Parented here.

Run once, then delete.
"""
import os
import re
import subprocess
import sys

SRC = subprocess.run(['git', 'show', 'HEAD:frontend/js/components.js'],
                     capture_output=True, text=True, check=True).stdout.split('\n')
OUT = 'js/components'

OPEN, CLOSE = '{([' , '})]'


def find(pat):
    rx = re.compile(pat)
    for i, l in enumerate(SRC):
        if rx.match(l):
            return i
    raise SystemExit('not found: ' + pat)


def extent(start):
    first = start
    probe = start - 1
    while probe >= 0 and SRC[probe].strip().startswith('//'):
        first = probe
        probe -= 1
    depth, opened = 0, False
    for i in range(start, len(SRC)):
        line = SRC[i]
        depth += sum(line.count(c) for c in OPEN) - sum(line.count(c) for c in CLOSE)
        if depth > 0:
            opened = True
        if opened and depth <= 0:
            return first, i + 1
    raise SystemExit('unbalanced from line %d' % (start + 1))


GROUPS = {
    'media': [r'// The previous ten were', r'const AVATAR_COLORS',
              r'export function hashColor', r'export function initialOf',
              r'export function avatarUrlOf', r'export function bannerUrlOf',
              r'function cacheMedia\(', r'function evictMedia\(',
              r'export function loadAuthedImage', r'export function invalidateAuthedImage',
              r'export function avatar\(', r'export function communityIconUrl',
              r'export function communityBannerUrl', r'export function communityMark'],
    'nav': [r'export function navGroup', r'export function navRow',
            r'export function serverChip'],
}

EXPORT = {
    'media': ['hashColor', 'initialOf', 'avatarUrlOf', 'bannerUrlOf', 'loadAuthedImage',
              'invalidateAuthedImage', 'avatar', 'communityIconUrl', 'communityBannerUrl',
              'communityMark'],
    'nav': ['navGroup', 'navRow', 'serverChip'],
}

AVAILABLE = [
    ('../ui.js', ['esc', 'el', 'clear', 'icon']),
    ('../ui/dom.js', ['icon', 'ICON_PATHS']),
    ('../state.js', ['State', 'peerPresence', 'isAuthed']),
    ('../api.js', ['Api']),
]


def strip(src):
    src = re.sub(r'/\*[\s\S]*?\*/', '', src)
    src = re.sub(r'(?m)^\s*//.*$', '', src)
    return re.sub(r"(?:from|require)\s*\(?\s*'[^']*'\s*\)?", "from ''", src)


PROSE = {
    'media': ("// Images behind authentication, and everything that draws an identity.\n"
              "//\n"
              "// The URL for an avatar on a private community is not the URL a browser could\n"
              "// fetch, so it is fetched with the session and handed out as an object URL. One\n"
              "// cache, one in-flight promise per path, and evicted on invalidation - a page that\n"
              "// changed its banner should not keep showing the old one."),
    'nav': ("// The three row shapes the navigations are built from.\n"
            "//\n"
            "// Every list in the application is one of these, so every list aligns the same way."),
}

os.makedirs(OUT, exist_ok=True)
for name, pats in GROUPS.items():
    parts = sorted(extent(find(p)) + (p,) for p in pats)
    body = '\n\n'.join('\n'.join(SRC[a:b]).rstrip() for a, b, _ in parts)
    code = strip(body)
    defined = set(re.findall(r'^(?:async )?function ([A-Za-z_$][\w$]*)', body, re.M))
    defined |= set(re.findall(r'^(?:const|let) ([A-Za-z_$][\w$]*)', body, re.M))

    reqs, used = [], set()
    if re.search(r'(?<![\w.$])Api\b', code) and 'Api' not in defined:
        reqs.append("import Api from '../api.js';")
        used.add('Api')
    for spec, names in AVAILABLE:
        hit = [n for n in names if n not in defined and n not in used
               and re.search(r'(?<![\w.$])' + re.escape(n) + r'\b', code)]
        if hit:
            used.update(hit)
            reqs.append("import { %s } from '%s';" % (', '.join(hit), spec))

    for n in EXPORT[name]:
        if re.search(r'^export (?:async )?function %s\b' % n, body, re.M):
            continue
        for cand in ('function %s(' % n, 'const %s =' % n, 'async function %s(' % n):
            if cand in body and ('export ' + cand) not in body:
                body = body.replace(cand, 'export ' + cand, 1)
                break
        else:
            print('  !! %s: %s not found to export' % (name, n))

    text = ''
    if reqs:
        text += '\n'.join(reqs) + '\n\n'
    text += PROSE[name] + '\n\n' + body + '\n'
    open(os.path.join(OUT, name + '.js'), 'w').write(text)
    print('  %-22s %d decl  %4d lines' % ('components/' + name + '.js', len(parts),
                                          body.count('\n') + 1))