export type NamedItem = {name: string};

export function findByName<T extends NamedItem>(items: readonly T[], name: string): T | undefined {
  return items.find(item => item.name === name);
}

export function removeByName<T extends NamedItem>(items: readonly T[], name: string): T[] {
  return items.filter(item => item.name !== name);
}

export function upsertByName<T extends NamedItem>(items: readonly T[], item: T): T[] {
  return [...removeByName(items, item.name), item];
}
