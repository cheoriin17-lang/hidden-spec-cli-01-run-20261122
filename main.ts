// mend: one patch tool for every AI edit format.
//
// Applies an edit an AI model wrote (unified diff, SEARCH/REPLACE blocks,
// V4A patch, or JSON tool calls) to the tree of text files in the working
// directory. Every file is changed or nothing is. Node 22 stdlib only.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

/** One file of the tree: its lines, whether it ends with a line break, and its line break. */
interface FileState {
  lines: string[];
  ends: boolean;
  brk: '\n' | '\r\n';
}

type Tree = Map<string, FileState>;

/** A parse fault names the 1-based patch line it is reported at. */
interface ParseFault {
  line: number;
}

type ApplyResult =
  | { ok: true; move?: [string, string] }
  | { ok: false; code: string; path: string };

function fail(code: string, path: string): ApplyResult {
  return { ok: false, code, path };
}

/** Split a file's text into lines, its final break, and its line break. */
function parseFileText(text: string): FileState {
  if (text === '') return { lines: [], ends: false, brk: '\n' };
  let brk: '\n' | '\r\n' = '\n';
  const lf = text.indexOf('\n');
  if (lf > 0 && text[lf - 1] === '\r') brk = '\r\n';
  const parts = text.split(brk);
  let ends = false;
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
    ends = true;
  }
  return { lines: parts, ends, brk };
}

/** Join a file's lines back, with its own break and final break. A file of no lines is empty. */
function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.ends ? f.brk : '');
}

/** Split a patch's text into lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatchLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A blank line is empty or only spaces and tabs. */
function isBlank(s: string): boolean {
  return /^[ \t]*$/.test(s);
}

