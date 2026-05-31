import fs from 'fs-extra';
import YAML from 'yaml';

export async function readYaml<T>(file: string): Promise<T> {
  return YAML.parse(await fs.readFile(file, 'utf8')) as T;
}

export async function writeYaml(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, YAML.stringify(value));
}
