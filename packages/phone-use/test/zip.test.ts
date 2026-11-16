import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { crc32, zipAppend, zipWriteSync } from '../src/zip.ts';

// Round-trip proof for the stored-only zip writer (docs/20 item 6): a REAL
// independent reader (python3's zipfile) must accept the archive, see every
// name (UTF-8 included), and read back byte-identical content. testzip()
// re-checks every entry's CRC-32, so binary payloads are covered too.

const execFileAsync = promisify(execFile);

const PY_READ = `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
print(json.dumps({
    "bad": z.testzip(),
    "names": names,
    "contents": {n: z.read(n).decode("utf-8") for n in names if n.endswith((".json", ".jsonl"))},
}))
`;

async function pyReadZip(
  path: string,
): Promise<{ bad: string | null; names: string[]; contents: Record<string, string> }> {
  const { stdout } = await execFileAsync('python3', ['-c', PY_READ, path]);
  return JSON.parse(stdout);
}

const tmp = () => mkdtempSync(join(tmpdir(), 'phone-use-zip-'));

describe('crc32', () => {
  it('matches the reference value for the standard test vector', () => {
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe('zipWriteSync round-trip via python3 zipfile', () => {
  it('produces an archive python3 validates, with UTF-8 names and byte-equal content', async () => {
    const path = join(tmp(), 'trace.zip');
    const unicodeName = 'trees/00042 — ünïcode.json';
    const unicodeBody = '{"läbel":"Wi‑Fi ✓"}';
    const jsonl = '{"ts":"T1","tool":"tap","ok":true}\n{"ts":"T2","tool":"observe","ok":true}\n';
    const binary = new Uint8Array(256).map((_, i) => i);

    zipWriteSync(path, [
      { name: 'trace.jsonl', data: jsonl },
      { name: unicodeName, data: unicodeBody },
      { name: 'frames/000000.jpeg', data: binary },
    ]);

    const z = await pyReadZip(path);
    expect(z.bad).toBeNull(); // testzip(): every CRC checks out
    expect(z.names).toEqual(['trace.jsonl', unicodeName, 'frames/000000.jpeg']);
    expect(z.contents['trace.jsonl']).toBe(jsonl);
    expect(z.contents[unicodeName]).toBe(unicodeBody);
  });

  it('accepts an explicit mtime and an empty entry', async () => {
    const path = join(tmp(), 'empty.zip');
    zipWriteSync(path, [{ name: 'trace.jsonl', data: '', mtimeMs: Date.UTC(2026, 6, 23, 12, 0, 0) }]);
    const z = await pyReadZip(path);
    expect(z.bad).toBeNull();
    expect(z.names).toEqual(['trace.jsonl']);
    expect(z.contents['trace.jsonl']).toBe('');
  });
});

describe('zipAppend', () => {
  it('keeps prior entries intact and python3 sees old + new', async () => {
    const path = join(tmp(), 'append.zip');
    const jsonl = '{"ts":"T1","decision":"deny"}\n';
    const tree = '{"nodes":[]}';
    zipWriteSync(path, [
      { name: 'trace.jsonl', data: jsonl },
      { name: 'trees/000001.json', data: tree },
    ]);

    const verdict = '{"source":"bench","task":"nl-toggle","ok":false}';
    zipAppend(path, [{ name: 'verdict.json', data: verdict }]);

    const z = await pyReadZip(path);
    expect(z.bad).toBeNull();
    expect(z.names).toEqual(['trace.jsonl', 'trees/000001.json', 'verdict.json']);
    expect(z.contents['trace.jsonl']).toBe(jsonl);
    expect(z.contents['trees/000001.json']).toBe(tree);
    expect(z.contents['verdict.json']).toBe(verdict);
  });

  it('throws on a file with no EOCD instead of corrupting it', () => {
    const path = join(tmp(), 'not-a.zip');
    writeFileSync(path, 'plain text, definitely not a zip');
    expect(() => zipAppend(path, [{ name: 'x.json', data: '{}' }])).toThrow(/end-of-central-directory/);
  });
});
