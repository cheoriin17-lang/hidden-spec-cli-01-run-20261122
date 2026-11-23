// mend: one patch tool for every AI edit format.
//
// Written from SPEC.md (version 1) alone: unified diffs, SEARCH/REPLACE
// blocks, V4A patches and JSON editor calls, applied atomically to a tree
// of text files. Node 22 standard library only.
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

type Brk = '\n' | '\r\n';

/** A file as lines plus its own line break and final-break state. */
interface FileState {
  lines: string[];
  brk: Brk;
  ends: boolean;
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
}

/** One hunk of a unified diff section. `a` is the old start line (1-based). */
interface Hunk {
  a: number;
  body: BodyLine[];
}

/** One chunk of a V4A update section. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

type Edit =
  | { kind: 'unified'; oldPath: string | null; newPath: string | null; isCreate: boolean; isDelete: boolean; hunks: Hunk[] }
  | { kind: 'sr'; path: string; oldLines: string[]; newLines: string[] }
  | { kind: 'v4a-add'; path: string; lines: string[] }
  | { kind: 'v4a-delete'; path: string }
  | { kind: 'v4a-update'; path: string; moveTo: string | null; chunks: VChunk[] }
  | { kind: 'json-create'; path: string; text: string }
  | { kind: 'json-str'; path: string; oldStr: string; newStr: string }
  | { kind: 'json-insert'; path: string; line: number; newStr: string };

interface EditFailure {
  code: string;
  path: string;
}

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

/** Split patch text into lines: split at \n, strip one trailing \r each, drop the empty piece after a final \n. */
function splitPatchLines(text: string): string[] {
  const parts = text.split('\n').map((s) => (s.endsWith('\r') ? s.slice(0, -1) : s));
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

/** Split a file's text into lines, its line break and its final-break state. */
function parseFile(text: string): FileState {
  if (text === '') return { lines: [], brk: '\n', ends: false };
  const nl = text.indexOf('\n');
  const brk: Brk = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  let ends = false;
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
    ends = true;
  }
  return { lines: parts, brk, ends };
}

/** Render a file back: its own break between lines, a final one exactly when `ends`. */
function renderFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.brk) + (st.ends ? st.brk : '');
}

/** A path is safe when it is not empty, not absolute, holds no backslash, and no segment is empty, . or ... */
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** Compare strings in UTF-8 byte order. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A line compared at a matching tier: 0 exact, 1 trailing spaces/tabs off, 2 both sides off. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Tier-2 re-indent: a non-blank line starting with P has that P replaced by F. */
function reindent(line: string, p: string, f: string): string {
  if (line.length === 0) return line;
  if (line.trim() === '') return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/** Positions where `pat` occurs in `lines` at `tier`, at or after `from`; `eofOnly` keeps only occurrences ending at the last line. */
function occurrences(lines: string[], pat: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  const lastStart = lines.length - pat.length;
  for (let i = from; i <= lastStart; i++) {
    if (eofOnly && i !== lastStart) continue;
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (normLine(lines[i + j], tier) !== normLine(pat[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** Build the replacement lines for a matched hunk/chunk: context lines come from the file itself, added lines from the patch (re-indented at tier 2). */
function buildReplacement(body: BodyLine[], fileLines: string[], at: number, tier: number): string[] {
  let firstOld: string | null = null;
  for (const item of body) {
    if (item.kind === 'ctx' || item.kind === 'del') {
      firstOld = item.text;
      break;
    }
  }
  const p = firstOld === null ? '' : leadingWs(firstOld);
  const f = at < fileLines.length ? leadingWs(fileLines[at]) : '';
  const out: string[] = [];
  let oPos = 0;
  for (const item of body) {
    if (item.kind === 'ctx') {
      out.push(fileLines[at + oPos]);
      oPos++;
    } else if (item.kind === 'del') {
      oPos++;
    } else if (item.kind === 'add') {
      out.push(tier === 2 ? reindent(item.text, p, f) : item.text);
    }
  }
  return out;
}

/** True when a `\` line follows the body's last context or `+` line (it then marks the new text as having no final line break). */
function lastCtxOrAddFollowedByBs(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i].kind === 'ctx' || body[i].kind === 'add') last = i;
  }
  if (last < 0) return false;
  return last + 1 < body.length && body[last + 1].kind === 'bs';
}

/** The command line: --format=NAME, --check, --strict, [PATCH], with -- ending the options. Null on a usage error. */
function parseArgs(argv: string[]): { format: string; check: boolean; strict: boolean; patch: string | null } | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenCheck = false;
  let seenStrict = false;
  let seenFormat = false;
  const positional: string[] = [];
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return null;
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return null;
        format = v;
      } else {
        return null;
      }
    } else {
      positional.push(a);
      if (positional.length > 1) return null;
    }
  }
  return { format: format ?? 'auto', check, strict, patch: positional.length === 0 ? null : positional[0] };
}

