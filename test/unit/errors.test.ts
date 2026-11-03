import { ProtocolError } from '@modelcontextprotocol/server';
import { describe, expect, test } from 'vitest';
import { TlcmapError, toProtocolError, toToolErrorResult } from '../../src/errors.js';

describe('errors', () => {
  const e = new TlcmapError('LAYER_NOT_FOUND', 'No such layer', { layer_id: 7 });

  test('toToolErrorResult has the spec shape', () => {
    expect(toToolErrorResult(e)).toEqual({
      isError: true,
      structuredContent: {
        error: { code: 'LAYER_NOT_FOUND', message: 'No such layer', details: { layer_id: 7 } },
      },
      content: [{ type: 'text', text: 'LAYER_NOT_FOUND: No such layer' }],
    });
  });

  test('toProtocolError carries code, message and details in data', () => {
    const p = toProtocolError(e);
    expect(p).toBeInstanceOf(ProtocolError);
    expect(p.data).toEqual({ code: 'LAYER_NOT_FOUND', message: 'No such layer', details: { layer_id: 7 } });
    expect(p.message.startsWith('LAYER_NOT_FOUND')).toBe(true);
    expect(p.code).toBe(-32603);
  });

  test('INVALID_ARGUMENT maps to -32602', () => {
    expect(toProtocolError(new TlcmapError('INVALID_ARGUMENT', 'bad')).code).toBe(-32602);
  });

  test('details default to an empty object', () => {
    expect(new TlcmapError('SERVER_BUSY', 'busy').details).toEqual({});
  });
});