/** Remove surrounding spaces and tabs. */
function trimST(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Remove trailing spaces and tabs. */
function trailWS(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

/** The leading spaces and tabs of a line. */
function leadWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** A path is safe when it is not empty, does not start with /, holds no \, and no segment is empty, . or ... */
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** Compare two strings by their UTF-8 bytes. */
function utf8Compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/* ------------------------------------------------------------------ */
/* Matching lines (section 5)                                          */
/* ------------------------------------------------------------------ */

/** Whether two lines are equal at a tier: 0 exact, 1 trailing spaces/tabs ignored, 2 both sides ignored. */
function lineEqTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWS(a) === trailWS(b);
  return trimST(a) === trimST(b);
}

/** Every 0-based position at or after `from` where O occurs in the file at one tier. Occurrences may overlap. */
function occurrencesAtTier(file: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEqTier(file[i + j], o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once at or after `from`, with its positions; null when none. */
function findOccurrences(
  file: string[],
  o: string[],
  strict: boolean,
  from: number,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrencesAtTier(file, o, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** The first line at or after `from` equal to a single line, at the first tier where one is; null when none. */
function findSingleLine(file: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < file.length; i++) {
      if (lineEqTier(file[i], anchor, t)) return i;
    }
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line, a new line as written (or re-indented). */
interface NLine {
  text: string;
  ctx: boolean;
  oIndex: number;
}

/** Build the lines that replace the matched ones: context lines from the file, other lines re-indented at tier 2. */
function buildNewLines(n: NLine[], file: string[], pos: number, o: string[], tier: number): string[] {
  const out: string[] = [];
  const P = o.length > 0 ? leadWS(o[0]) : '';
  const F = pos < file.length ? leadWS(file[pos]) : '';
  for (const nl of n) {
    if (nl.ctx) {
      out.push(file[pos + nl.oIndex]);
      continue;
    }
    if (tier === 2 && o.length > 0) {
      const t = nl.text;
      if (t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(P)) out.push(F + t.slice(P.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Invocation (section 1)                                              */
/* ------------------------------------------------------------------ */

type FormatName = 'unified' | 'search-replace' | 'v4a' | 'json' | 'auto';

interface Options {
  format: FormatName;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

const FORMAT_NAMES: FormatName[] = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

/** Parse the arguments; null is a usage error. */
function parseArgs(argv: string[]): Options | null {
  let format: FormatName = 'auto';
  let formatSeen = false;
  let check = false;
  let checkSeen = false;
  let strict = false;
  let strictSeen = false;
  let patch: string | null = null;
  let positional = 0;
  let noMoreOptions = false;
  for (const arg of argv) {
    if (!noMoreOptions && arg === '--') {
      noMoreOptions = true;
      continue;
    }
    if (!noMoreOptions && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=')) {
        if (formatSeen) return null;
        const value = arg.slice('--format='.length);
        if (!FORMAT_NAMES.includes(value as FormatName)) return null;
        format = value as FormatName;
        formatSeen = true;
      } else if (arg === '--check') {
        if (checkSeen) return null;
        check = true;
        checkSeen = true;
      } else if (arg === '--strict') {
        if (strictSeen) return null;
        strict = true;
        strictSeen = true;
      } else {
        return null;
      }
      continue;
    }
    positional += 1;
    if (positional > 1) return null;
    patch = arg;
  }
  return { format, check, strict, patch };
}

/** Detect the format of a patch (section 4); null when none holds. */
function detectFormat(lines: string[]): FormatName | null {
  let firstNB = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      firstNB = i;
      break;
    }
  }
  if (firstNB >= 0) {
    if (trimST(lines[firstNB]) === '*** Begin Patch') return 'v4a';
    const firstChar = lines[firstNB].replace(/^[ \t]+/, '')[0];
    if (firstChar === '[' || firstChar === '{') return 'json';
  }
  for (const l of lines) {
    if (trailWS(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Edits                                                               */
/* ------------------------------------------------------------------ */

/** One body line of a unified hunk or a V4A chunk: context, old, new, or a backslash line. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

function toBodyLine(raw: string): BodyLine {
  if (raw === '') return { kind: 'ctx', text: '' };
  const c = raw[0];
  if (c === ' ') return { kind: 'ctx', text: raw.slice(1) };
  if (c === '-') return { kind: 'old', text: raw.slice(1) };
  if (c === '+') return { kind: 'new', text: raw.slice(1) };
  return { kind: 'bs', text: raw.slice(1) };
}

/** Split a hunk or chunk body into its old lines O and its new lines N. */
function bodyON(body: BodyLine[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const bl of body) {
    if (bl.kind === 'ctx') {
      o.push(bl.text);
      n.push({ text: bl.text, ctx: true, oIndex: o.length - 1 });
    } else if (bl.kind === 'old') {
      o.push(bl.text);
    } else if (bl.kind === 'new') {
      n.push({ text: bl.text, ctx: false, oIndex: -1 });
    }
  }
  return { o, n };
}

type Edit =
  | { kind: 'unified'; oldPath: string | null; newPath: string | null; isCreate: boolean; isDelete: boolean; hunks: UnifiedHunk[] }
  | { kind: 'search-replace'; path: string; oldLines: string[]; newLines: string[] }
  | { kind: 'v4a-add'; path: string; lines: string[] }
  | { kind: 'v4a-delete'; path: string }
  | { kind: 'v4a-update'; path: string; newPath: string | null; chunks: VChunk[] }
  | { kind: 'json-create'; path: string; fileText: string }
  | { kind: 'json-str-replace'; path: string; oldStr: string; newStr: string }
  | { kind: 'json-insert'; path: string; insertLine: number; newStr: string };

/* ------------------------------------------------------------------ */
/* Unified diffs (section 6)                                           */
/* ------------------------------------------------------------------ */

interface UnifiedHunk {
  a: number;
  body: BodyLine[];
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UnifiedHunk[];
}

/** The path a --- or +++ line names: after the four characters, up to the first tab, spaces removed, a/ or b/ removed. */
function parseDiffPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = trimST(p);
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Whether a backslash line follows the hunk's last context or + line. */
function backslashFollowsLast(body: BodyLine[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k].kind === 'ctx' || body[k].kind === 'new') last = k;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1].kind === 'bs';
}

/** Parse a patch as a unified diff; a ParseFault, or the sections (none is a fault at line 1). */
function parseUnified(lines: string[]): UnifiedSection[] | ParseFault {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let hasPair = false;
  const n = lines.length;
  let i = 0;
  const pushCurrent = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
  };
  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) return { line: i + 1 };
      pushCurrent();
      cur = { oldPath: m[1], newPath: m[2], isCreate: false, isDelete: false, hunks: [] };
      inHeader = true;
      hasPair = false;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      if (cur !== null && inHeader && !hasPair) {
        cur.oldPath = parseDiffPath(line);
        cur.newPath = parseDiffPath(lines[i + 1]);
        hasPair = true;
        i += 2;
        continue;
      }
      pushCurrent();
      cur = { oldPath: parseDiffPath(line), newPath: parseDiffPath(lines[i + 1]), isCreate: false, isDelete: false, hunks: [] };
      inHeader = true;
      hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) return { line: i + 1 };
      if (cur === null) return { line: i + 1 };
      inHeader = false;
      const a = parseInt(m[1], 10);
      i += 1;
      const body: BodyLine[] = [];
      while (i < n) {
        const bl = lines[i];
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(toBodyLine(bl));
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1].kind === 'ctx' && body[body.length - 1].text === '') body.pop();
      cur.hunks.push({ a, body });
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) return { line: i + 2 };
      if (line.startsWith('+++ ')) {
        cur.newPath = parseDiffPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (!hasPair) cur.oldPath = line.slice('rename from '.length);
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!hasPair) cur.newPath = line.slice('rename to '.length);
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  pushCurrent();
  if (sections.length === 0) return { line: 1 };
  return sections;
}

/** Apply one unified section to the tree. */
function applyUnified(sec: UnifiedSection, tree: Tree, strict: boolean): ApplyResult {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  const isCreate = oldP === null || sec.isCreate;
  const isDelete = !isCreate && (newP === null || sec.isDelete);
  if (isCreate) {
    const p = newP ?? '';
    if (!isSafePath(p)) return fail('unsafe', p);
    if (tree.has(p)) return fail('exists', p);
    const outLines: string[] = [];
    let lastPlus: { hunk: UnifiedHunk; idx: number } | null = null;
    for (const h of sec.hunks) {
      for (let k = 0; k < h.body.length; k++) {
        if (h.body[k].kind === 'new') {
          outLines.push(h.body[k].text);
          lastPlus = { hunk: h, idx: k };
        }
      }
    }
    let ends = false;
    if (lastPlus !== null) {
      const next = lastPlus.hunk.body[lastPlus.idx + 1];
      ends = !(next !== undefined && next.kind === 'bs');
    }
    tree.set(p, { lines: outLines, ends, brk: '\n' });
    return { ok: true };
  }
  if (isDelete) {
    const p = oldP ?? '';
    if (!isSafePath(p)) return fail('unsafe', p);
    if (!tree.has(p)) return fail('missing', p);
    tree.delete(p);
    return { ok: true };
  }
  const p = oldP ?? '';
  const q = newP ?? '';
  if (!isSafePath(p)) return fail('unsafe', p);
  if (q !== p && !isSafePath(q)) return fail('unsafe', q);
  if (!tree.has(p)) return fail('missing', p);
  if (q !== p && tree.has(q)) return fail('exists', q);
  const file = tree.get(p) as FileState;
  let lines = [...file.lines];
  let ends = file.ends;
  let d = 0;
  for (const h of sec.hunks) {
    const { o, n } = bodyON(h.body);
    if (o.length > 0) {
      const found = findOccurrences(lines, o, strict, 0);
      if (found === null) return fail('no-match', p);
      const target = h.a - 1 + d;
      let best = found.positions[0];
      let bestDist = Math.abs(best - target);
      for (const pos of found.positions) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const newLines = buildNewLines(n, lines, best, o, found.tier);
      const runsToEnd = best + o.length === lines.length;
      lines = [...lines.slice(0, best), ...newLines, ...lines.slice(best + o.length)];
      if (runsToEnd) ends = !backslashFollowsLast(h.body);
      d += newLines.length - o.length;
    } else {
      let ins = h.a + d;
      if (ins < 0) ins = 0;
      if (ins > lines.length) ins = lines.length;
      const newLines = buildNewLines(n, lines, ins, o, 0);
      const atEnd = ins === lines.length;
      lines = [...lines.slice(0, ins), ...newLines, ...lines.slice(ins)];
      if (atEnd && n.length > 0) ends = !backslashFollowsLast(h.body);
      d += newLines.length;
    }
  }
  if (q !== p) {
    tree.delete(p);
    tree.set(q, { lines, ends, brk: file.brk });
    return { ok: true, move: [p, q] };
  }
  tree.set(p, { lines, ends, brk: file.brk });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (section 7)                                   */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

/** Parse a patch as SEARCH/REPLACE blocks; a ParseFault, or the blocks (none is a fault at line 1). */
function parseSearchReplace(lines: string[]): SRBlock[] | ParseFault {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    if (trailWS(lines[i]) === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        if (isBlank(lines[j])) continue;
        if (trimST(lines[j]).startsWith('```')) continue;
        path = trimST(lines[j]);
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else return { line: searchLine };
      }
      let sep = -1;
      let k = i + 1;
      while (k < n) {
        const t = trailWS(lines[k]);
        if (t === '=======') {
          sep = k;
          break;
        }
        if (t === '>>>>>>> REPLACE') break;
        k += 1;
      }
      if (sep === -1) return { line: searchLine };
      let end = -1;
      k = sep + 1;
      while (k < n) {
        if (trailWS(lines[k]) === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
        k += 1;
      }
      if (end === -1) return { line: searchLine };
      blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end) });
      prevPath = path;
      prevEnd = end + 1;
      i = end + 1;
    } else {
      i += 1;
    }
  }
  if (blocks.length === 0) return { line: 1 };
  return blocks;
}

/** Apply one SEARCH/REPLACE block to the tree. */
function applySearchReplace(b: SRBlock, tree: Tree, strict: boolean): ApplyResult {
  const p = b.path;
  if (!isSafePath(p)) return fail('unsafe', p);
  if (b.oldLines.length === 0) {
    if (tree.has(p)) return fail('exists', p);
    tree.set(p, { lines: [...b.newLines], ends: b.newLines.length > 0, brk: '\n' });
    return { ok: true };
  }
  if (!tree.has(p)) return fail('missing', p);
  const file = tree.get(p) as FileState;
  const found = findOccurrences(file.lines, b.oldLines, strict, 0);
  if (found === null) return fail('no-match', p);
  if (found.positions.length > 1) return fail('ambiguous', p);
  const pos = found.positions[0];
  const n: NLine[] = b.newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
  const newLines = buildNewLines(n, file.lines, pos, b.oldLines, found.tier);
  const lines = [...file.lines.slice(0, pos), ...newLines, ...file.lines.slice(pos + b.oldLines.length)];
  tree.set(p, { lines, ends: file.ends, brk: file.brk });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* V4A patches (section 8)                                             */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

type VSection =
  | { kind: 'v4a-add'; path: string; lines: string[] }
  | { kind: 'v4a-delete'; path: string }
  | { kind: 'v4a-update'; path: string; newPath: string | null; chunks: VChunk[] };

interface RawLine {
  text: string;
  line: number;
}

interface RawSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  startLine: number;
  raw: RawLine[];
}

/** Whether a raw content line counts as blank at the end of a section: its text, after any + or - marker, is blank. */
function isBlankContent(raw: string): boolean {
  if (isBlank(raw)) return true;
  if ((raw.startsWith('+') || raw.startsWith('-')) && isBlank(raw.slice(1))) return true;
  return false;
}

/** Parse a patch as V4A; a ParseFault, or the sections. */
function parseV4A(lines: string[]): VSection[] | ParseFault {
  let firstNB = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      firstNB = i;
      break;
    }
  }
  if (firstNB === -1) return { line: 1 };
  if (trimST(lines[firstNB]) !== '*** Begin Patch') return { line: firstNB + 1 };
  let lastNB = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      lastNB = i;
      break;
    }
  }
  if (trimST(lines[lastNB]) !== '*** End Patch') return { line: lines.length + 1 };
  const rawSections: RawSection[] = [];
  let curRaw: RawSection | null = null;
  for (let i = firstNB + 1; i < lastNB; i++) {
    const line = lines[i];
    if (line.startsWith('*** Add File: ')) {
      curRaw = { kind: 'add', path: trimST(line.slice('*** Add File: '.length)), startLine: i + 1, raw: [] };
      rawSections.push(curRaw);
    } else if (line.startsWith('*** Delete File: ')) {
      curRaw = { kind: 'delete', path: trimST(line.slice('*** Delete File: '.length)), startLine: i + 1, raw: [] };
      rawSections.push(curRaw);
    } else if (line.startsWith('*** Update File: ')) {
      curRaw = { kind: 'update', path: trimST(line.slice('*** Update File: '.length)), startLine: i + 1, raw: [] };
      rawSections.push(curRaw);
    } else if (curRaw === null) {
      if (isBlank(line)) continue;
      return { line: i + 1 };
    } else {
      curRaw.raw.push({ text: line, line: i + 1 });
    }
  }
  const sections: VSection[] = [];
  for (const rs of rawSections) {
    const raw = [...rs.raw];
    while (raw.length > 0 && isBlankContent(raw[raw.length - 1].text)) raw.pop();
    if (rs.kind === 'add') {
      const flines: string[] = [];
      for (const rl of raw) {
        if (rl.text.startsWith('+')) flines.push(rl.text.slice(1));
        else if (rl.text === '') flines.push('');
        else return { line: rl.line };
      }
      sections.push({ kind: 'v4a-add', path: rs.path, lines: flines });
    } else if (rs.kind === 'delete') {
      if (raw.length > 0) return { line: raw[0].line };
      sections.push({ kind: 'v4a-delete', path: rs.path });
    } else {
      let newPath: string | null = null;
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      for (const rl of raw) {
        const text = rl.text;
        if (text.startsWith('*** Move to: ')) {
          if (newPath !== null || curChunk !== null || chunks.length > 0) return { line: rl.line };
          newPath = trimST(text.slice('*** Move to: '.length));
          continue;
        }
        if (text === '*** End of File') {
          if (curChunk === null) return { line: rl.line };
          curChunk.eof = true;
          curChunk = null;
          continue;
        }
        if (text.startsWith('@@')) {
          const anchor = trimST(text.slice(2));
          curChunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          chunks.push(curChunk);
          continue;
        }
        if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+') || text === '') {
          if (curChunk === null) {
            if (chunks.length > 0) return { line: rl.line };
            curChunk = { anchor: null, eof: false, body: [] };
            chunks.push(curChunk);
          }
          curChunk.body.push(toBodyLine(text));
          continue;
        }
        return { line: rl.line };
      }
      if (chunks.length === 0 && newPath === null) return { line: rs.startLine };
      sections.push({ kind: 'v4a-update', path: rs.path, newPath, chunks });
    }
  }
  if (sections.length === 0) return { line: 1 };
  return sections;
}