/** Detect the patch format from its lines; null when none matches. */
function detectFormat(lines: string[]): string | null {
  let firstNonBlank: string | null = null;
  for (const l of lines) {
    if (l.trim() !== '') {
      firstNonBlank = l.trim();
      break;
    }
  }
  if (firstNonBlank !== null) {
    if (firstNonBlank === '*** Begin Patch') return 'v4a';
    const c = firstNonBlank[0];
    if (c === '[' || c === '{') return 'json';
  }
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

/** Read every regular file under `dir` into a path -> text map (paths use /). */
function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      const rel = prefix === '' ? name : prefix + '/' + name;
      if (st.isDirectory()) walk(p, rel);
      else if (st.isFile()) out.set(rel, readFileSync(p, 'utf8'));
    }
  };
  walk(dir, '');
  return out;
}

/** Write the differences between the initial and final trees to disk: deletions first, then writes. */
function writeTree(initial: Map<string, string>, finalTree: Map<string, string>): void {
  for (const p of initial.keys()) {
    if (!finalTree.has(p)) unlinkSync(p);
  }
  for (const [p, content] of finalTree) {
    if (initial.get(p) !== content) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, 'utf8');
    }
  }
}

/** The stdout lines for a successful run: A/D/M per changed path, R for a move pair, sorted in UTF-8 byte order of the path (the new path for R). */
function computeChanges(initial: Map<string, string>, finalTree: Map<string, string>, moves: [string, string][]): string[] {
  const lines: { key: string; text: string }[] = [];
  const moveNew = new Set<string>();
  const moveOld = new Set<string>();
  for (const [o, n] of moves) {
    if (initial.has(o) && !finalTree.has(o) && !initial.has(n) && finalTree.has(n)) {
      lines.push({ key: n, text: `R ${o} -> ${n}` });
      moveNew.add(n);
      moveOld.add(o);
    }
  }
  for (const [p, content] of finalTree) {
    if (moveNew.has(p)) continue;
    if (!initial.has(p)) lines.push({ key: p, text: `A ${p}` });
    else if (initial.get(p) !== content) lines.push({ key: p, text: `M ${p}` });
  }
  for (const p of initial.keys()) {
    if (moveOld.has(p)) continue;
    if (!finalTree.has(p)) lines.push({ key: p, text: `D ${p}` });
  }
  lines.sort((a, b) => byteCompare(a.key, b.key));
  return lines.map((l) => l.text);
}

/** Write stdout lines (each with a trailing line feed) and set the exit code. */
function emit(lines: string[], code: number): void {
  process.stdout.write(lines.map((l) => l + '\n').join(''));
  process.exitCode = code;
}

/** A hunk header `@@ -A[,B] +C[,D] @@` with optional trailing text; null when the line is not one. */
function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) return null;
  return Number(m[1]);
}

