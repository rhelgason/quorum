import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dedupKey, derivedId, resolveUserId, scrubVariableData } from './submission.ts';

describe('identity resolution', () => {
  test('an external id wins over an anon id', () => {
    // A user who files anonymously and later logs in is one user. Preferring
    // anonId would count them twice and inflate the cluster they filed into.
    const resolved = resolveUserId({ externalId: 'u_1', anonId: 'qa_9' }, 'fallback');
    assert.equal(resolved.userId, 'u:u_1');
    assert.equal(resolved.attributed, true);
  });

  test('an anon id is used when there is no external id', () => {
    const resolved = resolveUserId({ anonId: 'qa_9' }, 'fallback');
    assert.equal(resolved.userId, 'a:qa_9');
    assert.equal(resolved.attributed, true);
  });

  test('external and anon ids live in separate namespaces', () => {
    // Without the prefixes, an anonId that happens to equal someone's
    // externalId silently merges two different people.
    assert.notEqual(
      resolveUserId({ externalId: 'x' }, 'f').userId,
      resolveUserId({ anonId: 'x' }, 'f').userId,
    );
  });

  test('empty-string ids are treated as absent, not as an identity', () => {
    // A CSV export writes a missing customer id as "". Accepting it would put
    // every unattributed row in the same bucket under the name of one user.
    const resolved = resolveUserId({ externalId: '', anonId: '' }, 'fallback');
    assert.equal(resolved.userId, 'fallback');
    assert.equal(resolved.attributed, false);
  });

  test('the fallback is marked unattributed', () => {
    assert.equal(resolveUserId(undefined, 'bucket').attributed, false);
  });

  test('an empty fallback throws rather than inventing an identity', () => {
    // The failure this prevents is silent: a random id per submission turns
    // unique-user counting into submission counting with nothing to notice.
    assert.throws(() => resolveUserId(undefined, ''), /fallback identity key/);
  });
});

describe('mrr from traits', () => {
  test('a numeric trait is read directly', () => {
    assert.equal(resolveUserId({ externalId: 'u', traits: { mrr: 240 } }, 'f').mrr, 240);
  });

  test('string forms from a CSV export are parsed', () => {
    assert.equal(resolveUserId({ externalId: 'u', traits: { mrr: '$4,000' } }, 'f').mrr, 4000);
  });

  test('unparseable mrr is dropped, never coerced to zero', () => {
    // Unknown value and zero value are different claims. accountWeight already
    // treats absent as 1.0; asserting 0 would say something we do not know.
    for (const bad of ['', 'n/a', '-50', 0, -1, Number.NaN, true, null]) {
      const resolved = resolveUserId({ externalId: 'u', traits: { mrr: bad } }, 'f');
      assert.equal(resolved.mrr, undefined, `expected undefined for ${JSON.stringify(bad)}`);
    }
  });

  test('absent traits produce no mrr key at all', () => {
    // exactOptionalPropertyTypes: an explicit `mrr: undefined` is not the same
    // as an absent key, and the store round-trips these objects.
    assert.equal('mrr' in resolveUserId({ externalId: 'u' }, 'f'), false);
  });
});

describe('scrubbing variable data', () => {
  test('two occurrences of one defect collapse to the same text', () => {
    // The whole point: without this, every occurrence is a singleton cluster
    // and a crash affecting thousands never reaches the ranked list.
    const a = scrubVariableData('Timeout after 30012ms fetching order A-4471');
    const b = scrubVariableData('Timeout after 28004ms fetching order B-9982');
    assert.equal(a, b);
  });

  test('uuids, hashes, timestamps, and hex are replaced by shape', () => {
    assert.match(scrubVariableData('user 3f2504e0-4f89-11d3-9a0c-0305e82c3301'), /<uuid>/);
    assert.match(scrubVariableData('sha 0123456789abcdef0123'), /<hash>/);
    assert.match(scrubVariableData('at 2026-09-03T10:00:00.000Z'), /<ts>/);
    assert.match(scrubVariableData('addr 0xdeadbeef'), /<hex>/);
  });

  test('a uuid is not shredded into <num> fragments', () => {
    // Ordering regression: bare-number replacement running first would eat the
    // digits inside a uuid and destroy the shape that makes it recognizable.
    assert.equal(scrubVariableData('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), '<uuid>');
  });

  test('ordinary prose is left alone', () => {
    // Human feedback must survive untouched — this function is only applied to
    // machine-generated clusterText, and over-scrubbing would erase real words.
    const prose = 'please add dark mode, the app hurts my eyes at night';
    assert.equal(scrubVariableData(prose), prose);
  });

  test('a bare number is still replaced', () => {
    assert.equal(scrubVariableData('retried 5 times'), 'retried <num> times');
  });
});

describe('derived ids', () => {
  test('the same content produces the same id', () => {
    // Re-running an import must collide with the first run rather than
    // inserting a parallel copy of every ticket.
    assert.equal(derivedId(['p', 'import', 'u:1', 't', 'body']), derivedId(['p', 'import', 'u:1', 't', 'body']));
  });

  test('every component changes the id', () => {
    const base = ['p', 'import', 'u:1', '2026-01-01', 'body'];
    const seen = new Set([derivedId(base)]);
    for (let i = 0; i < base.length; i++) {
      const variant = [...base];
      variant[i] = 'different';
      seen.add(derivedId(variant));
    }
    assert.equal(seen.size, base.length + 1);
  });

  test('the same user saying the same thing months apart is two records', () => {
    // Re-filing should make someone more recent, never louder — but it is
    // still a second piece of feedback and must not be swallowed as a dup.
    assert.notEqual(
      derivedId(['p', 's', 'u:1', '2026-01-01T00:00:00Z', 'add dark mode']),
      derivedId(['p', 's', 'u:1', '2026-06-01T00:00:00Z', 'add dark mode']),
    );
  });

  test('component boundaries are not ambiguous', () => {
    // Naive concatenation makes ['ab','c'] and ['a','bc'] the same string, so
    // two different records could collide into one id.
    assert.notEqual(derivedId(['ab', 'c']), derivedId(['a', 'bc']));
  });

  test('ids are prefixed so a derived id is recognizable', () => {
    assert.match(derivedId(['x']), /^im_/);
  });

  test('distinct inputs do not collide at corpus scale', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) ids.add(derivedId(['p', 'import', `u:${i}`, '2026-01-01', `body ${i}`]));
    assert.equal(ids.size, 5000);
  });
});

describe('dedup key', () => {
  test('casing and punctuation do not make a new piece of feedback', () => {
    assert.equal(dedupKey('Add Dark Mode please!!'), dedupKey('add dark mode please'));
  });
});
