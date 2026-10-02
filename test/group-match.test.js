import test from 'node:test';
import assert from 'node:assert/strict';
import { matchGroups } from '../group-match.js';

const group = {
  id: 'g1',
  name: 'Florest',
  color: '#26f50a',
  telegramThreadId: 1800,
  accounts: ['embrapa', '@ecouniversidade'],
  keywords: ['Agricultura Familiar'],
  hashtags: ['#pronaf'],
};

test('matchGroups reports each matching criterion type once, in the stored shape', () => {
  const [match, ...rest] = matchGroups(
    { author: 'embrapa', caption: 'Linhas de AGRICULTURA FAMILIAR e #Pronaf' },
    [group],
  );
  assert.equal(rest.length, 0);
  assert.deepEqual(match, {
    id: 'g1',
    name: 'Florest',
    color: '#26f50a',
    telegramThreadId: 1800,
    reasons: ['account @embrapa', 'keyword "Agricultura Familiar"', 'hashtag #pronaf'],
  });
});

test('matchGroups ignores a leading @ on stored accounts', () => {
  const [match] = matchGroups({ author: 'ecouniversidade', caption: '' }, [group]);
  assert.deepEqual(match.reasons, ['account @ecouniversidade']);
});

test('matchGroups does not match everything on an empty or bare-@ account', () => {
  assert.deepEqual(matchGroups({ author: 'anyone', caption: 'x' }, [{ ...group, accounts: ['@'], keywords: [], hashtags: [] }]), []);
});

test('matchGroups returns nothing for unrelated posts and tolerates missing fields', () => {
  assert.deepEqual(matchGroups({ author: 'someone', caption: 'nothing here' }, [group]), []);
  assert.deepEqual(matchGroups({}, [{ id: 'g2', name: 'Empty' }]), []);
});