/** Apply one V4A section to the tree. */
function applyV4A(sec: VSection, tree: Tree, strict: boolean): ApplyResult {
  if (sec.kind === 'v4a-add') {
    const p = sec.path;
    if (!isSafePath(p)) return fail('unsafe', p);
    if (tree.has(p)) return fail('exists', p);
    tree.set(p, { lines: [...sec.lines], ends: sec.lines.length > 0, brk: '\n' });
    return { ok: true };
  }
  if (sec.kind === 'v4a-delete') {
    const p = sec.path;
    if (!isSafePath(p)) return fail('unsafe', p);
    if (!tree.has(p)) return fail('missing', p);
    tree.delete(p);
    return { ok: true };
  }
  const p = sec.path;
  const q = sec.newPath;
  if (!isSafePath(p)) return fail('unsafe', p);
  if (q !== null && q !== p && !isSafePath(q)) return fail('unsafe', q);
  if (!tree.has(p)) return fail('missing', p);
  if (q !== null && q !== p && tree.has(q)) return fail('exists', q);
  const file = tree.get(p) as FileState;
  let lines = [...file.lines];
  let cursor = 0;
  for (const ch of sec.chunks) {
    if (ch.anchor !== null) {
      const at = findSingleLine(lines, ch.anchor, strict, cursor);
      if (at === null) return fail('no-match', p);
      cursor = at + 1;
    }
    const { o, n } = bodyON(ch.body);
    if (o.length > 0) {
      const found = findOccurrences(lines, o, strict, cursor);
      let pos: number | null = null;
      let tier = 0;
      if (found !== null) {
        tier = found.tier;
        if (ch.eof) {
          for (const pp of found.positions) {
            if (pp + o.length === lines.length) {
              pos = pp;
              break;
            }
          }
        } else {
          pos = found.positions[0];
        }
      }
      if (pos === null) return fail('no-match', p);
      const newLines = buildNewLines(n, lines, pos, o, tier);
      lines = [...lines.slice(0, pos), ...newLines, ...lines.slice(pos + o.length)];
      cursor = pos + newLines.length;
    } else {
      const ins = ch.eof ? lines.length : cursor;
      const newLines = buildNewLines(n, lines, ins, o, 0);
      lines = [...lines.slice(0, ins), ...newLines, ...lines.slice(ins)];
      cursor = ins + newLines.length;
    }
  }
  if (q !== null && q !== p) {
    tree.delete(p);
    tree.set(q, { lines, ends: file.ends, brk: file.brk });
    return { ok: true, move: [p, q] };
  }
  tree.set(p, { lines, ends: file.ends, brk: file.brk });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* JSON edits (section 9)                                              */
/* ------------------------------------------------------------------ */

/** Validate one parsed JSON value as an edit object; null is a parse fault. */
function validateJsonEdit(obj: unknown): Edit | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.path !== 'string') return null;
  if (rec.command === 'create') {
    if (typeof rec.file_text !== 'string') return null;
    return { kind: 'json-create', path: rec.path, fileText: rec.file_text };
  }
  if (rec.command === 'str_replace') {
    if (typeof rec.old_str !== 'string' || rec.old_str === '') return null;
    let newStr = '';
    if (rec.new_str !== undefined) {
      if (typeof rec.new_str !== 'string') return null;
      newStr = rec.new_str;
    }
    return { kind: 'json-str-replace', path: rec.path, oldStr: rec.old_str, newStr };
  }
  if (rec.command === 'insert') {
    if (typeof rec.insert_line !== 'number' || !Number.isInteger(rec.insert_line)) return null;
    if (typeof rec.new_str !== 'string') return null;
    return { kind: 'json-insert', path: rec.path, insertLine: rec.insert_line, newStr: rec.new_str };
  }
  return null;
}

