import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadCorpus, truthLabels } from './corpus.ts';
import { groupSubmissionIds, toDocs, toRankableClusters, toRankMember } from './adapt.ts';

const corpus = loadCorpus();

describe('toDocs', () => {
  test('maps body to text and carries structural context', () => {
    const docs = toDocs(corpus.submissions);
    assert.equal(docs.length, corpus.submissions.length);
    const first = docs[0];
    const source = corpus.submissions[0];
    assert.equal(first?.id, source?.id);
    assert.equal(first?.text, source?.body, 'clusterers read .text, not .body');
    assert.equal(first?.route, source?.route);
    assert.equal(first?.appVersion, source?.appVersion);
    assert.equal(first?.platform, source?.platform);
  });

  test('preserves order, which every index-aligned metric depends on', () => {
    const docs = toDocs(corpus.submissions);
    for (let i = 0; i < corpus.submissions.length; i++) {
      assert.equal(docs[i]?.id, corpus.submissions[i]?.id);
    }
  });

  test('handles an empty input', () => {
    assert.deepEqual(toDocs([]), []);
  });
});

describe('toRankMember', () => {
  test('carries the fields ranking depends on', () => {
    const s = corpus.submissions[0]!;
    const m = toRankMember(s);
    assert.equal(m.userId, s.userId);
    assert.equal(m.kind, s.kind);
    assert.equal(m.clientTs, s.clientTs, 'must be client time, not receipt time');
  });
});

describe('toRankableClusters', () => {
  test('groups members by label without losing any', () => {
    const clusters = toRankableClusters(corpus.submissions, truthLabels(corpus));
    const total = clusters.reduce((sum, c) => sum + c.members.length, 0);
    assert.equal(total, corpus.submissions.length);
  });

  test('produces one cluster per distinct label', () => {
    const labels = truthLabels(corpus);
    const clusters = toRankableClusters(corpus.submissions, labels);
    assert.equal(clusters.length, new Set(labels).size);
  });

  test('a known cluster gets exactly its members', () => {
    const clusters = toRankableClusters(corpus.submissions, truthLabels(corpus));
    const dark = clusters.find((c) => c.id === 'dark-mode');
    const expected = corpus.submissions.filter((s) => s.cluster === 'dark-mode').length;
    assert.equal(dark?.members.length, expected);
  });

  test('handles an empty input', () => {
    assert.deepEqual(toRankableClusters([], []), []);
  });
});

describe('groupSubmissionIds', () => {
  test('maps each label to its member ids in order', () => {
    const groups = groupSubmissionIds(corpus.submissions, truthLabels(corpus));
    const dark = groups.get('dark-mode') ?? [];
    assert.equal(dark[0], 's001', 'arrival order preserved for medoid selection');
    assert.ok(dark.includes('s010'));
  });

  test('every submission appears exactly once', () => {
    const groups = groupSubmissionIds(corpus.submissions, truthLabels(corpus));
    const seen = new Set<string>();
    let total = 0;
    for (const ids of groups.values()) {
      for (const id of ids) {
        assert.ok(!seen.has(id), `${id} appeared twice`);
        seen.add(id);
        total++;
      }
    }
    assert.equal(total, corpus.submissions.length);
  });

  test('handles an empty input', () => {
    assert.equal(groupSubmissionIds([], []).size, 0);
  });
});
