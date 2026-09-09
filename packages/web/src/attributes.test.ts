import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, parseAttributes } from './attributes.ts';

/** Stand-in for `element.getAttribute`. */
function reader(attrs: Record<string, string>): (name: string) => string | null {
  return (name) => attrs[name] ?? null;
}

const withProject = (extra: Record<string, string> = {}): Record<string, string> => ({
  project: 'pk_live_1',
  ...extra,
});

describe('defaults', () => {
  test('an element with only a project key gets every default', () => {
    const { config, warnings } = parseAttributes(reader(withProject()));
    assert.deepEqual(warnings, []);
    assert.deepEqual(config, { project: 'pk_live_1', ...DEFAULTS });
  });

  test('the default flow asks what the user would change, not what is broken', () => {
    // ADR-0012: this is a prioritization product, not a bug tracker.
    assert.equal(DEFAULTS.kind, 'feature_request');
  });

  test('replay is off and frustration only detects', () => {
    // A session recorder that turns itself on is a privacy incident waiting to
    // happen, and nudging is the customer's decision to make (ADR-0007, 0010).
    assert.equal(DEFAULTS.replay, false);
    assert.equal(DEFAULTS.frustration, 'detect');
  });
});

describe('validation never throws', () => {
  test('an unknown preset falls back and warns', () => {
    const { config, warnings } = parseAttributes(reader(withProject({ preset: 'neon' })));
    assert.equal(config.preset, 'soft');
    assert.match(warnings[0] ?? '', /preset="neon"/);
  });

  test('an unknown position falls back', () => {
    assert.equal(parseAttributes(reader(withProject({ position: 'middle' }))).config.position, 'bottom-right');
  });

  test('an unknown kind falls back', () => {
    assert.equal(parseAttributes(reader(withProject({ kind: 'complaint' }))).config.kind, 'feature_request');
  });

  test('enum values are case-insensitive', () => {
    assert.equal(parseAttributes(reader(withProject({ preset: 'SHARP' }))).config.preset, 'sharp');
  });

  test('a missing project is reported rather than thrown', () => {
    // A third-party script tag on someone's checkout flow does not get to
    // throw. It renders nothing and says why.
    const { config, warnings } = parseAttributes(reader({}));
    assert.equal(config.project, '');
    assert.match(warnings.join(' '), /project is required/);
  });

  test('garbage in every field still yields a usable config', () => {
    const { config } = parseAttributes(
      reader({ project: 'p', kind: '?', preset: '?', position: '?', offset: 'abc', picker: '?', replay: '?', frustration: '?' }),
    );
    assert.deepEqual(config, { project: 'p', ...DEFAULTS });
  });
});

describe('offset', () => {
  test('a plain number is used', () => {
    assert.equal(parseAttributes(reader(withProject({ offset: '40' }))).config.offset, 40);
  });

  test('a px suffix is tolerated', () => {
    assert.equal(parseAttributes(reader(withProject({ offset: '40px' }))).config.offset, 40);
  });

  test('out of range is clamped, not rejected', () => {
    // An off-screen nub is worse than a moved one.
    assert.equal(parseAttributes(reader(withProject({ offset: '-10' }))).config.offset, 0);
    assert.equal(parseAttributes(reader(withProject({ offset: '9999' }))).config.offset, 200);
  });

  test('clamping is reported', () => {
    assert.match(parseAttributes(reader(withProject({ offset: '9999' }))).warnings.join(' '), /clamped/);
  });

  test('a fractional offset is rounded', () => {
    assert.equal(parseAttributes(reader(withProject({ offset: '12.6' }))).config.offset, 13);
  });
});