/** A path from a `--- ` / `+++ ` header line: after the four characters, up to the first tab, surrounding spaces removed, one leading a/ or b/ removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

/** Parse a unified diff into one edit per section. */
function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let cur: { oldPath: string | null; newPath: string | null; hasPair: boolean; isCreate: boolean; isDelete: boolean; hunks: Hunk[] } | null = null;
  let hasHunk = false;
  const closeSection = (): void => {
    if (cur !== null) {
      edits.push({ kind: 'unified', oldPath: cur.oldPath, newPath: cur.newPath, isCreate: cur.isCreate, isDelete: cur.isDelete, hunks: cur.hunks });
      cur = null;
    }
    hasHunk = false;
  };
  const startDiffSection = (line: string, num: number): void => {
    const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(line);
    if (m === null) throw new ParseError(num);
    closeSection();
    cur = { oldPath: m[1], newPath: m[2], hasPair: false, isCreate: false, isDelete: false, hunks: [] };
  };
  const startPairSection = (i: number): number => {
    closeSection();
    const oldPath = headerPath(lines[i]);
    const newPath = headerPath(lines[i + 1]);
    cur = { oldPath, newPath, hasPair: true, isCreate: false, isDelete: false, hunks: [] };
    return i + 2;
  };
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      startDiffSection(line, i + 1);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      if (cur !== null && hasHunk) {
        i = startPairSection(i);
      } else if (cur !== null) {
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]);
        cur.hasPair = true;
        i += 2;
      } else {
        i = startPairSection(i);
      }
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseError(i + 1);
      const a = parseHunkHeader(line);
      if (a === null) throw new ParseError(i + 1);
      i++;
      const body: BodyLine[] = [];
      while (i < n) {
        const b = lines[i];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) break;
        if (b.startsWith(' ')) body.push({ kind: 'ctx', text: b.slice(1) });
        else if (b.startsWith('-')) body.push({ kind: 'del', text: b.slice(1) });
        else if (b.startsWith('+')) body.push({ kind: 'add', text: b.slice(1) });
        else if (b.startsWith('\\')) body.push({ kind: 'bs', text: b.slice(1) });
        else if (b === '') body.push({ kind: 'ctx', text: '' });
        else break;
        i++;
      }
      while (body.length > 0 && body[body.length - 1].kind === 'ctx' && body[body.length - 1].text === '' && lines[i - 1] === '') {
        body.pop();
        i--;
      }
      cur.hunks.push({ a, body });
      hasHunk = true;
      continue;
    }
    if (cur !== null && !hasHunk) {
      if (line.startsWith('--- ')) throw new ParseError(i + 2);
      if (line.startsWith('+++ ')) cur.newPath = headerPath(line);
      else if (line.startsWith('rename from ')) {
        if (!cur.hasPair) cur.oldPath = line.slice(12).trim();
      } else if (line.startsWith('rename to ')) {
        if (!cur.hasPair) cur.newPath = line.slice(10).trim();
      } else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  closeSection();
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

/** Apply a section's hunks in order to a file's state; `path` names the file for failure reports. */
function applyHunks(st: FileState, hunks: Hunk[], strict: boolean, path: string): EditFailure | null {
  let d = 0;
  for (const h of hunks) {
    const oLines: string[] = [];
    let nCount = 0;
    for (const item of h.body) {
      if (item.kind === 'ctx' || item.kind === 'del') oLines.push(item.text);
      if (item.kind === 'ctx' || item.kind === 'add') nCount++;
    }
    if (oLines.length > 0) {
      const tiers = strict ? [0] : [0, 1, 2];
      let foundTier = -1;
      let occ: number[] = [];
      for (const t of tiers) {
        occ = occurrences(st.lines, oLines, t, 0, false);
        if (occ.length > 0) {
          foundTier = t;
          break;
        }
      }
      if (foundTier < 0) return { code: 'no-match', path };
      const target = h.a - 1 + d;
      let best = occ[0];
      let bestDist = Math.abs(best - target);
      for (const pos of occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const repl = buildReplacement(h.body, st.lines, best, foundTier);
      const matchedToEnd = best + oLines.length === st.lines.length;
      st.lines.splice(best, oLines.length, ...repl);
      if (matchedToEnd) st.ends = !lastCtxOrAddFollowedByBs(h.body);
      d += nCount - oLines.length;
    } else {
      const adds: string[] = [];
      for (const item of h.body) {
        if (item.kind === 'add') adds.push(item.text);
      }
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > st.lines.length) at = st.lines.length;
      const atEnd = at === st.lines.length;
      st.lines.splice(at, 0, ...adds);
      if (atEnd) st.ends = !lastCtxOrAddFollowedByBs(h.body);
      d += adds.length;
    }
  }
  return null;
}

/** Apply one unified section edit to the tree. */
function applyUnified(tree: Map<string, string>, edit: Extract<Edit, { kind: 'unified' }>, strict: boolean, moves: [string, string][]): EditFailure | null {
  if (edit.oldPath !== null && !isSafePath(edit.oldPath)) return { code: 'unsafe', path: edit.oldPath };
  if (edit.newPath !== null && !isSafePath(edit.newPath)) return { code: 'unsafe', path: edit.newPath };
  if (edit.isCreate || edit.oldPath === null) {
    const np = edit.newPath;
    if (np === null) return { code: 'unsafe', path: '' };
    if (tree.has(np)) return { code: 'exists', path: np };
    const lines: string[] = [];
    let ends = false;
    for (const h of edit.hunks) {
      for (let i = 0; i < h.body.length; i++) {
        if (h.body[i].kind === 'add') {
          lines.push(h.body[i].text);
          ends = !(i + 1 < h.body.length && h.body[i + 1].kind === 'bs');
        }
      }
    }
    tree.set(np, renderFile({ lines, brk: '\n', ends: lines.length > 0 ? ends : false }));
    return null;
  }
  if (edit.isDelete || edit.newPath === null) {
    const op = edit.oldPath;
    if (op === null) return { code: 'unsafe', path: '' };
    if (!tree.has(op)) return { code: 'missing', path: op };
    tree.delete(op);
    return null;
  }
  if (edit.oldPath !== edit.newPath) {
    if (!tree.has(edit.oldPath)) return { code: 'missing', path: edit.oldPath };
    if (tree.has(edit.newPath)) return { code: 'exists', path: edit.newPath };
    const st = parseFile(tree.get(edit.oldPath) as string);
    const fail = applyHunks(st, edit.hunks, strict, edit.oldPath);
    if (fail !== null) return fail;
    tree.delete(edit.oldPath);
    tree.set(edit.newPath, renderFile(st));
    moves.push([edit.oldPath, edit.newPath]);
    return null;
  }
  if (!tree.has(edit.oldPath)) return { code: 'missing', path: edit.oldPath };
  const st = parseFile(tree.get(edit.oldPath) as string);
  const fail = applyHunks(st, edit.hunks, strict, edit.oldPath);
  if (fail !== null) return fail;
  tree.set(edit.oldPath, renderFile(st));
  return null;
}

/** Parse SEARCH/REPLACE blocks into edits. */
function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const t = lines[j].trim();
        if (t === '') continue;
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new ParseError(searchLine);
      let eq = -1;
      for (let j = i + 1; j < n; j++) {
        if (lines[j].trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq === -1) throw new ParseError(searchLine);
      let rep = -1;
      for (let j = eq + 1; j < n; j++) {
        if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new ParseError(searchLine);
      edits.push({ kind: 'sr', path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevEnd = rep + 1;
      i = rep + 1;
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

/** Apply one SEARCH/REPLACE block: an empty old side creates the file, otherwise the old lines must occur exactly once at their tier. */
function applySR(tree: Map<string, string>, edit: Extract<Edit, { kind: 'sr' }>, strict: boolean): EditFailure | null {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
  if (edit.oldLines.length === 0) {
    if (tree.has(edit.path)) return { code: 'exists', path: edit.path };
    tree.set(edit.path, renderFile({ lines: edit.newLines, brk: '\n', ends: edit.newLines.length > 0 }));
    return null;
  }
  if (!tree.has(edit.path)) return { code: 'missing', path: edit.path };
  const st = parseFile(tree.get(edit.path) as string);
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(st.lines, edit.oldLines, t, 0, false);
    if (occ.length === 0) continue;
    if (occ.length > 1) return { code: 'ambiguous', path: edit.path };
    const at = occ[0];
    const p = leadingWs(edit.oldLines[0]);
    const f = leadingWs(st.lines[at]);
    const repl = edit.newLines.map((l) => (t === 2 ? reindent(l, p, f) : l));
    st.lines.splice(at, edit.oldLines.length, ...repl);
    tree.set(edit.path, renderFile(st));
    return null;
  }
  return { code: 'no-match', path: edit.path };
}

/** True when a line starts a V4A section. */
function isV4aSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

/** Parse a V4A patch into one edit per section. */
function parseV4a(lines: string[]): Edit[] {
  const n = lines.length;
  const isBlank = (s: string): boolean => s.trim() === '';
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseError(n + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i])) {
      i++;
      continue;
    }
    const line = lines[i];
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      i++;
      const raw: { text: string; num: number }[] = [];
      while (i < last && !isV4aSectionStart(lines[i])) {
        raw.push({ text: lines[i], num: i + 1 });
        i++;
      }
      while (raw.length > 0 && isBlank(raw[raw.length - 1].text)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new ParseError(r.num);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1].trim() === '') fileLines.pop();
      edits.push({ kind: 'v4a-add', path, lines: fileLines });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      i++;
      while (i < last && !isV4aSectionStart(lines[i])) {
        if (!isBlank(lines[i])) throw new ParseError(i + 1);
        i++;
      }
      edits.push({ kind: 'v4a-delete', path });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last && !isV4aSectionStart(lines[i])) {
        const l = lines[i];
        if (l.startsWith('*** Move to: ')) {
          if (moveTo !== null || cur !== null || chunks.length > 0) throw new ParseError(i + 1);
          moveTo = l.slice(13).trim();
          i++;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new ParseError(i + 1);
          cur.eof = true;
          closeChunk();
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk();
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          i++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new ParseError(i + 1);
            cur = { anchor: null, eof: false, body: [] };
          }
          if (l.startsWith(' ')) cur.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) cur.body.push({ kind: 'del', text: l.slice(1) });
          else cur.body.push({ kind: 'add', text: l.slice(1) });
          i++;
          continue;
        }
        if (isBlank(l)) {
          if (cur !== null) cur.body.push({ kind: 'ctx', text: '' });
          i++;
          continue;
        }
        throw new ParseError(i + 1);
      }
      if (cur !== null) {
        while (cur.body.length > 0) {
          const b = cur.body[cur.body.length - 1];
          if (b.kind !== 'bs' && b.text.trim() === '') cur.body.pop();
          else break;
        }
        closeChunk();
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseError(updateLine);
      edits.push({ kind: 'v4a-update', path, moveTo, chunks });
      continue;
    }
    throw new ParseError(i + 1);
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

