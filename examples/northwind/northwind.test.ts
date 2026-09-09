/**
 * The Northwind corpus and the figures built from it.
 *
 * Two things are being protected. The corpus must be **reproducible**, because
 * the README quotes numbers computed from it and a corpus that drifted between
 * runs would make every one of them unfalsifiable. And the figures must fit
 * inside their own canvas — a check that sounds trivial and caught three real
 * layout bugs the first time it ran, including rows drawn below the bottom
 * edge of the chart.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { parseCsvRecords } from '../../packages/node/src/csv.ts';
import { buildAccounts, generate, toCsv, versionOn, WINDOW_DAYS } from './generate.ts';
import { TOPICS } from './topics.ts';

const here = dirname(fileURLToPath(import.meta.url));
const imgDir = resolve(here, '../../docs/img');

describe('the generator', () => {
  it('is deterministic', () => {
    // The README quotes figures computed from this file. A corpus that drifted
    // between runs would make all of them unfalsifiable.
    assert.equal(toCsv(generate(42)), toCsv(generate(42)));
  });

  it('changes with the seed', () => {
    assert.notEqual(toCsv(generate(1)), toCsv(generate(2)));
  });

  it('produces a few hundred rows across every topic', () => {
    const rows = generate();
    assert.ok(rows.length > 350, `only ${String(rows.length)} rows`);
    assert.equal(new Set(rows.map((r) => r.topic)).size, TOPICS.length);
  });

  it('numbers tickets in chronological order', () => {
    const rows = generate();
    for (let i = 1; i < rows.length; i++) {
      assert.ok(
        (rows[i - 1] as { created_at: string }).created_at <= (rows[i] as { created_at: string }).created_at,
        'rows are out of order',
      );
    }
    assert.equal(rows[0]?.ticket_id, 'NW-10000');
  });

  it('keeps every row inside the window', () => {
    const endsAt = new Date('2026-09-09T12:00:00Z');
    const start = endsAt.getTime() - WINDOW_DAYS * 86_400_000;
    for (const row of generate(20260909, endsAt)) {
      const at = Date.parse(row.created_at);
      assert.ok(at >= start && at <= endsAt.getTime(), `${row.created_at} is outside the window`);
    }
  });

  it('reports a regression only after the release that caused it', () => {
    const rows = generate();
    const broken = TOPICS.find((t) => t.shape === 'regression' && t.brokenIn !== undefined);
    assert.ok(broken !== undefined);

    const reports = rows.filter((r) => r.topic === broken.id);
    assert.ok(reports.length > 5);
    // The whole point of the shape. If reports predated the release, the
    // figure claiming the two coincide would be decoration.
    for (const report of reports) {
      assert.ok(
        report.app_version >= (broken.brokenIn as string),
        `${broken.id} reported on ${report.app_version}, before ${String(broken.brokenIn)}`,
      );
    }
  });

  it('escapes text that would break the CSV', () => {
    const csv = toCsv([
      {
        ticket_id: 'NW-1', requester_id: 'c1', created_at: '2026-01-01T00:00:00.000Z',
        description: 'he said "it, broke"\nand left', mrr: '0', type: 'bug',
        page: '/x', app_version: '1.0.0', source: 'nub', topic: 't',
      },
    ]);
    const parsed = parseCsvRecords(csv);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.['description'], 'he said "it, broke"\nand left');
  });
});

describe('the account distribution', () => {
  const accounts = buildAccounts(
    (() => {
      let a = 7;
      return () => {
        a = (a * 1103515245 + 12345) % 2147483648;
        return a / 2147483648;
      };
    })(),
    500,
  );

  it('is a power law, not a uniform spread', () => {
    const free = accounts.filter((a) => a.mrr === 0).length;
    const whales = accounts.filter((a) => a.mrr >= 3000).length;

    // Uniform revenue would make log-scaled weighting indistinguishable from
    // no weighting, and demonstrating that difference is half of what this
    // corpus exists for.
    assert.ok(free / accounts.length > 0.3, 'not enough free accounts');
    assert.ok(whales / accounts.length < 0.1, 'too many enterprises');
    assert.ok(whales > 0, 'no enterprises at all');
  });

  it('gives every account a distinct id', () => {
    assert.equal(new Set(accounts.map((a) => a.id)).size, accounts.length);
  });
});

describe('versionOn', () => {
  it('returns the release in effect', () => {
    assert.equal(versionOn(0), '4.10.0');
    assert.equal(versionOn(27), '4.10.0');
    assert.equal(versionOn(28), '4.11.0');
    assert.equal(versionOn(119), '4.13.0');
  });
});

describe('the committed corpus', () => {
  const csv = readFileSync(join(here, 'feedback.csv'), 'utf8');
  const records = parseCsvRecords(csv);

  it('matches what the generator produces', () => {
    // Committed so the demo needs no build step — and checked, so the file and
    // the generator cannot silently disagree.
    assert.equal(csv.trimEnd(), toCsv(generate()).trimEnd());
  });

  it('has no empty descriptions', () => {
    assert.ok(records.every((r) => (r['description'] ?? '').trim() !== ''));
  });

  it('has a unique id per row', () => {
    assert.equal(new Set(records.map((r) => r['ticket_id'])).size, records.length);
  });
});

describe('the figures', () => {
  const all = existsSync(imgDir) ? readdirSync(imgDir).filter((f) => f.endsWith('.svg')) : [];

  // Only the generated ones. `placeholder-*.svg` are hand-made stand-ins for
  // screenshots, deliberately single-file — they use neutral tones that read on
  // either GitHub theme, so a dark variant would be two files to maintain for
  // no gain.
  const svgs = all.filter((f) => f.startsWith('northwind-'));

  it('exist in both modes', () => {
    assert.ok(svgs.length >= 8, `only ${String(svgs.length)} figures — run npm run northwind`);
    for (const light of svgs.filter((f) => !f.includes('-dark'))) {
      assert.ok(svgs.includes(light.replace('.svg', '-dark.svg')), `${light} has no dark variant`);
    }
  });

  it('are actually different in dark mode', () => {
    for (const light of svgs.filter((f) => !f.includes('-dark'))) {
      const dark = light.replace('.svg', '-dark.svg');
      // Dark is a selected palette stepped for the dark surface, not an
      // inverted light one — but it must at least not be the same file.
      assert.notEqual(
        readFileSync(join(imgDir, light), 'utf8'),
        readFileSync(join(imgDir, dark), 'utf8'),
      );
    }
  });

  it('keep every mark inside the canvas', () => {
    for (const file of all) {
      const svg = readFileSync(join(imgDir, file), 'utf8');
      const [, w, h] = /width="(\d+)" height="(\d+)"/.exec(svg) ?? [];
      const width = Number(w);
      const height = Number(h);

      for (const match of svg.matchAll(/<(?:text|rect|circle|line)\s([^>]*)>/g)) {
        const attrs = match[1] as string;
        for (const [name, limit] of [
          ['x', width], ['x1', width], ['x2', width], ['cx', width],
          ['y', height], ['y1', height], ['y2', height], ['cy', height],
        ] as [string, number][]) {
          const found = new RegExp(`\\b${name}="(-?[\\d.]+)"`).exec(attrs);
          if (found === null) continue;
          const value = Number(found[1]);
          assert.ok(
            value >= -2 && value <= limit + 2,
            `${file}: ${name}=${String(value)} is outside 0..${String(limit)}`,
          );
        }
      }
    }
  });

  it('keep every label inside the canvas', () => {
    // Estimated at 0.58em average advance for the system sans. Approximate,
    // and it still caught a value label running 15px past the right edge and a
    // subtitle running 220px past it — neither visible from reading the code.
    for (const file of all) {
      const svg = readFileSync(join(imgDir, file), 'utf8');
      const width = Number((/width="(\d+)"/.exec(svg) ?? [])[1]);

      for (const match of svg.matchAll(
        /<text x="([\d.]+)"[^>]*font-size="([\d.]+)"[^>]*text-anchor="(\w+)"[^>]*>([^<]*)<\/text>/g,
      )) {
        const x = Number(match[1]);
        const size = Number(match[2]);
        const anchor = match[3] as string;
        const label = match[4] as string;

        const estimate = label.length * size * 0.58;
        const right = anchor === 'end' ? x : anchor === 'middle' ? x + estimate / 2 : x + estimate;
        assert.ok(right <= width + 2, `${file}: "${label.slice(0, 40)}" overflows by ${String(Math.round(right - width))}px`);
      }
    }
  });

  it('include a placeholder for every shot the README leaves open', () => {
    // Named in docs/img/README.md, referenced by the README. A missing one is a
    // broken image on the project's front page.
    for (const shot of ['hero', 'backlog', 'picker', 'nub']) {
      assert.ok(all.includes(`placeholder-${shot}.svg`), `placeholder-${shot}.svg is missing`);
    }
  });

  it('escape their text', () => {
    for (const file of all) {
      const svg = readFileSync(join(imgDir, file), 'utf8');
      assert.ok(!/&(?!amp;|lt;|gt;|quot;|#)/.test(svg), `${file} has an unescaped ampersand`);
    }
  });
});
