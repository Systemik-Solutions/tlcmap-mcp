import { ProtocolError, type CallToolResult } from '@modelcontextprotocol/server';

export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UPSTREAM_CONTRACT_VIOLATION'
  | 'LAYER_PRIVATE'
  | 'LAYER_NOT_FOUND'
  | 'INVALID_PARAMETER'
  | 'INVALID_GEOMETRY'
  | 'FILTER_REJECTED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'RESPONSE_TOO_LARGE'
  | 'SERVER_BUSY'
  | 'RESOURCE_EXPIRED';

const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export class TlcmapError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'TlcmapError';
  }
}

/**
 * The text block is the serialised `structuredContent`, as for a success: clients such as Claude
 * Code pass the agent only the text block of an error, and `details` must reach it.
 */
export function toToolErrorResult(e: TlcmapError): CallToolResult {
  const structuredContent = { error: { code: e.code, message: e.message, details: e.details } };
  return {
    isError: true,
    structuredContent,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
  };
}

export function toProtocolError(e: TlcmapError): ProtocolError {
  return new ProtocolError(
    e.code === 'INVALID_ARGUMENT' ? INVALID_PARAMS : INTERNAL_ERROR,
    `${e.code}: ${e.message}`,
    { code: e.code, message: e.message, details: e.details },
  );
}