/** Apply one V4A section edit to the tree. */
function applyV4a(tree: Map<string, string>, edit: Edit, strict: boolean, moves: [string, string][]): EditFailure | null {
  if (edit.kind === 'v4a-add') {
    if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
    if (tree.has(edit.path)) return { code: 'exists', path: edit.path };
    tree.set(edit.path, renderFile({ lines: edit.lines, brk: '\n', ends: edit.lines.length > 0 }));
    return null;
  }
  if (edit.kind === 'v4a-delete') {
    if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
    if (!tree.has(edit.path)) return { code: 'missing', path: edit.path };
    tree.delete(edit.path);
    return null;
  }
  if (edit.kind !== 'v4a-update') return null;
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
  if (edit.moveTo !== null && !isSafePath(edit.moveTo)) return { code: 'unsafe', path: edit.moveTo };
  if (!tree.has(edit.path)) return { code: 'missing', path: edit.path };
  if (edit.moveTo !== null && tree.has(edit.moveTo)) return { code: 'exists', path: edit.moveTo };
  const st = parseFile(tree.get(edit.path) as string);
  const tiers = strict ? [0] : [0, 1, 2];
  let cursor = 0;
  for (const ch of edit.chunks) {
    if (ch.anchor !== null) {
      let found = -1;
      for (const t of tiers) {
        for (let idx = cursor; idx < st.lines.length; idx++) {
          if (normLine(st.lines[idx], t) === normLine(ch.anchor as string, t)) {
            found = idx;
            break;
          }
        }
        if (found !== -1) break;
      }
      if (found === -1) return { code: 'no-match', path: edit.path };
      cursor = found + 1;
    }
    const oLines: string[] = [];
    for (const item of ch.body) {
      if (item.kind === 'ctx' || item.kind === 'del') oLines.push(item.text);
    }
    if (oLines.length === 0) {
      const adds: string[] = [];
      for (const item of ch.body) {
        if (item.kind === 'add') adds.push(item.text);
      }
      const at = ch.eof ? st.lines.length : cursor;
      st.lines.splice(at, 0, ...adds);
      cursor = at + adds.length;
    } else {
      let hit: { tier: number; at: number } | null = null;
      for (const t of tiers) {
        const occ = occurrences(st.lines, oLines, t, cursor, ch.eof);
        if (occ.length > 0) {
          hit = { tier: t, at: occ[0] };
          break;
        }
      }
      if (hit === null) return { code: 'no-match', path: edit.path };
      const repl = buildReplacement(ch.body, st.lines, hit.at, hit.tier);
      st.lines.splice(hit.at, oLines.length, ...repl);
      cursor = hit.at + repl.length;
    }
  }
  const rendered = renderFile(st);
  if (edit.moveTo !== null) {
    tree.delete(edit.path);
    tree.set(edit.moveTo, rendered);
    moves.push([edit.path, edit.moveTo]);
  } else {
    tree.set(edit.path, rendered);
  }
  return null;
}