/** Parse a patch as JSON edits; a ParseFault, or the edits (none is a fault at line 1). */
function parseJson(text: string, lines: string[]): Edit[] | ParseFault {
  let firstNB = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      firstNB = i;
      break;
    }
  }
  if (firstNB === -1) return { line: 1 };
  const firstChar = lines[firstNB].replace(/^[ \t]+/, '')[0];
  if (firstChar === '[') {
    const startLine = firstNB + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { line: startLine };
    }
    if (!Array.isArray(parsed)) return { line: startLine };
    const edits: Edit[] = [];
    for (const el of parsed) {
      const e = validateJsonEdit(el);
      if (e === null) return { line: startLine };
      edits.push(e);
    }
    if (edits.length === 0) return { line: 1 };
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      return { line: i + 1 };
    }
    const e = validateJsonEdit(obj);
    if (e === null) return { line: i + 1 };
    edits.push(e);
  }
  if (edits.length === 0) return { line: 1 };
  return edits;
}

/** Split a string into lines as JSON new_str does: at \n, one trailing \r removed, no empty piece after a final \n. */
function splitNewStr(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Count occurrences of a string in a text, positions may overlap. */
function countOccurrences(text: string, sub: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(sub, from);
    if (at === -1) return count;
    count += 1;
    from = at + 1;
  }
}

