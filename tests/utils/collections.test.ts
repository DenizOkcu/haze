import {describe, expect, it} from 'vitest';
import {findByName, removeByName, upsertByName} from '../../src/utils/collections.js';

describe('collection helpers', () => {
  const items = [{name: 'a', value: 1}, {name: 'b', value: 2}];

  it('finds items by name', () => {
    expect(findByName(items, 'b')).toEqual({name: 'b', value: 2});
    expect(findByName(items, 'missing')).toBeUndefined();
  });

  it('removes items by name without mutating input', () => {
    expect(removeByName(items, 'a')).toEqual([{name: 'b', value: 2}]);
    expect(items).toEqual([{name: 'a', value: 1}, {name: 'b', value: 2}]);
  });

  it('upserts by replacing existing names or appending new ones', () => {
    expect(upsertByName(items, {name: 'a', value: 3})).toEqual([{name: 'b', value: 2}, {name: 'a', value: 3}]);
    expect(upsertByName(items, {name: 'c', value: 4})).toEqual([...items, {name: 'c', value: 4}]);
  });
});
