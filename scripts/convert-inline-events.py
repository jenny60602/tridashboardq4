#!/usr/bin/env python3
"""One-off migration helper: replace HTML event attributes in index.html with
data-ui-* JSON produced by uiEvent(). Prints a summary; refuses unknown patterns.
Not part of the runtime; kept in the PR so the conversion can be reviewed/re-run."""
import re
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else 'index.html'
src = open(PATH, encoding='utf-8').read()
script_start = src.index('<script>')

# Exact expressions that need a dedicated action (no generic fn(args) form).
SPECIAL = {
    "document.getElementById('restorebanner').innerHTML=''": ('ignoreBackup', [], None, False),
    "document.getElementById('undotoast').innerHTML=''": ('clearUndoToast', [], None, False),
    "inboxShowDone=!inboxShowDone;renderInbox()": ('toggleInboxShowDone', [], None, False),
    "event.stopPropagation()": ('stopClick', [], None, True),
    "if(event.key==='Enter')login()": ('loginEnter', [], None, False),
    "event.preventDefault();this.classList.add('dragover');": ('dragOverTask', [], None, False),
    "event.preventDefault();event.stopPropagation();this.classList.add('dragover-row');": ('dragOverRow', [], None, True),
    "this.classList.remove('dragover-row');": ('dragLeaveRow', [], None, False),
    "this.classList.remove('dragover');": ('dragLeaveTask', [], None, False),
}
INPUTS = {
    'this.value': 'value',
    'this.checked': 'checked',
    "this.value===''?null:Number(this.value)": 'numberOrNull',
    "this.value===''?0:Number(this.value)": 'numberOrZero',
    'this.value.trim()': 'trimmed',
    'Math.max(1,Math.min(24,Number(this.value)||2))': 'installments',
}


def split_args(s):
    out, depth, cur, quote = [], 0, '', None
    for ch in s:
        if quote:
            cur += ch
            if ch == quote:
                quote = None
            continue
        if ch in "'\"":
            quote = ch
        elif ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
        elif ch == ',' and depth == 0:
            out.append(cur)
            cur = ''
            continue
        cur += ch
    if cur.strip():
        out.append(cur)
    return [a.strip() for a in out]


def js_arg(a):
    m = re.fullmatch(r"'\$\{([^}]+)\}'", a)
    if m:
        return 'String(' + m.group(1) + ')'
    m = re.fullmatch(r"\$\{jsArg\((.+)\)\}", a)
    if m:
        return 'jsStr(' + m.group(1) + ')'
    m = re.fullmatch(r"\$\{([^}]+)\}", a)
    if m:
        return m.group(1)
    if re.fullmatch(r"'[^'$\\]*'", a) or re.fullmatch(r"-?\d+", a):
        return a
    raise ValueError('unsupported argument: ' + a)


def parse(expr):
    if expr in SPECIAL:
        return SPECIAL[expr]
    stop = False
    if expr.startswith('event.stopPropagation();'):
        stop, expr = True, expr[len('event.stopPropagation();'):]
    m = re.fullmatch(r"if\(event\.key==='Enter'\)([A-Za-z_]+)\((.*)\)", expr)
    if m:
        return (m.group(1) + 'Enter', [js_arg(a) for a in split_args(m.group(2))], None, stop)
    m = re.fullmatch(r"this\.classList\.remove\('dragover'\);handleSubtaskDrop\(event,(.*)\)", expr)
    if m:
        return ('dropSubtask', [js_arg(a) for a in split_args(m.group(1))], None, stop)
    m = re.fullmatch(r"this\.classList\.remove\('dragover-row'\);handleSubtaskDropAt\(event,(.*)\)", expr)
    if m:
        return ('dropSubtaskAt', [js_arg(a) for a in split_args(m.group(1))], None, stop)
    m = re.fullmatch(r"handleSubtaskDragStart\(event,(.*)\)", expr)
    if m:
        return ('handleSubtaskDragStart', [js_arg(a) for a in split_args(m.group(1))], None, stop)
    m = re.fullmatch(r"([A-Za-z_]+)\((.*)\)", expr)
    if not m:
        raise ValueError('unsupported handler: ' + expr)
    fn, args = m.group(1), split_args(m.group(2))
    inp = None
    if args and args[-1] in INPUTS:
        inp = INPUTS[args.pop()]
    return (fn, [js_arg(a) for a in args], inp, stop)


counts = {}
actions = {}


def repl(m):
    typ, expr = m.group(1), m.group(2)
    action, args, inp, stop = parse(expr)
    counts[typ] = counts.get(typ, 0) + 1
    actions.setdefault(typ, set()).add(action)
    parts = [repr_js(typ), repr_js(action), '[' + ','.join(args) + ']']
    if inp or stop:
        parts.append(repr_js(inp) if inp else 'null')
    if stop:
        parts.append('true')
    return ' ${uiEvent(' + ','.join(parts) + ')}'


def repr_js(s):
    return "'" + s + "'"


# Static HTML (before <script>) is handled explicitly.
static = ' onclick="manualRefresh()"'
assert src.count(static) == 1
src = src.replace(static, ' data-ui-click="{&quot;action&quot;:&quot;manualRefresh&quot;,&quot;args&quot;:[]}"')
script_start = src.index('<script>')

# The jsArg comment mentions onclick="foo(...)"; reword it so only real handlers remain.
old_comment = '// jsArg：放進 onclick="foo(...)" 的參數（先轉成 JS 字串，再做 HTML 跳脫；使用時不要再加引號）'
assert src.count(old_comment) == 1
src = src.replace(old_comment, '// jsArg：把值轉成 JS 字串再做 HTML 跳脫（舊式事件屬性用；新程式請用 uiEvent）')
# After conversion jsArg/the comment above are unused and were removed by hand in the same commit.

pattern = re.compile(r'\son(click|change|input|keydown|dragstart|dragover|dragleave|drop)="([^"]*)"')
src = src[:script_start] + pattern.sub(repl, src[script_start:])
left = re.findall(r'\son[a-z]+="', src[script_start:])
open(PATH, 'w', encoding='utf-8').write(src)
print('converted per event type:', counts, 'total', sum(counts.values()))
print('remaining HTML event attributes in script:', len(left))
for t, a in sorted(actions.items()):
    print(t, sorted(a))
