import { expect, test } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { SERVER_ID, SERVER_NAME, SERVER_VERSION } from '../../src/version.js';

test('server identity comes from package.json', () => {
  expect(SERVER_NAME).toBe('tlcmap-mcp');
  expect(SERVER_VERSION).toBe(pkg.version);
  expect(SERVER_ID).toBe(`tlcmap-mcp ${pkg.version}`);
});
