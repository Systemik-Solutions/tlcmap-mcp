import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
};

export const SERVER_NAME: string = pkg.name;
export const SERVER_VERSION: string = pkg.version;
export const SERVER_ID: string = `${SERVER_NAME} ${SERVER_VERSION}`;