/** Validate one JSON edit object; any fault is a parse error at `line`. */
function jsonEditObject(el: unknown, line: number): Edit {
  if (el === null || typeof el !== 'object' || Array.isArray(el)) throw new ParseError(line);
  const o = el as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseError(line);
  if (typeof o.command !== 'string') throw new ParseError(line);
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseError(line);
    return { kind: 'json-create', path: o.path, text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseError(line);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseError(line);
    return { kind: 'json-str', path: o.path, oldStr: o.old_str, newStr: (o.new_str as string | undefined) ?? '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseError(line);
    if (typeof o.new_str !== 'string') throw new ParseError(line);
    return { kind: 'json-insert', path: o.path, line: o.insert_line, newStr: o.new_str };
  }
  throw new ParseError(line);
}

/** Parse a JSON patch: one array of edit objects, or JSON Lines with one edit object a line. */
function parseJson(patchText: string, lines: string[]): Edit[] {
  let firstIdx = -1;
  for (let k = 0; k < patchText.length; k++) {
    const c = patchText[k];
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') {
      firstIdx = k;
      break;
    }
  }
  if (firstIdx === -1) throw new ParseError(1);
  if (patchText[firstIdx] === '[') {
    let arrayLine = 1;
    for (let k = 0; k < firstIdx; k++) {
      if (patchText[k] === '\n') arrayLine++;
    }
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseError(arrayLine);
    }
    if (!Array.isArray(arr)) throw new ParseError(arrayLine);
    const edits: Edit[] = [];
    for (const el of arr) edits.push(jsonEditObject(el, arrayLine));
    if (edits.length === 0) throw new ParseError(1);
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      throw new ParseError(i + 1);
    }
    edits.push(jsonEditObject(obj, i + 1));
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

