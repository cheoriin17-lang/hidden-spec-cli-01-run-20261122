// mend: apply an AI-written edit to a tree of text files.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE,
// V4A, JSON tool calls) and applies it atomically: every file is changed
// or nothing is. See SPEC.md for the full contract.
//
// When MAKEFUN_ENV_URL is set, this program is running a make.fun trial:
// it fetches the trial's checks, runs itself on each, and posts the results.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

// The entry point lives at the bottom of this file, after every
// declaration it uses: see the MAKEFUN_ENV_URL block at the end.

// ---------------------------------------------------------------------------
// Small types

interface FileView {
  br: string;
  lines: string[];
  ends: boolean;
}

interface Occurrence {
  start: number;
  end: number;
  // map[k] is the file line matched by O[k], or -1 when O[k] is an empty
  // line that was skipped over a non-empty file line (or past the end).
  map: number[];
}

// A patch line item: the text, and whether it is a context line (a line of
// both O and N). Context lines are written as the file's own matched line.
interface PatchItem {
  text: string;
  ctx: boolean;
}

type EditError = { code: string; path: string } | null;
type EditFn = (tree: Map<string, string>, moves: Array<[string, string]>) => EditError;

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super('parse ' + line);
    this.line = line;
  }
}

// ---------------------------------------------------------------------------
// Files, lines and paths (SPEC 3)

function splitFile(text: string): FileView {
  if (text === '') return { br: '\n', lines: [], ends: false };
  const i = text.indexOf('\n');
  const br = i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  if (text.endsWith(br)) return { br, lines: parts.slice(0, -1), ends: true };
  return { br, lines: parts, ends: false };
}

function joinFile(br: string, lines: string[], ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

// A patch's lines are its text split at \n, each with one trailing \r
// removed, and without the empty piece after a final \n.
function patchLines(text: string): string[] {
  if (text === '') return [];
  const ls = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (text.endsWith('\n')) ls.pop();
  return ls;
}

function isBlank(s: string): boolean {
  return s.trim() === '';
}

function trimSpaces(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a += 1;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b -= 1;
  return s.slice(a, b);
}

function trimEndSpaces(s: string): string {
  let b = s.length;
  while (b > 0 && (s[b - 1] === ' ' || s[b - 1] === '\t')) b -= 1;
  return s.slice(0, b);
}

function leadWs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

function isSafe(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false;
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// UTF-8 byte order, for sorting output paths.
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC 5)

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndSpaces(a) === trimEndSpaces(b);
  return trimSpaces(a) === trimSpaces(b);
}

// Occurrences of O in the file's lines F at one tier.
//
// O is anchored on its first line: a candidate start is a position where
// O's first line matches a file line at this tier. From there the match
// extends forward, and an exactly empty line on either side is passed over:
// an empty O line takes an empty file line when one is there, else it is
// skipped; an empty file line is skipped while O's line is not empty. The
// occurrence's span runs from the anchored line to just past the last file
// line the match took.
function matchOccs(O: string[], F: string[], tier: number): Occurrence[] {
  if (O.length === 0) {
    const out: Occurrence[] = [];
    for (let s = 0; s <= F.length; s += 1) out.push({ start: s, end: s, map: [] });
    return out;
  }
  const out: Occurrence[] = [];
  for (let p = 0; p < F.length; p += 1) {
    if (!tierEq(O[0], F[p], tier)) continue;
    const map: number[] = new Array<number>(O.length).fill(-1);
    map[0] = p;
    let i = 1;
    let j = p + 1;
    let ok = true;
    while (i < O.length) {
      if (O[i] === '') {
        if (j < F.length && F[j] === '') {
          map[i] = j;
          i += 1;
          j += 1;
        } else {
          i += 1;
        }
      } else {
        if (j >= F.length) {
          ok = false;
          break;
        }
        if (F[j] === '') {
          j += 1;
          continue;
        }
        if (tierEq(O[i], F[j], tier)) {
          map[i] = j;
          i += 1;
          j += 1;
        } else {
          ok = false;
          break;
        }
      }
    }
    if (ok) out.push({ start: p, end: j, map });
  }
  return out;
}

// The first tier at which O occurs at least once, with its occurrences.
// With --strict only tier 0 is tried.
function findTier(O: string[], F: string[], strict: boolean): { tier: number; occs: Occurrence[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occs = matchOccs(O, F, tier);
    if (occs.length > 0) return { tier, occs };
  }
  return null;
}