/** Apply one JSON edit to the tree. */
function applyJson(edit: Edit, tree: Tree): ApplyResult {
  if (edit.kind === 'json-create') {
    const p = edit.path;
    if (!isSafePath(p)) return fail('unsafe', p);
    if (tree.has(p)) return fail('exists', p);
    tree.set(p, parseFileText(edit.fileText));
    return { ok: true };
  }
  if (edit.kind === 'json-str-replace') {
    const p = edit.path;
    if (!isSafePath(p)) return fail('unsafe', p);
    if (!tree.has(p)) return fail('missing', p);
    const file = tree.get(p) as FileState;
    const raw = serializeFile(file);
    let text = raw;
    let oldStr = edit.oldStr;
    let newStr = edit.newStr;
    if (file.brk === '\r\n') {
      text = raw.replace(/\r\n/g, '\n');
      oldStr = oldStr.replace(/\r\n/g, '\n');
      newStr = newStr.replace(/\r\n/g, '\n');
    }
    const count = countOccurrences(text, oldStr);
    if (count === 0) return fail('no-match', p);
    if (count > 1) return fail('ambiguous', p);
    const at = text.indexOf(oldStr);
    const replaced = text.slice(0, at) + newStr + text.slice(at + oldStr.length);
    const out = file.brk === '\r\n' ? replaced.replace(/\n/g, '\r\n') : replaced;
    tree.set(p, parseFileText(out));
    return { ok: true };
  }
  const p = edit.path;
  if (!isSafePath(p)) return fail('unsafe', p);
  if (!tree.has(p)) return fail('missing', p);
  const file = tree.get(p) as FileState;
  if (edit.insertLine < 0 || edit.insertLine > file.lines.length) return fail('no-match', p);
  const ins = splitNewStr(edit.newStr);
  const lines = [...file.lines.slice(0, edit.insertLine), ...ins, ...file.lines.slice(edit.insertLine)];
  tree.set(p, { lines, ends: file.ends, brk: file.brk });
  return { ok: true };
}

