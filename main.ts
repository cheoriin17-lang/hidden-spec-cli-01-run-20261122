// main.ts — mend, the patch tool SPEC.md describes. Node 22, standard library only.
// Run as `node main.ts [options] [PATCH]`.
//
// mend reads one patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON tool calls) and applies its edits to the tree in the working
// directory. Every edit succeeds or the whole patch fails: on any failure nothing
// is written and every failure is reported. Exit codes, stdout and the files left
// behind are exactly what SPEC.md sections 1-10 say.
//
// The entry point is run() at the bottom; the last lines hand a trial over to
// runner.ts when MAKEFUN_ENV_URL is set, exactly as the kit's starter does.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 error: the single line printed on stdout. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: a path is safe when it is not empty, not absolute, holds no
 * backslash, and none of its segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** The tree as the edits leave it. `now` holds every path an edit touched
 * (null means deleted); anything else is read from disk on demand. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, in the order the edits made them. */
  readonly moved: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** SPEC.md section 4: with --format=auto the format is the first of these that holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  )
    return 'unified';
  return null;
}

// ---- Section 9: JSON edits. ----

/** One JSON edit object, or null when it is not one (a wrong command, or a missing
 * or mistyped key, is a parse fault — the caller turns null into one). */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  const existing = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }

  return null;
}

/** The patch is one JSON array of edit objects, or JSON Lines: one edit object a
 * line, blank lines ignored. Any fault is a parse error naming its line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 3: a file's lines, its line break and its final break. ----

interface FileState {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(fs: FileState): string {
  if (fs.lines.length === 0) return '';
  return fs.lines.join(fs.br) + (fs.final ? fs.br : '');
}

// ---- Section 5: matching lines at three tiers. ----

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Positions at which `pat` occurs in `lines` at `tier`, at or after `from`.
 * Occurrences may overlap. */