/** Split a JSON insert's `new_str` into lines: split at \n, strip one trailing \r each, drop the empty piece after a final \n. */
function splitNewStr(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n').map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
  if (s.endsWith('\n')) parts.pop();
  return parts;
}

/** Apply one JSON edit to the tree. */
function applyJson(tree: Map<string, string>, edit: Edit): EditFailure | null {
  if (edit.kind === 'json-create') {
    if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
    if (tree.has(edit.path)) return { code: 'exists', path: edit.path };
    tree.set(edit.path, edit.text);
    return null;
  }
  if (edit.kind === 'json-str') {
    if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
    if (!tree.has(edit.path)) return { code: 'missing', path: edit.path };
    const raw = tree.get(edit.path) as string;
    const nl = raw.indexOf('\n');
    const isCrlf = nl > 0 && raw[nl - 1] === '\r';
    let text = raw;
    let oldS = edit.oldStr;
    let newS = edit.newStr;
    if (isCrlf) {
      text = raw.replace(/\r\n/g, '\n');
      oldS = oldS.replace(/\r\n/g, '\n');
      newS = newS.replace(/\r\n/g, '\n');
    }
    let count = 0;
    let first = -1;
    let idx = 0;
    for (;;) {
      const p = text.indexOf(oldS, idx);
      if (p === -1) break;
      count++;
      if (first === -1) first = p;
      idx = p + 1;
    }
    if (count === 0) return { code: 'no-match', path: edit.path };
    if (count > 1) return { code: 'ambiguous', path: edit.path };
    let out = text.slice(0, first) + newS + text.slice(first + oldS.length);
    if (isCrlf) out = out.replace(/\n/g, '\r\n');
    tree.set(edit.path, out);
    return null;
  }
  if (edit.kind === 'json-insert') {
    if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
    if (!tree.has(edit.path)) return { code: 'missing', path: edit.path };
    const st = parseFile(tree.get(edit.path) as string);
    if (edit.line < 0 || edit.line > st.lines.length) return { code: 'no-match', path: edit.path };
    st.lines.splice(edit.line, 0, ...splitNewStr(edit.newStr));
    tree.set(edit.path, renderFile(st));
    return null;
  }
  return null;
}