/** Dispatch one edit of any format to the tree. */
function applyEdit(edit: Edit, tree: Tree, strict: boolean): ApplyResult {
  switch (edit.kind) {
    case 'unified':
      return applyUnified(edit, tree, strict);
    case 'search-replace':
      return applySearchReplace(edit, tree, strict);
    case 'v4a-add':
    case 'v4a-delete':
    case 'v4a-update':
      return applyV4A(edit, tree, strict);
    default:
      return applyJson(edit, tree);
  }
}

/* ------------------------------------------------------------------ */
/* The tree and the report (sections 2, 3 and 10)                      */
/* ------------------------------------------------------------------ */

/** Read every regular file under the working directory into the tree. */
function readTree(root: string): Tree {
  const tree: Tree = new Map();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        const rel = full.slice(root.length + 1).split(sep).join('/');
        tree.set(rel, parseFileText(readFileSync(full, 'utf8')));
      }
    }
  };
  walk(root);
  return tree;
}

/** Write the tree back: changed files written, removed files deleted. */
function writeTree(root: string, before: Tree, after: Tree): void {
  for (const [p, f] of after) {
    const beforeText = before.has(p) ? serializeFile(before.get(p) as FileState) : undefined;
    const afterText = serializeFile(f);
    if (beforeText !== afterText) {
      const full = join(root, ...p.split('/'));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, afterText, 'utf8');
    }
  }
  for (const p of before.keys()) {
    if (!after.has(p)) rmSync(join(root, ...p.split('/')), { force: true });
  }
}

