export type ParamValue =
  | string
  | number
  | boolean
  | readonly number[]
  | readonly string[]
  | readonly (readonly [number, number])[];
export type Params = Record<string, ParamValue | undefined>;

export const PARAM_ORDER = {
  places: [
    'name', 'match', 'sources', 'layers', 'bbox', 'polygon', 'date_from', 'date_to',
    'include_undated', 'state', 'lga', 'feature_term', 'record_type', 'extended_data',
    'summary_only', 'sort', 'direction', 'nulls', 'limit', 'sample', 'seed', 'cursor', 'per_page',
  ],
  layers: [
    'q', 'bbox', 'polygon', 'date_from', 'date_to', 'include_undated', 'record_type', 'creator',
    'has_license', 'has_warning', 'min_records', 'sort', 'direction', 'cursor', 'per_page',
  ],
  layer_features: ['sort', 'direction', 'nulls', 'limit', 'cursor', 'per_page'],
} as const satisfies Record<string, readonly string[]>;

/** Plain decimal text for a finite number, never exponent notation. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`Cannot format ${String(n)} as a decimal`);
  const s = String(n);
  const e = s.indexOf('e');
  if (e === -1) return s === '-0' ? '0' : s;
  const negative = s.startsWith('-');
  const mantissa = s.slice(negative ? 1 : 0, e);
  const exponent = Number(s.slice(e + 1));
  const point = mantissa.indexOf('.');
  const digits = mantissa.replace('.', '');
  const intLen = (point === -1 ? mantissa.length : point) + exponent;
  let out: string;
  if (intLen <= 0) out = `0.${'0'.repeat(-intLen)}${digits}`;
  else if (intLen >= digits.length) out = digits + '0'.repeat(intLen - digits.length);
  else out = `${digits.slice(0, intLen)}.${digits.slice(intLen)}`;
  return negative ? `-${out}` : out;
}

function encode(text: string): string {
  return encodeURIComponent(text).replaceAll('%2C', ',');
}

function valueText(value: ParamValue): string {
  if (typeof value === 'string') return encode(value);
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return (value as readonly (string | number | readonly [number, number])[])
    .map((item) => {
      if (typeof item === 'string') return encode(item);
      if (typeof item === 'number') return formatNumber(item);
      return `${formatNumber(item[0])}%20${formatNumber(item[1])}`;
    })
    .join(',');
}

function build(base: URL, path: string, order: readonly string[], params: Params): URL {
  for (const key of Object.keys(params)) {
    if (!order.includes(key)) throw new Error(`Unknown v2 parameter for ${path}: ${key}`);
  }
  const pairs: string[] = [];
  for (const key of order) {
    const value = params[key];
    if (value !== undefined) pairs.push(`${key}=${valueText(value)}`);
  }
  const root = `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
  return new URL(`${root}${path}${pairs.length > 0 ? `?${pairs.join('&')}` : ''}`);
}

export function placesUrl(base: URL, params: Params): URL {
  return build(base, '/api/v2/places', PARAM_ORDER.places, params);
}

export function layersUrl(base: URL, params: Params): URL {
  return build(base, '/api/v2/layers', PARAM_ORDER.layers, params);
}

export function layerUrl(base: URL, layerId: number): URL {
  return build(base, `/api/v2/layers/${layerId}`, [], {});
}

export function layerFeaturesUrl(base: URL, layerId: number, params: Params): URL {
  return build(base, `/api/v2/layers/${layerId}/features`, PARAM_ORDER.layer_features, params);
}