/** Apply one edit of any format to the tree; a failure leaves the tree unchanged for that edit. */
function applyEdit(tree: Map<string, string>, edit: Edit, strict: boolean, moves: [string, string][]): EditFailure | null {
  if (edit.kind === 'unified') return applyUnified(tree, edit, strict, moves);
  if (edit.kind === 'sr') return applySR(tree, edit, strict);
  if (edit.kind === 'v4a-add' || edit.kind === 'v4a-delete' || edit.kind === 'v4a-update') return applyV4a(tree, edit, strict, moves);
  return applyJson(tree, edit);
}

/** The CLI: parse arguments, read the patch, parse it, apply its edits to the tree, report. */
function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === null) {
    emit(['error: usage'], 2);
    return;
  }
  let patchText: string;
  if (parsed.patch === null || parsed.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(parsed.patch, 'utf8');
    } catch {
      emit(['error: no-patch'], 2);
      return;
    }
  }
  const lines = splitPatchLines(patchText);
  let format = parsed.format;
  if (format === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) {
      emit(['error: format'], 2);
      return;
    }
    format = detected;
  }
  let edits: Edit[];
  try {
    if (format === 'unified') edits = parseUnified(lines);
    else if (format === 'search-replace') edits = parseSearchReplace(lines);
    else if (format === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(patchText, lines);
  } catch (e) {
    if (e instanceof ParseError) {
      emit([`error: parse ${e.line}`], 2);
      return;
    }
    throw e;
  }
  const initial = readTree('.');
  const tree = new Map(initial);
  const failures: EditFailure[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    const f = applyEdit(tree, edit, parsed.strict, moves);
    if (f !== null) failures.push(f);
  }
  if (failures.length > 0) {
    const out: string[] = [];
    for (const f of failures) out.push(`error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    emit(out, 1);
    return;
  }
  const changeLines = computeChanges(initial, tree, moves);
  if (!parsed.check) writeTree(initial, tree);
  emit([...changeLines, `ok: ${changeLines.length} ${changeLines.length === 1 ? 'file' : 'files'}`], 0);
}

if (process.env.MAKEFUN_ENV_URL) {
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  main();
}