/** The output lines for a successful run, from the tree before and after, and the moves that succeeded. */
function reportLines(before: Tree, after: Tree, moves: [string, string][]): string[] {
  const suppressed = new Set<string>();
  const rLines: { key: string; line: string }[] = [];
  for (const [oldP, newP] of moves) {
    if (before.has(oldP) && !after.has(oldP) && !before.has(newP) && after.has(newP)) {
      suppressed.add(oldP);
      suppressed.add(newP);
      rLines.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  const out: { key: string; line: string }[] = [...rLines];
  for (const [p, f] of after) {
    if (suppressed.has(p)) continue;
    if (!before.has(p)) out.push({ key: p, line: `A ${p}` });
    else if (serializeFile(before.get(p) as FileState) !== serializeFile(f)) out.push({ key: p, line: `M ${p}` });
  }
  for (const p of before.keys()) {
    if (suppressed.has(p)) continue;
    if (!after.has(p)) out.push({ key: p, line: `D ${p}` });
  }
  out.sort((a, b) => utf8Compare(a.key, b.key));
  return out.map((o) => o.line);
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function main(argv: string[]): number {
  const opts = parseArgs(argv);
  if (opts === null) {
    process.stdout.write('error: usage\n');
    return 2;
  }
  let patchText: string;
  if (opts.patch === null || opts.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(opts.patch, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      return 2;
    }
  }
  const lines = splitPatchLines(patchText);
  const format = opts.format === 'auto' ? detectFormat(lines) : opts.format;
  if (format === null) {
    process.stdout.write('error: format\n');
    return 2;
  }
  let parsed: Edit[] | ParseFault;
  if (format === 'unified') {
    const sections = parseUnified(lines);
    if ('line' in sections) {
      process.stdout.write(`error: parse ${sections.line}\n`);
      return 2;
    }
    parsed = sections.map((s) => ({ kind: 'unified', ...s }) as Edit);
  } else if (format === 'search-replace') {
    const blocks = parseSearchReplace(lines);
    if ('line' in blocks) {
      process.stdout.write(`error: parse ${blocks.line}\n`);
      return 2;
    }
    parsed = blocks.map((b) => ({ kind: 'search-replace', ...b }) as Edit);
  } else if (format === 'v4a') {
    const vsections = parseV4A(lines);
    if ('line' in vsections) {
      process.stdout.write(`error: parse ${vsections.line}\n`);
      return 2;
    }
    parsed = vsections;
  } else {
    const jedits = parseJson(patchText, lines);
    if ('line' in jedits) {
      process.stdout.write(`error: parse ${jedits.line}\n`);
      return 2;
    }
    parsed = jedits;
  }
  const before = readTree(process.cwd());
  const after: Tree = new Map();
  for (const [p, f] of before) after.set(p, { lines: [...f.lines], ends: f.ends, brk: f.brk });
  const failures: { code: string; path: string }[] = [];
  const moves: [string, string][] = [];
  for (const edit of parsed) {
    const r = applyEdit(edit, after, opts.strict);
    if (!r.ok) failures.push({ code: r.code, path: r.path });
    else if (r.move !== undefined) moves.push(r.move);
  }
  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += `error: ${f.code} ${f.path}\n`;
    out += `failed: ${failures.length} of ${parsed.length} edits\n`;
    process.stdout.write(out);
    return 1;
  }
  const report = reportLines(before, after, moves);
  let out = '';
  for (const l of report) out += `${l}\n`;
  out += report.length === 1 ? 'ok: 1 file\n' : `ok: ${report.length} files\n`;
  process.stdout.write(out);
  if (!opts.check) writeTree(process.cwd(), before, after);
  return 0;
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  process.exit(main(process.argv.slice(2)));
}
