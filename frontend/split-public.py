#!/usr/bin/env python3
"""One-shot splitter for frontend/js/public/public.js.

The signed-out surfaces and the backend picker, in one file. They shared it because they
share a page - which is also true of the admin console, which is now nine modules.

Run once, then delete.
"""
import os
import re
import sys

SRC = 'js/public/public.js'
OUT = 'js/public'

lines = open(SRC).read().split('\n')
OPEN, CLOSE = '{([' , '})]'


def find(pat, after=0):
    rx = re.compile(pat)
    for i in range(after, len(lines)):
        if rx.match(lines[i]):
            return i
    raise SystemExit('not found: ' + pat)


def extent(start):
    first = start
    probe = start - 1
    while probe >= 0 and lines[probe].strip().startswith('//'):
        first = probe
        probe -= 1
    depth, opened = 0, False
    for i in range(start, len(lines)):
        line = lines[i]
        depth += sum(line.count(c) for c in OPEN) - sum(line.count(c) for c in CLOSE)
        if depth > 0:
            opened = True
        if opened and depth <= 0:
            return first, i + 1
    raise SystemExit('unbalanced from line %d' % (start + 1))


GROUPS = {
    'auth': [r'function mountAuthPage\(', r'function authShell\(',
             r'function authFooter\(', r'function secondFactorStep\(',
             r'function loginForm\(', r'function registerForm\(',
             r'function forgotForm\(', r'function resetPasswordPage\('],
    'legal': [r'function legalPage\(', r'function verifyEmailPage\('],
    'backend': [r'export function renderBackendSelector\('],
}

# Where the shared bits go. The legal versions are needed by the register form's consent
# checkbox as well as by the legal pages themselves, so they live with the legal pages and
# the auth module asks for them.
TOP = {
    'legal': ["let legal = { termsVersion: '1.0', privacyVersion: '1.0' };",
              "Api.legal().then((l) => { if (l) legal = l; }).catch(() => {});",
              "const AUTH_BG = '/assets/trycord-login-bg.png';",
              "const AUTH_LOGO = '/assets/trycord-logo.png';"],
}

EXPORT = {
    'auth': ['mountAuthPage', 'loginForm', 'registerForm', 'forgotForm', 'resetPasswordPage'],
    'legal': ['legalPage', 'verifyEmailPage', 'legalVersions', 'AUTH_BG', 'AUTH_LOGO'],
    'backend': ['renderBackendSelector'],
}

PEERS = {'auth': ['legal'], 'legal': [], 'backend': []}

AVAILABLE = [
    ('../../api.js', ['Api']),
    ('../../ui.js', ['esc', 'el', 'clear', 'toast', 'openModal', 'confirmDialog', 'btn']),
    ('../../state.js', ['applyAuth', 'isAuthed', 'clearSession']),
    ('../../shell.js', ['renderContextHeader']),
    ('../../config.js', ['TrycordConfig']),
    ('../../nav.js', ['navigate', 'route']),
    ('../../realtime.js', []),
]


def strip(src):
    src = re.sub(r'/\*[\s\S]*?\*/', '', src)
    src = re.sub(r'(?m)^\s*//.*$', '', src)
    return re.sub(r"(?:from|require)\s*\(?\s*'[^']*'\s*\)?", "from ''", src)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, pats in GROUPS.items():
        parts = sorted(extent(find(p)) + (p,) for p in pats)
        body = '\n\n'.join('\n'.join(lines[a:b]).rstrip() for a, b, _ in parts)
        code = strip(body)
        defined = set(re.findall(r'^(?:async )?function ([A-Za-z_$][\w$]*)', body, re.M))
        defined |= set(re.findall(r'^(?:const|let) ([A-Za-z_$][\w$]*)', body, re.M))

        reqs, taken = [], set()

        def need(n, src_path, default=False):
            if n in defined or n in taken:
                return
            if not re.search(r'(?<![\w.$])' + re.escape(n) + r'\b', code):
                return
            taken.add(n)
            reqs.append("import %s%s from '%s';" % (
                '' if default else '{ %s } ' % n, n if default else '', src_path))

        for spec, names in AVAILABLE:
            for n in names:
                need(n, spec)
        if re.search(r'(?<![\w.$])Realtime\b', code):
            reqs.append("import Realtime from '../../realtime.js';")
            taken.add('Realtime')
        if re.search(r'(?<![\w.$])State\b', code):
            reqs.append("import State from '../../state.js';")
            taken.add('State')
        if re.search(r'(?<![\w.$])TrycordConfig\b', code):
            reqs.append("import { TrycordConfig } from '../../config.js';")
            taken.add('TrycordConfig')
        for peer in PEERS[name]:
            for n in EXPORT[peer]:
                need(n, './%s.js' % peer)

        pre = ''
        if name == 'legal':
            pre = ('// The published terms and privacy versions. The register form checks the\n'
                   '// reader accepted the versions that are live now, so it asks this module\n'
                   '// rather than fetching its own copy.\n'
                   "let versions = { termsVersion: '1.0', privacyVersion: '1.0' };\n\n"
                   'export function legalVersions() {\n  return versions;\n}\n\n'
                   'Api.legal().then((l) => { if (l) versions = l; }).catch(() => {});\n\n'
                   "export const AUTH_BG = '/assets/trycord-login-bg.png';\n"
                   "export const AUTH_LOGO = '/assets/trycord-logo.png';\n\n")

        for n in EXPORT[name]:
            if re.search(r'^export (?:async )?function %s\b' % n, body, re.M):
                continue
            for cand in ('function %s(' % n, 'const %s =' % n, 'async function %s(' % n):
                if cand in body and ('export ' + cand) not in body:
                    body = body.replace(cand, 'export ' + cand, 1)
                    break

        open(os.path.join(OUT, name + '.js'), 'w').write(
            ('\n'.join(reqs) + '\n\n') + pre + body + '\n')
        print('  %-22s %d decl  %4d lines' % ('public/' + name + '.js', len(parts),
                                              body.count('\n') + 1))


if __name__ == '__main__':
    main()