describe('booleans are on/off, not presence', () => {
  test('off disables', () => {
    // HTML's presence-means-true would make picker="off" mean enabled, which
    // reads as a bug to everyone who writes it.
    assert.equal(parseAttributes(reader(withProject({ picker: 'off' }))).config.picker, false);
    assert.equal(parseAttributes(reader(withProject({ replay: 'false' }))).config.replay, false);
  });

  test('on enables', () => {
    assert.equal(parseAttributes(reader(withProject({ replay: 'on' }))).config.replay, true);
    assert.equal(parseAttributes(reader(withProject({ replay: 'true' }))).config.replay, true);
  });

  test('a bare attribute means true', () => {
    assert.equal(parseAttributes(reader(withProject({ replay: '' }))).config.replay, true);
  });

  test('an unrecognised value keeps the default and warns', () => {
    const { config, warnings } = parseAttributes(reader(withProject({ replay: 'maybe' })));
    assert.equal(config.replay, false);
    assert.match(warnings.join(' '), /replay="maybe"/);
  });
});

describe('shortcut', () => {
  test('the default chord applies when absent', () => {
    assert.equal(parseAttributes(reader(withProject())).config.shortcut, 'mod+shift+k');
  });

  test('off and none disable it', () => {
    for (const value of ['off', 'none', '']) {
      assert.equal(parseAttributes(reader(withProject({ shortcut: value }))).config.shortcut, null);
    }
  });

  test('a custom chord is lowercased and passed through', () => {
    assert.equal(parseAttributes(reader(withProject({ shortcut: 'Ctrl+/' }))).config.shortcut, 'ctrl+/');
  });
});

describe('text fields', () => {
  test('label and locale are trimmed', () => {
    const { config } = parseAttributes(reader(withProject({ label: '  Tell us  ', locale: ' fr ' })));
    assert.equal(config.label, 'Tell us');
    assert.equal(config.locale, 'fr');
  });

  test('an empty label falls back rather than rendering a blank button', () => {
    assert.equal(parseAttributes(reader(withProject({ label: '   ' }))).config.label, 'Feedback');
  });
});

describe('endpoint', () => {
  test('defaults to same-origin', () => {
    // The self-host default, and the only one that needs no CORS setup.
    assert.equal(parseAttributes(reader(withProject({}))).config.endpoint, '');
  });

  test('accepts an absolute origin and drops the trailing slash', () => {
    const { config, warnings } = parseAttributes(
      reader(withProject({ endpoint: 'https://ingest.example.com/' })),
    );
    assert.equal(config.endpoint, 'https://ingest.example.com');
    assert.deepEqual(warnings, []);
  });

  test('accepts http, for a self-hosted service on a private network', () => {
    assert.equal(
      parseAttributes(reader(withProject({ endpoint: 'http://quorum.internal:8787' }))).config.endpoint,
      'http://quorum.internal:8787',
    );
  });

  test('rejects a relative value and warns', () => {
    // `api/` would resolve against whatever path the page is on, so the same
    // tag would post somewhere different from /settings than from / — a bug
    // that presents as an intermittent outage.
    const { config, warnings } = parseAttributes(reader(withProject({ endpoint: 'api/' })));
    assert.equal(config.endpoint, '');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] as string, /absolute http\(s\) origin/);
  });

  test('rejects a scheme that is not http(s)', () => {
    for (const bad of ['ftp://x.example.com', 'javascript:alert(1)', '//example.com']) {
      const { config } = parseAttributes(reader(withProject({ endpoint: bad })));
      assert.equal(config.endpoint, '', `${bad} was accepted`);
    }
  });

  test('an empty endpoint is same-origin, not a warning', () => {
    const { config, warnings } = parseAttributes(reader(withProject({ endpoint: '  ' })));
    assert.equal(config.endpoint, '');
    assert.deepEqual(warnings, []);
  });
});

describe('version', () => {
  test('is absent by default', () => {
    assert.equal(parseAttributes(reader(withProject({}))).config.appVersion, '');
  });

  test('is trimmed and passed through verbatim', () => {
    // Not parsed or validated: it is an opaque grouping key, and rejecting a
    // scheme we did not anticipate would drop the structural signal entirely.
    assert.equal(
      parseAttributes(reader(withProject({ version: ' 4.12.0-rc.1 ' }))).config.appVersion,
      '4.12.0-rc.1',
    );
  });
});
