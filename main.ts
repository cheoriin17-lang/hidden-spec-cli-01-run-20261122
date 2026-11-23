// mend: one patch tool for every AI edit format, as SPEC.md (version 1)
// describes it. A patch in unified, SEARCH/REPLACE, V4A or JSON form is read
// exactly as the specification says, its edits are applied to the tree of
// text files in the working directory in order, and either every change is
// written or, when any edit failed, none is. Standard output holds only the
// lines section 2 of the specification asks for; standard error is never
// compared, so nothing else is written anywhere.
//
// makefun anchor b98633652a3e5659ef016be03413345145e0bd94 round 34185140

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse or format failure: exit 2 with exactly this one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: exit 1 reports `error: <code> <path>`. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const trimSpaces = (s: string): string => s.replace(/^[ ]+/, '').replace(/[ ]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const stripTrailing = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ ]+$/, '');

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and
 *  no empty piece after a final `\n`. Patch line numbers count these from 1. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: a path is safe when it is not empty, does not start with `/`,
 *  holds no `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines under its own line break, and whether it ends with one.
 *  The break is CRLF when the first line feed follows a carriage return, and
 *  LF otherwise. An empty file has no lines and does not end with a break. */
interface FileState {
  lines: string[];
  br: string;
  finalBr: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBr = text.endsWith(br);
  const parts = text.split(br);
  if (finalBr) parts.pop();
  return { lines: parts, br, finalBr };
}

function writeFileState(fs: FileState): string {
  if (fs.lines.length === 0) return '';
  return fs.lines.join(fs.br) + (fs.finalBr ? fs.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 *  the rest read from disk. Successful move edits record their pair here so
 *  the output can print one `R` line for the pair instead of `D` and `A`. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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

/** Section 5: two lines are equal at a tier, 0 exact, 1 after trailing
 *  spaces and tabs are removed from both, 2 after leading and trailing
 *  spaces and tabs are removed from both. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Every 0-based position at or after `from` where `oldLines` occurs in
 *  `lines` at `tier`; occurrences may overlap. */
function occurrences(lines: string[], oldLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  for (let i = from; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (!lineEq(lines[i + j]!, oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** One line of the new lines N: a context line is written as the file's own
 *  matched line, so it carries the index of its line in O; any other line
 *  carries null and is written as the patch wrote it, subject to tier 2. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** Section 5: build the lines that replace a match. Context lines come from
 *  the file. At tier 2 every other non-blank line that starts with P, the
 *  leading spaces and tabs of O's first line, has that P replaced by F, the
 *  leading spaces and tabs of the file's first matched line. At tiers 0 and
 *  1 the lines of N are written as they are. */
function resolveNew(nLines: NewLine[], oldLines: string[], fileLines: string[], pos: number, tier: number): string[] {
  if (tier !== 2 || oldLines.length === 0) {
    return nLines.map((n) => (n.ctx !== null ? fileLines[pos + n.ctx]! : n.text));
  }
  const f = leadingWs(fileLines[pos]!);
  const p = leadingWs(oldLines[0]!);
  return nLines.map((n) => {
    if (n.ctx !== null) return fileLines[pos + n.ctx]!;
    if (n.text === '' || /^[ \t]+$/.test(n.text)) return n.text;
    if (n.text.startsWith(p)) return f + n.text.slice(p.length);
    return n.text;
  });
}

/** Section 9: one JSON edit object, or null when the value is not one. A
 *  wrong command or a missing or mistyped key is a parse fault, so null is
 *  all the caller needs to tell. Keys other than the ones below are ignored. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
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
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const fs = parseFile(before);
      if (line < 0 || line > fs.lines.length) throw new Fail('no-match', p);
      const lines = [...fs.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, writeFileState({ lines, br: fs.br, finalBr: fs.finalBr }));
    };
  }
  return null;
}

/** Section 9: the patch is either one JSON array of edit objects, or JSON
 *  Lines with one edit object a line and blank lines ignored. In array form
 *  any fault is `error: parse` at the line where the array starts; in JSON
 *  Lines form a line that does not hold one valid edit object is `error:
 *  parse` at that line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
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
    if (blank(l)) return;
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

/** Section 4: with `--format=auto` the format is the first of these that
 *  holds, where a blank line is one that is empty or only whitespace:
 *  the first non-blank line, its surrounding whitespace removed, is
 *  `*** Begin Patch` (v4a); the first non-whitespace character of the first
 *  non-blank line is `[` or `{` (json); some line, its trailing whitespace
 *  removed, is `<<<<<<< SEARCH` (search-replace); some line starts with
 *  `diff --git `, or some line starts with `--- ` and the line after it
 *  starts with `+++ ` (unified). Otherwise there is no format. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** Section 6: one hunk of a unified diff. O is the context and `-` lines,
 *  N the context and `+` lines, each in body order. `noEol` says a `\` line
 *  follows the hunk's last context or `+` line; `noEolPlus` says one follows
 *  its last `+` line, which is what a created file looks at. `plusLines`
 *  holds the `+` lines in order, which is what a created file is. */
interface Hunk {
  a: number;
  oldLines: string[];
  newLines: NewLine[];
  plusLines: string[];
  noEol: boolean;
  noEolPlus: boolean;
}

const isBodyLine = (l: string): boolean => l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';

/** A hunk header `@@ -A[,B] +C[,D] @@`, optionally followed by text; B and D
 *  are not used. Returns A, or null when the line is not such a header. */
function hunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  return m === null ? null : Number(m[1]);
}

/** Build a hunk from its raw body lines. Empty lines at the end of a body
 *  are not part of it: an empty line is a context line whose text is empty,
 *  so a trailing line that is empty, or a single space, is dropped, while a
 *  line of two spaces is a context line whose text is one space and stays. */
function buildHunk(a: number, raw: string[]): Hunk {
  const body = [...raw];
  while (body.length > 0 && (body[body.length - 1] === '' || body[body.length - 1] === ' ')) body.pop();
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  const plusLines: string[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    if (l === '') {
      oldLines.push('');
      newLines.push({ text: '', ctx: oldLines.length - 1 });
      lastCtxPlus = i;
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      oldLines.push(t);
      newLines.push({ text: t, ctx: oldLines.length - 1 });
      lastCtxPlus = i;
    } else if (l[0] === '-') {
      oldLines.push(l.slice(1));
    } else if (l[0] === '+') {
      newLines.push({ text: l.slice(1), ctx: null });
      plusLines.push(l.slice(1));
      lastCtxPlus = i;
      lastPlus = i;
    }
  }
  const noEol = lastCtxPlus >= 0 && lastCtxPlus + 1 < body.length && body[lastCtxPlus + 1]![0] === '\\';
  const noEolPlus = lastPlus >= 0 && lastPlus + 1 < body.length && body[lastPlus + 1]![0] === '\\';
  return { a, oldLines, newLines, plusLines, noEol, noEolPlus };
}

/** One section of a unified diff, as its header names it. A path is
 *  undefined when nothing named it, null when it was `/dev/null`. */
interface UniSection {
  oldPlus: string | null | undefined;
  newPlus: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function blankSection(): UniSection {
  return {
    oldPlus: undefined,
    newPlus: undefined,
    renameOld: undefined,
    renameNew: undefined,
    diffOld: undefined,
    diffNew: undefined,
    isCreate: false,
    isDelete: false,
    hunks: [],
  };
}

/** The path a `--- ` or `+++ ` line names: the text after the four
 *  characters, up to the first tab, with surrounding spaces removed.
 *  `/dev/null` means no file. A leading `a/` or `b/` is removed. */
function plusPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!;
  const p = trimSpaces(raw);
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** A `diff --git a/<X> b/<Y>` line, or null when the line is not of that form. */
function diffGit(line: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
  return m === null ? null : [m[1]!, m[2]!];
}

/** Section 6, reading: sections and their hunks. A section starts at a
 *  `diff --git` line, or at a `--- ` line followed by a `+++ ` line that is
 *  not already part of a section's header. Within a section, before its
 *  first hunk, `---`/`+++` name the paths, `rename from`/`rename to` name
 *  them when no `---`/`+++` pair does, `new file mode` makes a creation and
 *  `deleted file mode` a deletion, and any other line is ignored. A `--- `
 *  line not followed by a `+++ ` line, inside a section's header, is a parse
 *  error at the line after it. Any other line starting with `@@` is a parse
 *  error at its line, and so is a hunk before any section. Outside bodies,
 *  lines that are not part of a section header are ignored.
 *
 *  A deletion section's hunks are not read at all: once its header says it
 *  is a deletion, every line up to the next section start is ignored, so a
 *  malformed hunk header or a hunk that matches nothing cannot fail it. */
function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let skipHunks = false;
  const startSection = (s: UniSection): void => {
    if (cur !== null) sections.push(cur);
    cur = s;
    inHeader = true;
    skipHunks = false;
  };
  const isDeletion = (s: UniSection): boolean => s.isDelete || (s.newPlus !== undefined && s.newPlus === null);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const nextIsPlusPlus = (lines[i + 1] ?? '').startsWith('+++ ');
    if (line.startsWith('diff --git ')) {
      const d = diffGit(line);
      if (d === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = blankSection();
      s.diffOld = d[0];
      s.diffNew = d[1];
      startSection(s);
      i++;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      if (line.startsWith('--- ') && nextIsPlusPlus) {
        startSection(blankSection());
        continue;
      }
      i++;
      continue;
    }
    if (skipHunks) {
      if (line.startsWith('--- ') && nextIsPlusPlus) {
        startSection(blankSection());
        continue;
      }
      i++;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('@@')) {
        if (isDeletion(cur)) {
          skipHunks = true;
          inHeader = false;
          i++;
          continue;
        }
        const a = hunkHeader(line);
        if (a === null) throw new Exit2(`error: parse ${i + 1}`);
        let j = i + 1;
        const raw: string[] = [];
        while (j < lines.length && isBodyLine(lines[j]!) && !(lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ '))) {
          raw.push(lines[j]!);
          j++;
        }
        cur.hunks.push(buildHunk(a, raw));
        inHeader = false;
        i = j;
        continue;
      }
      if (line.startsWith('--- ')) {
        if (!nextIsPlusPlus) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldPlus = plusPath(line);
        i++;
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.newPlus = plusPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ') && cur.renameOld === undefined) cur.renameOld = trimSpaces(line.slice(12));
      else if (line.startsWith('rename to ') && cur.renameNew === undefined) cur.renameNew = trimSpaces(line.slice(10));
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const a = hunkHeader(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      let j = i + 1;
      const raw: string[] = [];
      while (j < lines.length && isBodyLine(lines[j]!) && !(lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ '))) {
        raw.push(lines[j]!);
        j++;
      }
      cur.hunks.push(buildHunk(a, raw));
      i = j;
      continue;
    }
    if (line.startsWith('--- ') && nextIsPlusPlus) {
      startSection(blankSection());
      continue;
    }
    i++;
  }
  if (cur !== null) sections.push(cur);
  return sections;
}

/** Section 6 matching, with the reference's tolerance for empty lines. The
 *  literal search is tried first at every tier, exactly as section 5 says.
 *  Only when it finds nothing at any tier is the search repeated with empty
 *  lines left out of both O and the file: the practice set shows a hunk
 *  whose O holds an empty context line the file does not have succeeding,
 *  while hunks whose empty context lines the file does have succeed as
 *  written, so the tolerance only ever changes a no-match into a match. The
 *  fallback returns the span of file lines the match covers, from the first
 *  to the last matched line, and the map from each non-empty line of O to
 *  the file line it matched, so the replacement can still be built from N. */
interface HunkMatch {
  tier: number;
  start: number;
  end: number;
  exact: boolean;
  fileAt: Map<number, number>;
}

function findHunkMatch(lines: string[], oldLines: string[], target: number, strict: boolean): HunkMatch | null {
  for (const tier of tiers(strict)) {
    const occ = occurrences(lines, oldLines, tier, 0);
    if (occ.length === 0) continue;
    let best = occ[0]!;
    for (const p of occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const fileAt = new Map<number, number>();
    for (let k = 0; k < oldLines.length; k++) fileAt.set(k, best + k);
    return { tier, start: best, end: best + oldLines.length - 1, exact: true, fileAt };
  }
  const keptO: number[] = [];
  for (let k = 0; k < oldLines.length; k++) if (oldLines[k] !== '') keptO.push(k);
  if (keptO.length === 0) return null;
  const keptF: number[] = [];
  for (let k = 0; k < lines.length; k++) if (lines[k] !== '') keptF.push(k);
  const oPrime = keptO.map((k) => oldLines[k]!);
  const fPrime = keptF.map((k) => lines[k]!);
  for (const tier of tiers(strict)) {
    const occ = occurrences(fPrime, oPrime, tier, 0);
    if (occ.length === 0) continue;
    let best = occ[0]!;
    for (const p of occ) {
      if (Math.abs(keptF[p]! - target) < Math.abs(keptF[best]! - target)) best = p;
    }
    const fileAt = new Map<number, number>();
    for (let t = 0; t < keptO.length; t++) fileAt.set(keptO[t]!, keptF[best + t]!);
    return { tier, start: keptF[best]!, end: keptF[best + keptO.length - 1]!, exact: false, fileAt };
  }
  return null;
}

/** Build the lines that replace a hunk match. For a literal match this is
 *  section 5 as written. For a match found with empty lines left out, a
 *  context line whose line of O is empty has no file line to come from and
 *  is written empty, and every other context line is written as the file's
 *  own matched line. */
function resolveNewLoose(nLines: NewLine[], oldLines: string[], fileLines: string[], match: HunkMatch): string[] {
  if (match.exact) return resolveNew(nLines, oldLines, fileLines, match.start, match.tier);
  const f = leadingWs(fileLines[match.start]!);
  const p = leadingWs(oldLines[0]!);
  return nLines.map((n) => {
    if (n.ctx !== null) {
      if (oldLines[n.ctx] === '') return '';
      return fileLines[match.fileAt.get(n.ctx)!]!;
    }
    if (match.tier !== 2) return n.text;
    if (n.text === '' || /^[ \t]+$/.test(n.text)) return n.text;
    if (n.text.startsWith(p)) return f + n.text.slice(p.length);
    return n.text;
  });
}

/** Section 6, applying hunks: the hunks of a section apply in order, each
 *  to the result of the ones before it. Let d be the sum over this section's
 *  hunks applied so far of (N's length minus O's length). When O is not
 *  empty, of the occurrences at the tier where O is found, the hunk takes
 *  the one whose 0-based position is nearest to A - 1 + d; of two equally
 *  near, the earlier. When O is empty, N is inserted after the first A + d
 *  lines, all of them when the file has fewer. A `\` line refers to the body
 *  line before it: when a hunk's matched lines run to the end of the file
 *  (or, for an empty O, the insertion is at the end), the result ends with
 *  a line break unless a `\` line follows the hunk's last context or `+`
 *  line; when they do not, the file's final break stays as it was. */
function applyUnifiedHunks(fs: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let lines = [...fs.lines];
  let finalBr = fs.finalBr;
  let d = 0;
  for (const h of hunks) {
    if (h.oldLines.length === 0) {
      const before = lines.length;
      const pos = Math.min(h.a + d, before);
      lines.splice(pos, 0, ...h.newLines.map((n) => n.text));
      if (pos === before) finalBr = !h.noEol;
    } else {
      const found = findHunkMatch(lines, h.oldLines, h.a - 1 + d, strict);
      if (found === null) throw new Fail('no-match', path);
      const atEnd = found.end === lines.length - 1;
      const replacement = resolveNewLoose(h.newLines, h.oldLines, lines, found);
      lines.splice(found.start, found.end - found.start + 1, ...replacement);
      if (atEnd) finalBr = !h.noEol;
    }
    d += h.newLines.length - h.oldLines.length;
  }
  return { lines, br: fs.br, finalBr };
}

/** Section 6, the section's edit. A creation is the `+` lines of all its
 *  hunks, in order, and ends with a line break unless a `\` line follows
 *  its last `+` line. A deletion deletes the old path and its hunks are not
 *  read. A move applies the hunks to the old file's lines and writes the
 *  result at the new path, deleting the old path. Otherwise it is a change
 *  of the one path. Any failure of a hunk fails the section with that
 *  hunk's code, and the section changes nothing. Every path the edit names
 *  is checked for safety before anything else about it. */
function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  let oldPath: string | null | undefined = sec.oldPlus !== undefined ? sec.oldPlus : (sec.renameOld ?? sec.diffOld);
  let newPath: string | null | undefined = sec.newPlus !== undefined ? sec.newPlus : (sec.renameNew ?? sec.diffNew);
  if (oldPath === undefined) oldPath = newPath;
  if (newPath === undefined) newPath = oldPath;
  const oldP: string | null = oldPath === undefined ? '' : oldPath;
  const newP: string | null = newPath === undefined ? '' : newPath;
  const isCreate = sec.isCreate || oldP === null;
  const isDelete = !isCreate && (sec.isDelete || newP === null);
  if (isCreate) {
    const path = newP === null ? '' : newP;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        plus.push(...h.plusLines);
        if (h.plusLines.length > 0) noEol = h.noEolPlus;
      }
      tree.now.set(path, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
    };
  }
  if (isDelete) {
    const path = oldP === null ? '' : oldP;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  if (oldP !== newP) {
    const oldFile = oldP;
    const newFile = newP;
    return (tree) => {
      if (!safe(oldFile)) throw new Fail('unsafe', oldFile);
      if (!safe(newFile)) throw new Fail('unsafe', newFile);
      const before = tree.get(oldFile);
      if (before === null) throw new Fail('missing', oldFile);
      if (tree.get(newFile) !== null) throw new Fail('exists', newFile);
      const after = writeFileState(applyUnifiedHunks(parseFile(before), sec.hunks, strict, oldFile));
      tree.now.set(newFile, after);
      tree.now.set(oldFile, null);
      tree.moves.push([oldFile, newFile]);
    };
  }
  const path = oldP;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const after = writeFileState(applyUnifiedHunks(parseFile(before), sec.hunks, strict, path));
    tree.now.set(path, after);
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => unifiedEdit(s, strict));
}

/** Section 7: SEARCH/REPLACE blocks. The three marker lines are matched
 *  with their trailing whitespace removed. The separators are found by a
 *  forward scan: the first `=======` after the SEARCH line, then the first
 *  `>>>>>>> REPLACE` after that. A SEARCH line with no `=======` and then
 *  `>>>>>>> REPLACE` after it is `error: parse` at the SEARCH line. The
 *  path is the nearest line before the SEARCH line, and after the previous
 *  block's `>>>>>>> REPLACE` line (or the start of the patch), that is not
 *  blank and, its surrounding whitespace removed, does not start with three
 *  backticks; the path is that line with its surrounding whitespace removed.
 *  When there is no such line the block takes the previous block's path; the
 *  first block with none is `error: parse` at its SEARCH line. Lines outside
 *  blocks are otherwise ignored. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let cursor = 0;
  let prevEnd = -1;
  let prevPath: string | undefined;
  for (;;) {
    let searchIdx = -1;
    for (let k = cursor; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        searchIdx = k;
        break;
      }
    }
    if (searchIdx < 0) break;
    let eqIdx = -1;
    for (let k = searchIdx + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eqIdx = k;
        break;
      }
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let endIdx = -1;
    for (let k = eqIdx + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        endIdx = k;
        break;
      }
    }
    if (endIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | undefined;
    for (let k = searchIdx - 1; k > prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trimStart().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === undefined) path = prevPath;
    if (path === undefined) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, endIdx);
    const blockPath = path;
    if (oldLines.length === 0) {
      const made = newLines.length === 0 ? '' : newLines.join('\n') + '\n';
      edits.push((tree) => {
        if (!safe(blockPath)) throw new Fail('unsafe', blockPath);
        if (tree.get(blockPath) !== null) throw new Fail('exists', blockPath);
        tree.now.set(blockPath, made);
      });
    } else {
      const olds = [...oldLines];
      const news: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
      edits.push((tree) => {
        if (!safe(blockPath)) throw new Fail('unsafe', blockPath);
        const before = tree.get(blockPath);
        if (before === null) throw new Fail('missing', blockPath);
        const fs = parseFile(before);
        let found: { tier: number; pos: number } | null = null;
        for (const tier of tiers(strict)) {
          const occ = occurrences(fs.lines, olds, tier, 0);
          if (occ.length === 0) continue;
          if (occ.length > 1) throw new Fail('ambiguous', blockPath);
          found = { tier, pos: occ[0]! };
          break;
        }
        if (found === null) throw new Fail('no-match', blockPath);
        const replacement = resolveNew(news, olds, fs.lines, found.pos, found.tier);
        const out = [...fs.lines];
        out.splice(found.pos, olds.length, ...replacement);
        tree.now.set(blockPath, writeFileState({ lines: out, br: fs.br, finalBr: fs.finalBr }));
      });
    }
    prevEnd = endIdx;
    prevPath = path;
    cursor = endIdx + 1;
  }
  return edits;
}

/** Section 8: one chunk of a V4A Update File section. The anchor is the
 *  text after `@@`, its surrounding spaces removed; an empty text is no
 *  anchor. `eof` says a `*** End of File` line ended the chunk and anchors
 *  it to the end of the file. */
interface VChunk {
  anchor: string;
  hasAnchor: boolean;
  oldLines: string[];
  newLines: NewLine[];
  eof: boolean;
}

function buildVChunk(body: string[], anchor: string, eof: boolean): VChunk {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  for (const l of body) {
    if (l === '') {
      oldLines.push('');
      newLines.push({ text: '', ctx: oldLines.length - 1 });
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      oldLines.push(t);
      newLines.push({ text: t, ctx: oldLines.length - 1 });
    } else if (l[0] === '-') {
      oldLines.push(l.slice(1));
    } else if (l[0] === '+') {
      newLines.push({ text: l.slice(1), ctx: null });
    }
  }
  return { anchor, hasAnchor: anchor !== '', oldLines, newLines, eof };
}

/** Section 8, applying one Update File section's chunks to a file's lines.
 *  The cursor starts at line 0. A chunk with an anchor first finds the
 *  first line at or after the cursor equal to the anchor at the first tier
 *  where one is, both sides a single line, else `no-match`; the cursor moves
 *  past it. The chunk takes the first occurrence of O at or after the
 *  cursor, at the first tier with one; an end-of-file chunk takes only an
 *  occurrence that ends at the file's last line. When O is empty, N is
 *  inserted at the cursor, or at the end of the file for an end-of-file
 *  chunk. The cursor then moves to just after the lines written. */
function applyVChunks(lines: string[], chunks: VChunk[], strict: boolean, path: string): string[] {
  let out = [...lines];
  let cursor = 0;
  for (const c of chunks) {
    if (c.hasAnchor) {
      let at = -1;
      for (const tier of tiers(strict)) {
        for (let k = cursor; k < out.length; k++) {
          if (lineEq(out[k]!, c.anchor, tier)) {
            at = k;
            break;
          }
        }
        if (at >= 0) break;
      }
      if (at < 0) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    if (c.oldLines.length === 0) {
      const pos = c.eof ? out.length : cursor;
      out.splice(pos, 0, ...c.newLines.map((n) => n.text));
      cursor = pos + c.newLines.length;
      continue;
    }
    let found: { tier: number; pos: number } | null = null;
    for (const tier of tiers(strict)) {
      if (c.eof) {
        const pos = out.length - c.oldLines.length;
        if (pos >= cursor && pos >= 0) {
          let ok = true;
          for (let j = 0; j < c.oldLines.length; j++) {
            if (!lineEq(out[pos + j]!, c.oldLines[j]!, tier)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            found = { tier, pos };
            break;
          }
        }
      } else {
        const occ = occurrences(out, c.oldLines, tier, cursor);
        if (occ.length > 0) {
          found = { tier, pos: occ[0]! };
          break;
        }
      }
    }
    if (found === null) throw new Fail('no-match', path);
    const replacement = resolveNew(c.newLines, c.oldLines, out, found.pos, found.tier);
    out.splice(found.pos, c.oldLines.length, ...replacement);
    cursor = found.pos + replacement.length;
  }
  return out;
}

/** Section 8, reading: the first non-blank line is `*** Begin Patch`, else
 *  `error: parse` at that line (`error: parse 1` when there is none), and
 *  the last non-blank line is `*** End Patch`, else `error: parse` at the
 *  number of patch lines plus 1; both are compared with their surrounding
 *  whitespace removed. Between them, sections start at `*** Add File: `,
 *  `*** Delete File: ` and `*** Update File: ` lines, the path being the
 *  rest of the line with its surrounding spaces removed. Blank lines
 *  between sections are ignored, and blank lines at the end of a section,
 *  before the next section or `*** End Patch`, are not part of it. Any other
 *  line is `error: parse` at its line.
 *
 *  `*** End of File` ends a chunk and anchors it to the end of the file;
 *  it does not end the section, so an `@@` line after it starts a new
 *  chunk in the same section, while a body line after it, which could only
 *  start the first chunk, is a parse error. `*** End of File` itself is
 *  matched exactly: unlike `*** Begin Patch` and `*** End Patch`, the
 *  specification gives it no whitespace-trimmed comparison. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (!isSectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const startNo = i + 1;
    const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const path = trimSpaces(line.slice(kind === 'add' ? 14 : kind === 'delete' ? 17 : 17));
    const raw: Array<{ text: string; no: number }> = [];
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) {
      raw.push({ text: lines[j]!, no: j + 1 });
      j++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      const made = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, made);
      });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | undefined;
      let k = 0;
      if (k < raw.length && raw[k]!.text.startsWith('*** Move to: ')) {
        moveTo = trimSpaces(raw[k]!.text.slice(13));
        k++;
      }
      const chunks: VChunk[] = [];
      let body: string[] = [];
      let anchor = '';
      let open = false;
      let eof = false;
      const closeChunk = (): void => {
        if (!open) return;
        chunks.push(buildVChunk(body, anchor, eof));
        body = [];
        anchor = '';
        open = false;
        eof = false;
      };
      for (; k < raw.length; k++) {
        const r = raw[k]!;
        if (r.text === '*** End of File') {
          if (!open) throw new Exit2(`error: parse ${r.no}`);
          eof = true;
          closeChunk();
        } else if (r.text.startsWith('@@')) {
          closeChunk();
          anchor = trimSpaces(r.text.slice(2));
          body = [];
          open = true;
          eof = false;
        } else if (r.text === '' || r.text[0] === ' ' || r.text[0] === '-' || r.text[0] === '+') {
          if (!open) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
            anchor = '';
            body = [];
            open = true;
            eof = false;
          }
          body.push(r.text);
        } else {
          throw new Exit2(`error: parse ${r.no}`);
        }
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${startNo}`);
      const updatePath = path;
      const newPath = moveTo;
      edits.push((tree) => {
        if (!safe(updatePath)) throw new Fail('unsafe', updatePath);
        if (newPath !== undefined && !safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(updatePath);
        if (before === null) throw new Fail('missing', updatePath);
        if (newPath !== undefined && tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const fs = parseFile(before);
        const after = writeFileState({ lines: applyVChunks(fs.lines, chunks, strict, updatePath), br: fs.br, finalBr: fs.finalBr });
        if (newPath !== undefined) {
          tree.now.set(newPath, after);
          tree.now.set(updatePath, null);
          tree.moves.push([updatePath, newPath]);
        } else {
          tree.now.set(updatePath, after);
        }
      });
    }
    i = j;
  }
  return edits;
}

/** Sections 1, 2 and 10: the command line, the output and exit codes, and
 *  the order and atomicity of the edits. A usage error is any argument that
 *  starts with `-` and is not `-` and not one of the options above (before
 *  `--`), an option given twice, a `--format` value other than the five
 *  names, or more than one positional argument. Options and PATCH may come
 *  in any order, and `--` ends the options. They are tried in order: a usage
 *  error wins over everything, then a patch that cannot be read, then a
 *  format that cannot be detected, then a parse error, which is reported
 *  before any file is looked at. Edits apply in the patch's order to the
 *  tree as earlier edits left it. A failed edit changes nothing, and the
 *  edits after it still run, so every failure is reported. When any edit
 *  failed, no file is written; when none failed, every change is written,
 *  or with `--check` none is. */
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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const entries = new Map<string, string>();
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      entries.delete(oldP);
      entries.delete(newP);
      entries.set(newP, `R ${oldP} -> ${newP}`);
    }
  }
  const rows = [...entries.entries()].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]))).map(([, line]) => line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
