// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file split into lines: its break, its lines, and whether it ends with a break. */
interface FileParts {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function fileParts(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function renderFile(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
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

/** One line of a replacement: context lines are written as the file's own matched line. */
interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

const leadingWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** A line compared at a tier: 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions i where O matches file lines i, i+1, ... at the given tier. */
function occurrences(file: string[], o: string[], tier: number, from = 0): number[] {
  const res: number[] = [];
  if (o.length === 0) return res;
  const on = o.map((l) => norm(l, tier));
  for (let i = Math.max(0, from); i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (norm(file[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier (0..2, or 0 only when strict) at which O occurs, with its positions. */
function findTier(file: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(file, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The lines N becomes when it replaces O matched at `pos`: context lines take the file's own
 *  line; at tier 2 the other lines are re-indented from O's first line to the file's. */
function buildReplacement(file: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWS(file[pos]!);
    p = leadingWS(o[0]!);
  }
  for (const nl of n) {
    if (nl.ctx) {
      out.push(file[pos + nl.oIdx]!);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** Apply one hunk/chunk replacement to `lines` at `pos`, returning the new lines. */
function spliceLines(lines: string[], pos: number, oLen: number, rep: string[]): string[] {
  return [...lines.slice(0, pos), ...rep, ...lines.slice(pos + oLen)];
}

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

/* ---------------- unified diffs (SPEC.md section 6) ---------------- */

interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  noNL: boolean;
  /** a `\` line follows the hunk's last `+` line */
  noNLPlus: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return stripPrefix((tab < 0 ? rest : rest.slice(0, tab)).trim());
}

function parseHunkBody(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  const body: string[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const l of body) {
    if (l === '' || l[0] === ' ') {
      const text = l === '' ? '' : l.slice(1);
      o.push(text);
      n.push({ text, ctx: true, oIdx: o.length - 1 });
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
    }
  }
  let noNL = false;
  let noNLPlus = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const l = body[k]!;
    if (l === '' || l[0] === ' ' || l[0] === '+') {
      noNL = body[k + 1] !== undefined && body[k + 1]![0] === '\\';
      break;
    }
  }
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]![0] === '+') {
      noNLPlus = body[k + 1] !== undefined && body[k + 1]![0] === '\\';
      break;
    }
  }
  return { hunk: { a, o, n, noNL, noNLPlus }, next: j };
}

/** Parse the header of one section (after its `diff --git` line, or starting at its `--- ` line). */
function parseUniHeader(lines: string[], i: number, sec: UniSection): number {
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renOld: string | null = null;
  let renNew: string | null = null;
  let pairSeen = false;
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('@@')) break;
    if (l.startsWith('--- ')) {
      if ((lines[j + 1] ?? '').startsWith('+++ ')) {
        if (pairSeen) break;
        pairOld = headerPath(l);
        pairNew = headerPath(lines[j + 1]!);
        pairSeen = true;
        j += 2;
        continue;
      }
      throw new Exit2(`error: parse ${j + 2}`);
    }
    if (l.startsWith('rename from ')) {
      if (renOld === null) renOld = l.slice('rename from '.length).trim();
      j++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (renNew === null) renNew = l.slice('rename to '.length).trim();
      j++;
      continue;
    }
    if (l.startsWith('new file mode')) {
      sec.isCreate = true;
      j++;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      sec.isDelete = true;
      j++;
      continue;
    }
    j++;
  }
  if (pairOld !== null) sec.oldPath = pairOld === '/dev/null' ? null : pairOld;
  else if (renOld !== null) sec.oldPath = renOld === '/dev/null' ? null : renOld;
  if (pairNew !== null) sec.newPath = pairNew === '/dev/null' ? null : pairNew;
  else if (renNew !== null) sec.newPath = renNew === '/dev/null' ? null : renNew;
  return j;
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/(.+)$/.exec(l.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: stripPrefix(m[1]!), newPath: stripPrefix(m[2]!.trim()), isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      i = parseUniHeader(lines, i + 1, cur);
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      i = parseUniHeader(lines, i, cur);
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunkBody(lines, i);
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    i++;
  }
  return sections;
}

/** Apply a section's hunks to a file's lines; returns the new lines and final-break flag. */
function applyHunks(parts: FileParts, hunks: Hunk[], strict: boolean, path: string): { lines: string[]; finalBreak: boolean } {
  let lines = parts.lines;
  let finalBreak = parts.finalBreak;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(lines, h.o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const rep = buildReplacement(lines, best, h.o, h.n, found.tier);
      const runsToEnd = best + h.o.length === lines.length;
      lines = spliceLines(lines, best, h.o.length, rep);
      if (runsToEnd) finalBreak = !h.noNL;
      d += h.n.length - h.o.length;
    } else {
      let idx = h.a + d;
      if (idx < 0) idx = 0;
      if (idx > lines.length) idx = lines.length;
      const atEnd = idx === lines.length;
      const rep = h.n.map((x) => x.text);
      lines = spliceLines(lines, idx, 0, rep);
      if (atEnd) finalBreak = !h.noNL;
      d += h.n.length;
    }
  }
  return { lines, finalBreak };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    return (tree: Tree) => {
      const oldP = sec.oldPath;
      const newP = sec.newPath;
      const create = sec.isCreate || oldP === null;
      const del = !create && (sec.isDelete || newP === null);
      const move = !create && !del && oldP !== null && newP !== null && oldP !== newP;
      if (create) {
        if (newP === null) return;
        const p = newP;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        for (const h of sec.hunks) for (const nl of h.n) if (!nl.ctx) plus.push(nl.text);
        let noNL = false;
        for (let k = sec.hunks.length - 1; k >= 0; k--) {
          const h = sec.hunks[k]!;
          if (h.n.some((x) => !x.ctx)) {
            noNL = h.noNLPlus;
            break;
          }
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noNL ? '' : '\n'));
        return;
      }
      if (del) {
        const p = oldP!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      if (move) {
        const op = oldP!;
        const np = newP!;
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const before = tree.get(op);
        if (before === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const parts = fileParts(before);
        const out = applyHunks(parts, sec.hunks, strict, op);
        tree.now.set(op, null);
        tree.now.set(np, renderFile(out.lines, parts.br, out.finalBreak));
        tree.moves.push([op, np]);
        return;
      }
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const parts = fileParts(before);
      const out = applyHunks(parts, sec.hunks, strict, p);
      tree.now.set(p, renderFile(out.lines, parts.br, out.finalBreak));
    };
  });
}

/* ---------------- SEARCH/REPLACE blocks (SPEC.md section 7) ---------------- */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i;
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (blocks.length === 0) throw new Exit2(`error: parse ${searchLine + 1}`);
        path = blocks[blocks.length - 1]!.path;
      }
      let eq = -1;
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '=======') {
          eq = k;
          break;
        }
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
      let rep = -1;
      for (let k = eq + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
      blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevEnd = rep;
      i = rep + 1;
      continue;
    }
    i++;
  }
  return blocks;
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseSearchReplace(lines);
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    return (tree: Tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const parts = fileParts(before);
      const found = findTier(parts.lines, b.oldLines, strict);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
      const n: NewLine[] = b.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
      const rep = buildReplacement(parts.lines, found.occ[0]!, b.oldLines, n, found.tier);
      tree.now.set(b.path, renderFile(spliceLines(parts.lines, found.occ[0]!, b.oldLines.length, rep), parts.br, parts.finalBreak));
    };
  });
}