function tierOccurrences(lines: string[], pat: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (!lineEq(lines[i + j]!, pat[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; 0 only with --strict) at which `pat` occurs,
 * with its positions. */
function findTier(
  lines: string[],
  pat: string[],
  from: number,
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = tierOccurrences(lines, pat, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to `anchor` at the first tier where one
 * is (a single line matched both sides, section 8). */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    for (let i = Math.max(0, from); i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return -1;
}

const leadingWS = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/** One line of N: either a context line (written as the file's own matched line)
 * or a new line (written as the patch wrote it, re-indented at tier 2). */
interface NLine {
  text: string;
  ctx: boolean;
  /** Index into O of the context line this N line is, when ctx. */
  oIdx: number;
}

/** Build the replacement for a match at `pos`: context lines come from the file,
 * other lines are re-indented at tier 2 (leading whitespace P of O's first line
 * replaced by F, the file's first matched line's leading whitespace). */
function buildReplacement(
  fileLines: string[],
  pos: number,
  oLines: string[],
  nLines: NLine[],
  tier: number,
): string[] {
  const F = leadingWS(fileLines[pos]!);
  const P = leadingWS(oLines[0]!);
  return nLines.map((nl) => {
    if (nl.ctx) return fileLines[pos + nl.oIdx]!;
    if (tier !== 2) return nl.text;
    if (nl.text === '' || /^[ \t]+$/.test(nl.text)) return nl.text;
    if (nl.text.startsWith(P)) return F + nl.text.slice(P.length);
    return nl.text;
  });
}

// ---- Body lines shared by unified hunks and V4A chunks. ----

type BodyLine = { k: 'ctx' | 'old' | 'new' | 'mark'; text: string };

function bodyLine(l: string): BodyLine {
  if (l === '') return { k: 'ctx', text: '' };
  if (l[0] === ' ') return { k: 'ctx', text: l.slice(1) };
  if (l[0] === '-') return { k: 'old', text: l.slice(1) };
  if (l[0] === '+') return { k: 'new', text: l.slice(1) };
  return { k: 'mark', text: l };
}

/** O is the context and `-` lines, N the context and `+` lines, each in body order. */
function hunkON(body: BodyLine[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.k === 'ctx') {
      const oi = o.length;
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oIdx: oi });
    } else if (b.k === 'old') o.push(b.text);
    else if (b.k === 'new') n.push({ text: b.text, ctx: false, oIdx: -1 });
  }
  return { o, n };
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function noEolAfterLastOut(body: BodyLine[]): boolean {
  let idx = -1;
  for (let i = 0; i < body.length; i++) if (body[i]!.k === 'ctx' || body[i]!.k === 'new') idx = i;
  if (idx < 0) return false;
  return body[idx + 1]?.k === 'mark';
}

/** True when a `\` line follows the hunk's last `+` line. */
function noEolAfterLastPlus(body: BodyLine[]): boolean {
  let idx = -1;
  for (let i = 0; i < body.length; i++) if (body[i]!.k === 'new') idx = i;
  if (idx < 0) return false;
  return body[idx + 1]?.k === 'mark';
}

// ---- Section 6: unified diffs. ----

interface Hunk {
  /** A of `@@ -A[,B] +C[,D] @@`. */
  a: number;
  body: BodyLine[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` line: after the four characters, up to the first
 * tab, surrounding spaces removed; `/dev/null` means no file, a leading `a/` or
 * `b/` is removed. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  const fresh = (): Section => ({
    gitOld: null,
    gitNew: null,
    hasPair: false,
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    isNew: false,
    isDel: false,
    hunks: [],
  });
  let current: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      current = fresh();
      current.gitOld = m[1]!;
      current.gitNew = m[2]!;
      sections.push(current);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const old = headerPath(line);
      const nw = headerPath(lines[i + 1]!);
      if (current !== null && inHeader && !current.hasPair) {
        current.hasPair = true;
        current.pairOld = old;
        current.pairNew = nw;
      } else {
        current = fresh();
        current.hasPair = true;
        current.pairOld = old;
        current.pairNew = nw;
        sections.push(current);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && inHeader && current !== null) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (current === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          hunk.body.push(bodyLine(l));
          j++;
        } else break;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.k === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      current.hunks.push(hunk);
      inHeader = false;
      i = j;
      continue;
    }
    if (inHeader && current !== null) {
      if (line.startsWith('rename from ')) current.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) current.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) current.isNew = true;
      else if (line.startsWith('deleted file mode')) current.isDel = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** One hunk of a section, applied to the result of the hunks before it. `d` is the
 * drift so far: the sum over this section's hunks applied so far of (N's length
 * minus O's length). Returns the new file state and the updated drift. */
function applyUnifiedHunk(
  fs: FileState,
  hunk: Hunk,
  d: number,
  path: string,
  strict: boolean,
): { fs: FileState; d: number } {
  const { o, n } = hunkON(hunk.body);
  if (o.length > 0) {
    const found = findTier(fs.lines, o, 0, strict);
    if (!found) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        pos = p;
        best = dist;
      }
    }
    const replacement = buildReplacement(fs.lines, pos, o, n, found.tier);
    const touchesEnd = pos + o.length === fs.lines.length;
    const lines = [...fs.lines.slice(0, pos), ...replacement, ...fs.lines.slice(pos + o.length)];
    const final = touchesEnd ? !noEolAfterLastOut(hunk.body) : fs.final;
    return { fs: { br: fs.br, lines, final }, d: d + (n.length - o.length) };
  }
  const at = Math.max(0, Math.min(hunk.a + d, fs.lines.length));
  const touchesEnd = at === fs.lines.length;
  const lines = [...fs.lines.slice(0, at), ...n.map((x) => x.text), ...fs.lines.slice(at)];
  const final = touchesEnd ? !noEolAfterLastOut(hunk.body) : fs.final;
  return { fs: { br: fs.br, lines, final }, d: d + n.length };
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.hasPair ? sec.pairOld : (sec.renameFrom ?? sec.gitOld);
  const newP = sec.hasPair ? sec.pairNew : (sec.renameTo ?? sec.gitNew);
  const isCreate = sec.isNew || oldP === null;
  const isDelete = !isCreate && (sec.isDel || newP === null);
  const kind: 'create' | 'delete' | 'move' | 'change' = isCreate
    ? 'create'
    : isDelete
      ? 'delete'
      : oldP !== newP
        ? 'move'
        : 'change';
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (kind === 'create') {
      const p = newP!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.k === 'new') plus.push(b.text);
      let final = true;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        if (sec.hunks[k]!.body.some((b) => b.k === 'new')) {
          final = !noEolAfterLastPlus(sec.hunks[k]!.body);
          break;
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (kind === 'delete') {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldP!;
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (kind === 'move' && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    let fs = parseFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyUnifiedHunk(fs, h, d, p, strict);
      fs = r.fs;
      d = r.d;
    }
    const text = renderFile(fs);
    if (kind === 'move') {
      tree.now.set(p, null);
      tree.now.set(newP!, text);
      tree.moved.push([p, newP!]);
    } else {
      tree.now.set(p, text);
    }
  };
}

// ---- Section 7: SEARCH/REPLACE blocks. ----

interface SRBlock {
  path: string;
  old: string[];
  nw: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevRep = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
      let path: string | null = null;
      for (let j = i - 1; j > prevRep; j--) {
        const t = lines[j]!;
        if (isBlank(t)) continue;
        if (t.trim().startsWith('```')) continue;
        path = t.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      blocks.push({ path, old: lines.slice(i + 1, eq), nw: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevRep = rep;
      i = rep + 1;
    } else i++;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const fs = parseFile(cur);
    const found = findTier(fs.lines, b.old, 0, strict);
    if (!found) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const pos = found.occ[0]!;
    const replacement = buildReplacement(
      fs.lines,
      pos,
      b.old,
      b.nw.map((t) => ({ text: t, ctx: false, oIdx: -1 })),
      found.tier,
    );
    const lines = [...fs.lines.slice(0, pos), ...replacement, ...fs.lines.slice(pos + b.old.length)];
    tree.now.set(p, renderFile({ br: fs.br, lines, final: fs.final }));
  };
}

// ---- Section 8: V4A patches. ----

interface VChunk {
  /** Null means no anchor (an empty `@@` text is no anchor). */
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

type VSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[] };

const isVHeader = (l: string): boolean =>
  l.startsWith('*** Add File: ') ||
  l.startsWith('*** Delete File: ') ||
  l.startsWith('*** Update File: ');

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch')
    throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      const collected: string[] = [];
      let j = i + 1;
      while (j < last && !isVHeader(lines[j]!)) {
        const l = lines[j]!;
        if (l.startsWith('+')) collected.push(l.slice(1));
        else if (isBlank(l)) collected.push('');
        else throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
      sections.push({ kind: 'add', path, lines: collected });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      sections.push({ kind: 'delete', path: line.slice(17).trim() });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const updateLine = i + 1;
      const rawStart = i + 1;
      let j = rawStart;
      while (j < last && !isVHeader(lines[j]!)) j++;
      const raw = lines.slice(rawStart, j);
      while (raw.length > 0 && isBlank(raw[raw.length - 1]!)) raw.pop();
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice(13).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; k < raw.length; k++) {
        const l = raw[k]!;
        const absNo = rawStart + k + 1;
        if (l.startsWith('@@')) {
          if (cur) chunks.push(cur);
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
        } else if (l === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${absNo}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
        } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '' || isBlank(l)) {
          if (cur) cur.body.push(bodyLine(l));
          else if (chunks.length === 0) cur = { anchor: null, eof: false, body: [bodyLine(l)] };
          else if (isBlank(l)) {
            // A blank line between chunks is ignored.
          } else throw new Exit2(`error: parse ${absNo}`);
        } else {
          throw new Exit2(`error: parse ${absNo}`);
        }
      }
      if (cur) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      sections.push({ kind: 'update', path, moveTo, chunks });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => vSectionEdit(s, strict));
}

function vSectionEdit(sec: VSection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    const p = sec.path;
    const text = sec.lines;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text.length === 0 ? '' : text.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    const p = sec.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const p = sec.path;
  const moveTo = sec.moveTo;
  const chunks = sec.chunks;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let fs = parseFile(cur);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(fs.lines, chunk.anchor, cursor, strict);
        if (at === -1) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const { o, n } = hunkON(chunk.body);
      if (o.length === 0) {
        const at = chunk.eof ? fs.lines.length : cursor;
        const add = n.map((x) => x.text);
        fs = { br: fs.br, lines: [...fs.lines.slice(0, at), ...add, ...fs.lines.slice(at)], final: fs.final };
        cursor = at + add.length;
        continue;
      }
      const found = findTier(fs.lines, o, cursor, strict);
      if (!found) throw new Fail('no-match', p);
      const pos = found.occ[0]!;
      if (chunk.eof && pos + o.length !== fs.lines.length) throw new Fail('no-match', p);
      const replacement = buildReplacement(fs.lines, pos, o, n, found.tier);
      fs = {
        br: fs.br,
        lines: [...fs.lines.slice(0, pos), ...replacement, ...fs.lines.slice(pos + o.length)],
        final: fs.final,
      };
      cursor = pos + replacement.length;
    }
    const text = renderFile(fs);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, text);
      tree.moved.push([p, moveTo]);
    } else {
      tree.now.set(p, text);
    }
  };
}

// ---- Sections 1, 2 and 10: the command line, the output, and the all-or-nothing write. ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0)
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  // Net moves: chain A -> B -> C into A -> C, for the `R` lines (section 2).
  const netMove = new Map<string, string>();
  for (const [o, n] of tree.moved) {
    const orig = netMove.get(o) ?? o;
    netMove.delete(o);
    netMove.set(n, orig);
  }
  const rRows: Array<{ key: string; line: string }> = [];
  const rOld = new Set<string>();
  for (const [nw, old] of netMove) {
    if (tree.original(nw) === null && tree.get(nw) !== null && tree.original(old) !== null && tree.get(old) === null) {
      rRows.push({ key: nw, line: `R ${old} -> ${nw}` });
      rOld.add(old);
    }
  }
  const rNew = new Set(rRows.map((r) => r.key));
  const rows: Array<{ key: string; line: string }> = [...rRows];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOld.has(p) || rNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