// Build the lines that replace a matched occurrence. N's context lines are
// written as the file's own matched lines; at tier 2 every other line of N
// is re-indented (SPEC 5): F is the leading spaces/tabs of the file's first
// matched line, P those of O's first line; a non-empty, non-whitespace-only
// line of N that starts with P has that P replaced by F.
function buildReplacement(N: PatchItem[], O: PatchItem[], F: string[], occ: Occurrence, tier: number): string[] {
  const oLines = O.map((x) => x.text);
  const oCtx: number[] = [];
  O.forEach((x, k) => {
    if (x.ctx) oCtx.push(k);
  });
  const P = oLines.length > 0 ? leadWs(oLines[0]) : '';
  const F0 = occ.start >= 0 && occ.start < F.length ? leadWs(F[occ.start]) : '';
  const out: string[] = [];
  let ctxI = 0;
  for (const item of N) {
    if (item.ctx) {
      const oi = oCtx[ctxI];
      ctxI += 1;
      const fi = occ.map[oi];
      out.push(fi >= 0 ? F[fi] : item.text);
    } else if (tier === 2 && item.text !== '' && item.text.trim() !== '' && item.text.startsWith(P)) {
      out.push(F0 + item.text.slice(P.length));
    } else {
      out.push(item.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC 6)

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  old: string | null;
  next: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const DIFFGIT_RE = /^diff --git a\/(.*) b\/(.*)$/;

// The path after `--- ` or `+++ `: the text after the four characters, up
// to the first tab, with surrounding spaces removed.
function headerPath(line: string): string {
  let s = line.slice(4);
  const ti = s.indexOf('\t');
  if (ti >= 0) s = s.slice(0, ti);
  return trimSpaces(s);
}

function isSectionStart(lines: string[], i: number): boolean {
  if (lines[i].startsWith('diff --git ')) return true;
  return lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ');
}

function parseUniSection(lines: string[], i: number, gitOld: string | null, gitNew: string | null): { sec: UniSection; next: number } {
  const n = lines.length;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renOld: string | null = null;
  let renNew: string | null = null;
  let newFile = false;
  let deletedFile = false;
  // Header: everything before the first hunk. `index`, mode lines,
  // similarity lines, `Index:` lines and any other line are ignored.
  while (i < n) {
    const l = lines[i];
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      pairOld = headerPath(l);
      pairNew = headerPath(lines[i + 1]);
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) throw new ParseError(i + 2);
    if (l.startsWith('+++ ')) {
      pairNew = headerPath(l);
      i += 1;
      continue;
    }
    if (l.startsWith('rename from ')) {
      renOld = l.slice('rename from '.length);
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      renNew = l.slice('rename to '.length);
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      newFile = true;
      i += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  const norm = (p: string | null): string | null => (p === null || p === '/dev/null' ? null : p);
  let oldRaw = pairOld !== null ? pairOld : renOld !== null ? renOld : gitOld;
  let nextRaw = pairNew !== null ? pairNew : renNew !== null ? renNew : gitNew;
  // A leading a/ or b/ is removed from a ---/+++ path, before /dev/null is
  // recognised as no file.
  if (pairOld !== null && oldRaw !== null && (oldRaw.startsWith('a/') || oldRaw.startsWith('b/'))) oldRaw = oldRaw.slice(2);
  if (pairNew !== null && nextRaw !== null && (nextRaw.startsWith('a/') || nextRaw.startsWith('b/'))) nextRaw = nextRaw.slice(2);
  const old = norm(oldRaw);
  const next = norm(nextRaw);
  const isCreate = old === null || newFile;
  const isDelete = next === null || deletedFile;
  if (isDelete && !isCreate) {
    // A deletion's hunks are not read at all: skip to the next section.
    if (i < n && lines[i].startsWith('@@')) {
      while (i < n && !isSectionStart(lines, i)) i += 1;
    }
    return { sec: { old, next, create: false, remove: true, hunks: [] }, next: i };
  }
  const hunks: Hunk[] = [];
  while (i < n) {
    const l = lines[i];
    if (isSectionStart(lines, i)) break;
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new ParseError(i + 1);
      const a = Number(m[1]);
      i += 1;
      const body: string[] = [];
      while (i < n) {
        const l2 = lines[i];
        if (isSectionStart(lines, i)) break;
        if (l2 === '' || l2[0] === ' ' || l2[0] === '-' || l2[0] === '+' || l2[0] === '\\') {
          body.push(l2);
          i += 1;
        } else {
          break;
        }
      }
      // Empty lines at the end of a body are not part of it: drop trailing
      // body lines whose context text is empty (an empty line, or a context
      // line holding nothing). A line of two spaces holds one space of
      // context text, so it stays.
      while (body.length > 0 && (body[body.length - 1] === '' || body[body.length - 1] === ' ')) body.pop();
      hunks.push({ a, body });
      continue;
    }
    i += 1;
  }
  return { sec: { old, next, create: isCreate, remove: false, hunks }, next: i };
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = DIFFGIT_RE.exec(l);
      if (m === null) throw new ParseError(i + 1);
      const r = parseUniSection(lines, i + 1, m[1], m[2]);
      sections.push(r.sec);
      i = r.next;
    } else if (l.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      const r = parseUniSection(lines, i, null, null);
      sections.push(r.sec);
      i = r.next;
    } else if (l.startsWith('@@')) {
      throw new ParseError(i + 1);
    } else {
      i += 1;
    }
  }
  if (sections.length === 0) throw new ParseError(1);
  return sections;
}

// Split a hunk body into O items (context and - lines) and N items
// (context and + lines), in body order. Also reports whether a \ line
// follows the hunk's last context or + line (for the final line break),
// and whether one follows its last + line (for a created file).
function hunkItems(body: string[]): { O: PatchItem[]; N: PatchItem[]; bsCtxPlus: boolean; bsPlus: boolean } {
  const O: PatchItem[] = [];
  const N: PatchItem[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((l, bi) => {
    if (l === '' || l.startsWith(' ')) {
      const t = l.startsWith(' ') ? l.slice(1) : '';
      O.push({ text: t, ctx: true });
      N.push({ text: t, ctx: true });
      lastCtxPlus = bi;
    } else if (l.startsWith('-')) {
      O.push({ text: l.slice(1), ctx: false });
    } else if (l.startsWith('+')) {
      N.push({ text: l.slice(1), ctx: false });
      lastCtxPlus = bi;
      lastPlus = bi;
    }
  });
  const after = (idx: number): boolean => idx >= 0 && idx + 1 < body.length && body[idx + 1].startsWith('\\');
  return { O, N, bsCtxPlus: after(lastCtxPlus), bsPlus: after(lastPlus) };
}

// Apply a section's hunks in order, each to the result of the ones before
// it. Returns the new lines and final-break flag, or the string 'no-match'.
function applyHunks(hunks: Hunk[], lines: string[], ends: boolean, strict: boolean): { lines: string[]; ends: boolean } | 'no-match' {
  let d = 0;
  let cur = [...lines];
  let curEnds = ends;
  for (const h of hunks) {
    const { O, N, bsCtxPlus } = hunkItems(h.body);
    const oLines = O.map((x) => x.text);
    const preLen = cur.length;
    if (oLines.length > 0) {
      const found = findTier(oLines, cur, strict);
      if (found === null) return 'no-match';
      const target = h.a - 1 + d;
      let best = found.occs[0];
      for (const occ of found.occs) {
        const bd = Math.abs(occ.start - target);
        const cd = Math.abs(best.start - target);
        if (bd < cd || (bd === cd && occ.start < best.start)) best = occ;
      }
      const newLines = buildReplacement(N, O, cur, best, found.tier);
      cur = [...cur.slice(0, best.start), ...newLines, ...cur.slice(best.end)];
      if (best.end === preLen) curEnds = !bsCtxPlus;
      d += N.length - O.length;
    } else {
      const pos = Math.min(h.a + d, cur.length);
      const newLines = N.map((x) => x.text);
      const atEnd = pos === preLen;
      cur = [...cur.slice(0, pos), ...newLines, ...cur.slice(pos)];
      if (atEnd) curEnds = !bsCtxPlus;
      d += N.length - O.length;
    }
  }
  return { lines: cur, ends: curEnds };
}

function unifiedEdits(sections: UniSection[], strict: boolean): EditFn[] {
  return sections.map((sec) => {
    return (tree: Map<string, string>, moves: Array<[string, string]>): EditError => {
      if (sec.create) {
        const tgt = sec.next !== null ? sec.next : '/dev/null';
        if (!isSafe(tgt)) return { code: 'unsafe', path: tgt };
        if (tree.has(tgt)) return { code: 'exists', path: tgt };
        const plus: string[] = [];
        for (const h of sec.hunks) {
          const { N } = hunkItems(h.body);
          for (const item of N) plus.push(item.text);
        }
        let lastBs = false;
        for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
          const { N, bsPlus } = hunkItems(sec.hunks[hi].body);
          if (N.some((x) => !x.ctx)) {
            lastBs = bsPlus;
            break;
          }
        }
        tree.set(tgt, plus.length > 0 ? joinFile('\n', plus, !lastBs) : '');
        return null;
      }
      if (sec.remove) {
        const tgt = sec.old !== null ? sec.old : '/dev/null';
        if (!isSafe(tgt)) return { code: 'unsafe', path: tgt };
        if (!tree.has(tgt)) return { code: 'missing', path: tgt };
        tree.delete(tgt);
        return null;
      }
      if (sec.old !== sec.next) {
        const old = sec.old as string;
        const next = sec.next as string;
        if (!isSafe(old)) return { code: 'unsafe', path: old };
        if (!isSafe(next)) return { code: 'unsafe', path: next };
        if (!tree.has(old)) return { code: 'missing', path: old };
        if (tree.has(next)) return { code: 'exists', path: next };
        const view = splitFile(tree.get(old) as string);
        const r = applyHunks(sec.hunks, view.lines, view.ends, strict);
        if (r === 'no-match') return { code: 'no-match', path: old };
        tree.set(next, joinFile(view.br, r.lines, r.ends));
        tree.delete(old);
        moves.push([old, next]);
        return null;
      }
      const old = sec.old as string;
      if (!isSafe(old)) return { code: 'unsafe', path: old };
      if (!tree.has(old)) return { code: 'missing', path: old };
      const view = splitFile(tree.get(old) as string);
      const r = applyHunks(sec.hunks, view.lines, view.ends, strict);
      if (r === 'no-match') return { code: 'no-match', path: old };
      tree.set(old, joinFile(view.br, r.lines, r.ends));
      return null;
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC 7)

interface SrBlock {
  path: string;
  old: string[];
  next: string[];
}

function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  const n = lines.length;
  let i = 0;
  let prevBoundary = -1;
  let prevPath: string | null = null;
  for (;;) {
    let j = -1;
    for (let k = i; k < n; k += 1) {
      if (trimEndSpaces(lines[k]) === '<<<<<<< SEARCH') {
        j = k;
        break;
      }
    }
    if (j < 0) break;
    // The path is the nearest line before the SEARCH line, and after the
    // previous block's REPLACE line (or the start of the patch), that is not
    // blank and does not start with three backticks.
    let path: string | null = null;
    for (let k = j - 1; k > prevBoundary; k -= 1) {
      if (!isBlank(lines[k]) && !trimSpaces(lines[k]).startsWith('```')) {
        path = trimSpaces(lines[k]);
        break;
      }
    }
    if (path === null) {
      if (prevPath === null) throw new ParseError(j + 1);
      path = prevPath;
    }
    let sep = -1;
    for (let k = j + 1; k < n; k += 1) {
      if (trimEndSpaces(lines[k]) === '=======') {
        sep = k;
        break;
      }
    }
    if (sep < 0) throw new ParseError(j + 1);
    let rep = -1;
    for (let k = sep + 1; k < n; k += 1) {
      if (trimEndSpaces(lines[k]) === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new ParseError(j + 1);
    blocks.push({ path, old: lines.slice(j + 1, sep), next: lines.slice(sep + 1, rep) });
    prevPath = path;
    prevBoundary = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new ParseError(1);
  return blocks;
}

function searchReplaceEdits(blocks: SrBlock[], strict: boolean): EditFn[] {
  return blocks.map((b) => {
    return (tree: Map<string, string>, _moves: Array<[string, string]>): EditError => {
      const p = b.path;
      if (!isSafe(p)) return { code: 'unsafe', path: p };
      if (b.old.length === 0) {
        if (tree.has(p)) return { code: 'exists', path: p };
        tree.set(p, b.next.length > 0 ? joinFile('\n', b.next, true) : '');
        return null;
      }
      if (!tree.has(p)) return { code: 'missing', path: p };
      const view = splitFile(tree.get(p) as string);
      const O: PatchItem[] = b.old.map((t) => ({ text: t, ctx: false }));
      const N: PatchItem[] = b.next.map((t) => ({ text: t, ctx: false }));
      const found = findTier(b.old, view.lines, strict);
      if (found === null) return { code: 'no-match', path: p };
      if (found.occs.length > 1) return { code: 'ambiguous', path: p };
      const occ = found.occs[0];
      const newLines = buildReplacement(N, O, view.lines, occ, found.tier);
      tree.set(p, joinFile(view.br, [...view.lines.slice(0, occ.start), ...newLines, ...view.lines.slice(occ.end)], view.ends));
      return null;
    };
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC 8)

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

type V4aSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[] };

function v4aSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ') || l === '*** End Patch';
}

function parseV4a(lines: string[]): V4aSection[] {
  const n = lines.length;
  const nonblank: number[] = [];
  lines.forEach((l, idx) => {
    if (!isBlank(l)) nonblank.push(idx);
  });
  if (nonblank.length === 0) throw new ParseError(1);
  const first = nonblank[0];
  if (trimSpaces(lines[first]) !== '*** Begin Patch') throw new ParseError(first + 1);
  const last = nonblank[nonblank.length - 1];
  if (trimSpaces(lines[last]) !== '*** End Patch') throw new ParseError(n + 1);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i];
    if (isBlank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = trimSpaces(l.slice('*** Add File: '.length));
      i += 1;
      const fl: string[] = [];
      while (i < last) {
        const l2 = lines[i];
        if (v4aSectionStart(l2)) break;
        if (l2.startsWith('+')) {
          fl.push(l2.slice(1));
          i += 1;
        } else if (l2 === '') {
          fl.push('');
          i += 1;
        } else {
          throw new ParseError(i + 1);
        }
      }
      while (fl.length > 0 && fl[fl.length - 1] === '') fl.pop();
      sections.push({ kind: 'add', path, lines: fl });
    } else if (l.startsWith('*** Delete File: ')) {
      const path = trimSpaces(l.slice('*** Delete File: '.length));
      i += 1;
      while (i < last) {
        const l2 = lines[i];
        if (v4aSectionStart(l2)) break;
        if (l2 === '') {
          i += 1;
          continue;
        }
        throw new ParseError(i + 1);
      }
      sections.push({ kind: 'delete', path });
    } else if (l.startsWith('*** Update File: ')) {
      const path = trimSpaces(l.slice('*** Update File: '.length));
      const updLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let closed = false;
      let firstLine = true;
      while (i < last) {
        const l2 = lines[i];
        if (v4aSectionStart(l2)) break;
        if (firstLine && l2.startsWith('*** Move to: ')) {
          moveTo = trimSpaces(l2.slice('*** Move to: '.length));
          i += 1;
          firstLine = false;
          continue;
        }
        firstLine = false;
        if (l2.startsWith('@@')) {
          // An @@ line after *** End of File starts a new chunk.
          if (cur !== null) chunks.push(cur);
          const anchor = trimSpaces(l2.slice(2));
          cur = { anchor: anchor !== '' ? anchor : null, eof: false, body: [] };
          closed = false;
          i += 1;
          continue;
        }
        if (l2 === '*** End of File') {
          if (cur === null) throw new ParseError(i + 1);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          closed = true;
          i += 1;
          continue;
        }
        if (l2.startsWith('*** Move to: ')) throw new ParseError(i + 1);
        if (l2 === '' || l2[0] === ' ' || l2[0] === '-' || l2[0] === '+') {
          if (cur === null) {
            if (closed) {
              // A body line after *** End of File is a parse error; a blank
              // line there is a blank line at the end of the section.
              if (l2 === '') {
                i += 1;
                continue;
              }
              throw new ParseError(i + 1);
            }
            cur = { anchor: null, eof: false, body: [] };
          }
          cur.body.push(l2);
          i += 1;
          continue;
        }
        throw new ParseError(i + 1);
      }
      if (cur !== null) {
        chunks.push(cur);
        // Blank lines at the end of a section are not part of it: drop
        // trailing body lines whose context text is empty.
        const b = chunks[chunks.length - 1].body;
        while (b.length > 0 && (b[b.length - 1] === '' || b[b.length - 1] === ' ')) b.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseError(updLine);
      sections.push({ kind: 'update', path, moveTo, chunks });
    } else {
      throw new ParseError(i + 1);
    }
  }
  if (sections.length === 0) throw new ParseError(1);
  return sections;
}

function v4aItems(body: string[]): { O: PatchItem[]; N: PatchItem[] } {
  const O: PatchItem[] = [];
  const N: PatchItem[] = [];
  for (const l of body) {
    if (l === '' || l.startsWith(' ')) {
      const t = l.startsWith(' ') ? l.slice(1) : '';
      O.push({ text: t, ctx: true });
      N.push({ text: t, ctx: true });
    } else if (l.startsWith('-')) {
      O.push({ text: l.slice(1), ctx: false });
    } else if (l.startsWith('+')) {
      N.push({ text: l.slice(1), ctx: false });
    }
  }
  return { O, N };
}

function v4aEdits(sections: V4aSection[], strict: boolean): EditFn[] {
  return sections.map((sec) => {
    return (tree: Map<string, string>, moves: Array<[string, string]>): EditError => {
      if (sec.kind === 'add') {
        const p = sec.path;
        if (!isSafe(p)) return { code: 'unsafe', path: p };
        if (tree.has(p)) return { code: 'exists', path: p };
        tree.set(p, sec.lines.length > 0 ? joinFile('\n', sec.lines, true) : '');
        return null;
      }
      if (sec.kind === 'delete') {
        const p = sec.path;
        if (!isSafe(p)) return { code: 'unsafe', path: p };
        if (!tree.has(p)) return { code: 'missing', path: p };
        tree.delete(p);
        return null;
      }
      const old = sec.path;
      const next = sec.moveTo;
      if (!isSafe(old)) return { code: 'unsafe', path: old };
      if (next !== null && !isSafe(next)) return { code: 'unsafe', path: next };
      if (!tree.has(old)) return { code: 'missing', path: old };
      if (next !== null && tree.has(next)) return { code: 'exists', path: next };
      const view = splitFile(tree.get(old) as string);
      let cur = [...view.lines];
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          // First line at or after the cursor equal to the anchor, at the
          // first tier where one is (both sides a single line).
          let found = -1;
          const tiers = strict ? [0] : [0, 1, 2];
          for (const tier of tiers) {
            for (let p = cursor; p < cur.length; p += 1) {
              if (tierEq(ch.anchor, cur[p], tier)) {
                found = p;
                break;
              }
            }
            if (found >= 0) break;
          }
          if (found < 0) return { code: 'no-match', path: old };
          cursor = found + 1;
        }
        const { O, N } = v4aItems(ch.body);
        const oLines = O.map((x) => x.text);
        if (oLines.length === 0) {
          const pos = ch.eof ? cur.length : cursor;
          const newLines = N.map((x) => x.text);
          cur = [...cur.slice(0, pos), ...newLines, ...cur.slice(pos)];
          cursor = pos + newLines.length;
          continue;
        }
        const found = findTier(oLines, cur, strict);
        if (found === null) return { code: 'no-match', path: old };
        let pick: Occurrence | null = null;
        for (const occ of found.occs) {
          if (occ.start < cursor) continue;
          if (ch.eof && occ.end !== cur.length) continue;
          pick = occ;
          break;
        }
        if (pick === null) return { code: 'no-match', path: old };
        const newLines = buildReplacement(N, O, cur, pick, found.tier);
        cur = [...cur.slice(0, pick.start), ...newLines, ...cur.slice(pick.end)];
        cursor = pick.start + newLines.length;
      }
      const text = joinFile(view.br, cur, view.ends);
      if (next !== null) {
        tree.set(next, text);
        tree.delete(old);
        moves.push([old, next]);
      } else {
        tree.set(old, text);
      }
      return null;
    };
  });
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC 9)

type JsonEdit = { path: string; command: string; file_text?: string; old_str?: string; new_str?: string; insert_line?: number };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validJsonEdit(obj: unknown): obj is JsonEdit {
  if (!isRecord(obj)) return false;
  if (typeof obj.path !== 'string') return false;
  const cmd = obj.command;
  if (cmd === 'create') return typeof obj.file_text === 'string';
  if (cmd === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') return false;
    return !('new_str' in obj) || typeof obj.new_str === 'string';
  }
  if (cmd === 'insert') {
    return typeof obj.insert_line === 'number' && Number.isInteger(obj.insert_line) && typeof obj.new_str === 'string';
  }
  return false;
}

function parseJson(lines: string[], text: string): JsonEdit[] {
  const nonblank: number[] = [];
  lines.forEach((l, idx) => {
    if (!isBlank(l)) nonblank.push(idx);
  });
  if (nonblank.length === 0) throw new ParseError(1);
  const firstI = nonblank[0];
  const firstL = lines[firstI];
  if (firstL.trimStart().startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(text) as unknown;
    } catch {
      throw new ParseError(firstI + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(firstI + 1);
    for (const el of arr) {
      if (!validJsonEdit(el)) throw new ParseError(firstI + 1);
    }
    if (arr.length === 0) throw new ParseError(1);
    return arr as JsonEdit[];
  }
  const edits: JsonEdit[] = [];
  for (const idx of nonblank) {
    let obj: unknown;
    try {
      obj = JSON.parse(lines[idx]) as unknown;
    } catch {
      throw new ParseError(idx + 1);
    }
    if (!validJsonEdit(obj)) throw new ParseError(idx + 1);
    edits.push(obj);
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

function countOverlapping(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = hay.indexOf(needle, i + 1);
  }
  return n;
}

// new_str's lines: split at \n, each with one trailing \r removed,
// without the empty piece after a final \n; an empty new_str has none.
function splitInsertText(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (s.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function jsonEdits(objs: JsonEdit[]): EditFn[] {
  return objs.map((o) => {
    return (tree: Map<string, string>, _moves: Array<[string, string]>): EditError => {
      const p = o.path;
      if (!isSafe(p)) return { code: 'unsafe', path: p };
      if (o.command === 'create') {
        if (tree.has(p)) return { code: 'exists', path: p };
        tree.set(p, o.file_text as string);
        return null;
      }
      if (!tree.has(p)) return { code: 'missing', path: p };
      if (o.command === 'str_replace') {
        const text = tree.get(p) as string;
        const view = splitFile(text);
        const oldStr = o.old_str as string;
        const newStr = o.new_str !== undefined ? o.new_str : '';
        if (view.br === '\r\n') {
          const nt = text.split('\r\n').join('\n');
          const no = oldStr.split('\r\n').join('\n');
          const nn = newStr.split('\r\n').join('\n');
          const cnt = countOverlapping(nt, no);
          if (cnt === 0) return { code: 'no-match', path: p };
          if (cnt > 1) return { code: 'ambiguous', path: p };
          tree.set(p, nt.replace(no, () => nn).split('\n').join('\r\n'));
          return null;
        }
        const cnt = countOverlapping(text, oldStr);
        if (cnt === 0) return { code: 'no-match', path: p };
        if (cnt > 1) return { code: 'ambiguous', path: p };
        tree.set(p, text.replace(oldStr, () => newStr));
        return null;
      }
      const view = splitFile(tree.get(p) as string);
      const il = o.insert_line as number;
      if (il < 0 || il > view.lines.length) return { code: 'no-match', path: p };
      const nl = splitInsertText(o.new_str as string);
      tree.set(p, joinFile(view.br, [...view.lines.slice(0, il), ...nl, ...view.lines.slice(il)], view.ends));
      return null;
    };
  });
}

// ---------------------------------------------------------------------------
// Detecting the format (SPEC 4)

type FormatName = 'unified' | 'search-replace' | 'v4a' | 'json';

function detectFormat(lines: string[]): FormatName | null {
  const nonblank = lines.filter((l) => !isBlank(l));
  if (nonblank.length === 0) return null;
  const first = nonblank[0];
  if (trimSpaces(first) === '*** Begin Patch') return 'v4a';
  const c = first.trimStart();
  if (c.startsWith('[') || c.startsWith('{')) return 'json';
  for (const l of lines) {
    if (trimEndSpaces(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Invocation (SPEC 1)

interface CliOpts {
  format: FormatName | 'auto';
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgv(argv: string[]): CliOpts | null {
  let format: FormatName | 'auto' = 'auto';
  let check = false;
  let strict = false;
  const seen = new Set<string>();
  const pos: string[] = [];
  let optsDone = false;
  for (const a of argv) {
    if (!optsDone && a === '--') {
      optsDone = true;
      continue;
    }
    if (!optsDone && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seen.has('check')) return null;
        seen.add('check');
        check = true;
      } else if (a === '--strict') {
        if (seen.has('strict')) return null;
        seen.add('strict');
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seen.has('format')) return null;
        seen.add('format');
        const v = a.slice('--format='.length);
        if (v !== 'auto' && v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json') return null;
        format = v;
      } else {
        return null;
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length > 1) return null;
  return { format, check, strict, patch: pos.length > 0 ? pos[0] : null };
}

// ---------------------------------------------------------------------------
// Output and exit codes (SPEC 2), order and atomicity (SPEC 10)

function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
      } else if (st.isFile()) {
        out.set(relative(dir, p).split(sep).join('/'), readFileSync(p, 'utf8'));
      }
    }
  };
  walk(dir);
  return out;
}

function main(): void {
  const opts = parseArgv(process.argv.slice(2));
  if (opts === null) {
    process.stdout.write('error: usage\n');
    process.exitCode = 2;
    return;
  }
  let patchText: string;
  if (opts.patch === null || opts.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(opts.patch, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      process.exitCode = 2;
      return;
    }
  }
  const lines = patchLines(patchText);
  let format = opts.format;
  if (format === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) {
      process.stdout.write('error: format\n');
      process.exitCode = 2;
      return;
    }
    format = detected;
  }
  let edits: EditFn[];
  try {
    if (format === 'unified') edits = unifiedEdits(parseUnified(lines), opts.strict);
    else if (format === 'search-replace') edits = searchReplaceEdits(parseSearchReplace(lines), opts.strict);
    else if (format === 'v4a') edits = v4aEdits(parseV4a(lines), opts.strict);
    else edits = jsonEdits(parseJson(lines, patchText));
  } catch (err) {
    if (err instanceof ParseError) {
      process.stdout.write('error: parse ' + err.line + '\n');
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  const before = readTree(process.cwd());
  const tree = new Map<string, string>(before);
  const moves: Array<[string, string]> = [];
  const failures: Array<{ code: string; path: string }> = [];
  for (const edit of edits) {
    const err = edit(tree, moves);
    if (err !== null) failures.push(err);
  }
  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += 'error: ' + f.code + ' ' + f.path + '\n';
    out += 'failed: ' + failures.length + ' of ' + edits.length + ' edits\n';
    process.stdout.write(out);
    process.exitCode = 1;
    return;
  }
  // One line for each path whose state changed, in byte order of the paths.
  const changed = new Map<string, string>();
  for (const p of new Set([...before.keys(), ...tree.keys()])) {
    if (!before.has(p)) changed.set(p, 'A ' + p);
    else if (!tree.has(p)) changed.set(p, 'D ' + p);
    else if (before.get(p) !== tree.get(p)) changed.set(p, 'M ' + p);
  }
  const rLines: Array<[string, string]> = [];
  for (const [old, next] of moves) {
    if (before.has(old) && !tree.has(old) && !before.has(next) && tree.has(next)) {
      changed.delete(old);
      changed.delete(next);
      rLines.push([next, 'R ' + old + ' -> ' + next]);
    }
  }
  const outItems: Array<[string, string]> = [...changed.entries()].map(([p, s]) => [p, s] as [string, string]);
  for (const r of rLines) outItems.push(r);
  outItems.sort((a, b) => byteCompare(a[0], b[0]));
  if (!opts.check) {
    const removed = [...before.keys()].filter((p) => !tree.has(p)).sort(byteCompare);
    for (const p of removed) {
      try {
        rmSync(join(process.cwd(), ...p.split('/')), { force: true });
      } catch {
        // A file that is already gone needs no removal.
      }
    }
    const written = [...tree.keys()].filter((p) => !before.has(p) || before.get(p) !== tree.get(p)).sort(byteCompare);
    for (const p of written) {
      const fp = join(process.cwd(), ...p.split('/'));
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, tree.get(p) as string, 'utf8');
    }
  }
  let out = '';
  for (const [, s] of outItems) out += s + '\n';
  out += outItems.length === 1 ? 'ok: 1 file\n' : 'ok: ' + outItems.length + ' files\n';
  process.stdout.write(out);
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Entry point

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl) {
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  main();
}