/* ---------------- V4A patches (SPEC.md section 8) ---------------- */

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NewLine[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  newPath: string | null;
  addLines: string[];
  chunks: V4AChunk[];
}

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';

function v4aSectionStart(l: string): string | null {
  if (l.startsWith(V4A_ADD)) return 'add';
  if (l.startsWith(V4A_DEL)) return 'delete';
  if (l.startsWith(V4A_UPD)) return 'update';
  return null;
}

function parseV4A(lines: string[]): V4ASection[] {
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
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const kind = v4aSectionStart(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = l.slice(kind === 'add' ? V4A_ADD.length : kind === 'delete' ? V4A_DEL.length : V4A_UPD.length).trim();
    const startLine = i;
    i++;
    const raw: number[] = [];
    while (i < last && v4aSectionStart(lines[i]!) === null) {
      raw.push(i);
      i++;
    }
    while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const k of raw) {
        const rl = lines[k]!;
        if (rl === '') addLines.push('');
        else if (rl[0] === '+') addLines.push(rl.slice(1));
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      sections.push({ kind, path, newPath: null, addLines, chunks: [] });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]! + 1}`);
      sections.push({ kind, path, newPath: null, addLines: [], chunks: [] });
    } else {
      let newPath: string | null = null;
      let k = 0;
      if (k < raw.length && lines[raw[k]!]!.startsWith('*** Move to: ')) {
        newPath = lines[raw[k]!]!.slice('*** Move to: '.length).trim();
        k++;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      let closed = false;
      const closeChunk = () => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; k < raw.length; k++) {
        const rl = lines[raw[k]!]!;
        if (rl.startsWith('@@')) {
          closeChunk();
          const anchor = rl.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [] };
          closed = false;
          continue;
        }
        if (rl.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${raw[k]! + 1}`);
          cur.eof = true;
          closeChunk();
          closed = true;
          continue;
        }
        if (rl === '' || rl[0] === ' ' || rl[0] === '-' || rl[0] === '+') {
          if (cur === null) {
            if (chunks.length === 0 && !closed) {
              cur = { anchor: null, eof: false, o: [], n: [] };
            } else throw new Exit2(`error: parse ${raw[k]! + 1}`);
          }
          if (rl === '' || rl[0] === ' ') {
            const text = rl === '' ? '' : rl.slice(1);
            cur.o.push(text);
            cur.n.push({ text, ctx: true, oIdx: cur.o.length - 1 });
          } else if (rl[0] === '-') {
            cur.o.push(rl.slice(1));
          } else {
            cur.n.push({ text: rl.slice(1), ctx: false, oIdx: -1 });
          }
          continue;
        }
        throw new Exit2(`error: parse ${raw[k]! + 1}`);
      }
      closeChunk();
      if (chunks.length === 0 && newPath === null) throw new Exit2(`error: parse ${startLine + 1}`);
      sections.push({ kind, path, newPath, addLines: [], chunks });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4A(lines);
  return sections.map((sec) => {
    return (tree: Tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (sec.kind === 'add') {
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
        return;
      }
      if (sec.kind === 'delete') {
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
        return;
      }
      const before = tree.get(sec.path);
      if (before === null) throw new Fail('missing', sec.path);
      if (sec.newPath !== null) {
        if (!safe(sec.newPath)) throw new Fail('unsafe', sec.newPath);
        if (tree.get(sec.newPath) !== null) throw new Fail('exists', sec.newPath);
      }
      const parts = fileParts(before);
      let fileLines = parts.lines;
      let cursor = 0;
      for (const chunk of sec.chunks) {
        if (chunk.anchor !== null) {
          const found = findTier(fileLines, [chunk.anchor], strict, cursor);
          if (found === null) throw new Fail('no-match', sec.path);
          cursor = found.occ[0]! + 1;
        }
        if (chunk.o.length > 0) {
          if (chunk.eof) {
            const pos = fileLines.length - chunk.o.length;
            if (pos < cursor) throw new Fail('no-match', sec.path);
            const max = strict ? 0 : 2;
            let tier = -1;
            for (let t = 0; t <= max; t++) {
              if (occurrences(fileLines, chunk.o, t, pos).includes(pos)) {
                tier = t;
                break;
              }
            }
            if (tier < 0) throw new Fail('no-match', sec.path);
            const rep = buildReplacement(fileLines, pos, chunk.o, chunk.n, tier);
            fileLines = spliceLines(fileLines, pos, chunk.o.length, rep);
            cursor = pos + rep.length;
          } else {
            const found = findTier(fileLines, chunk.o, strict, cursor);
            if (found === null) throw new Fail('no-match', sec.path);
            const pos = found.occ[0]!;
            const rep = buildReplacement(fileLines, pos, chunk.o, chunk.n, found.tier);
            fileLines = spliceLines(fileLines, pos, chunk.o.length, rep);
            cursor = pos + rep.length;
          }
        } else {
          const idx = chunk.eof ? fileLines.length : cursor;
          const rep = chunk.n.map((x) => x.text);
          fileLines = spliceLines(fileLines, idx, 0, rep);
          cursor = idx + rep.length;
        }
      }
      const out = renderFile(fileLines, parts.br, parts.finalBreak);
      if (sec.newPath !== null) {
        tree.now.set(sec.path, null);
        tree.now.set(sec.newPath, out);
        tree.moves.push([sec.path, sec.newPath]);
      } else {
        tree.now.set(sec.path, out);
      }
    };
  });
}

/* ---------------- JSON edits (SPEC.md section 9) ---------------- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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

/* ---------------- running the patch (SPEC.md sections 1, 2 and 10) ---------------- */

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
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
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, { was, now });
  }
  const suppressed = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    const oc = changed.get(oldP);
    const nc = changed.get(newP);
    if (oc !== undefined && oc.was !== null && oc.now === null && nc !== undefined && nc.was === null && nc.now !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  for (const [p, c] of changed) {
    if (suppressed.has(p)) continue;
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
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
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
