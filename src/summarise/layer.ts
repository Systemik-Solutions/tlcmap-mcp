import { TlcmapError } from '../errors.js';

export type Extent = [minLon: number, minLat: number, maxLon: number, maxLat: number];
export interface DateBound {
  udate: number;
  as_written: string | null;
}
export interface LayerSummary {
  metadata: Record<string, unknown>;
  record_count: number;
  extent: Extent | null;
  date_range: { start: DateBound | null; end: DateBound | null } | null;
  undated_count: number;
  ungeolocated_count: number;
  record_uids: string[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function violation(expected: string, extra: Obj = {}): TlcmapError {
  return new TlcmapError(
    'UPSTREAM_CONTRACT_VIOLATION',
    `The layer feed from TLCMap did not have the expected shape: ${expected}.`,
    { expected, ...extra },
  );
}

/** Mutable running bounds, updated as positions are read. */
type Acc = { b: Bounds };
type Bounds = { minLon: number; minLat: number; maxLon: number; maxLat: number } | null;

function addPosition(pos: unknown, idx: number, acc: Acc): void {
  if (
    !Array.isArray(pos) ||
    pos.length < 2 ||
    typeof pos[0] !== 'number' ||
    typeof pos[1] !== 'number' ||
    !Number.isFinite(pos[0]) ||
    !Number.isFinite(pos[1])
  ) {
    throw violation('a position of at least two finite numbers [lon, lat]', { feature_index: idx });
  }
  const lon = pos[0];
  const lat = pos[1];
  const b = acc.b;
  if (b === null) acc.b = { minLon: lon, minLat: lat, maxLon: lon, maxLat: lat };
  else {
    if (lon < b.minLon) b.minLon = lon;
    if (lon > b.maxLon) b.maxLon = lon;
    if (lat < b.minLat) b.minLat = lat;
    if (lat > b.maxLat) b.maxLat = lat;
  }
}

/** Walk `coordinates` nested `depth` arrays deep (0 = a position). */
function walk(coords: unknown, depth: number, idx: number, acc: Acc): void {
  if (depth === 0) {
    addPosition(coords, idx, acc);
    return;
  }
  if (!Array.isArray(coords)) {
    throw violation('geometry coordinates as a nested array', { feature_index: idx });
  }
  for (const c of coords) walk(c, depth - 1, idx, acc);
}

const DEPTH: Record<string, number> = {
  Point: 0,
  MultiPoint: 1,
  LineString: 1,
  MultiLineString: 2,
  Polygon: 2,
  MultiPolygon: 3,
};

function addGeometry(g: unknown, idx: number, acc: Acc): void {
  if (!isObj(g) || typeof g.type !== 'string') {
    throw violation('a geometry object with a string type', { feature_index: idx });
  }
  if (g.type === 'GeometryCollection') {
    if (!Array.isArray(g.geometries)) {
      throw violation('a GeometryCollection with a geometries array', { feature_index: idx });
    }
    for (const sub of g.geometries) addGeometry(sub, idx, acc);
    return;
  }
  const depth = DEPTH[g.type];
  if (depth === undefined) {
    throw violation(`a known geometry type, got "${g.type}"`, { feature_index: idx });
  }
  walk(g.coordinates, depth, idx, acc);
}

function optionalUdate(p: Obj, key: string, idx: number): number | null {
  const v = p[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw violation(`${key} to be a finite number or absent`, { feature_index: idx });
  }
  return v;
}

function asWritten(p: Obj, key: string): string | null {
  const v = p[key];
  return typeof v === 'string' ? v : null;
}

export function summariseLayerFeed(body: Uint8Array): LayerSummary {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw violation('a UTF-8 JSON document');
  }
  if (!isObj(doc)) throw violation('a JSON object (a GeoJSON FeatureCollection)');
  const metadata = doc.metadata;
  if (!isObj(metadata)) throw violation('metadata to be an object');
  const features = doc.features;
  if (!Array.isArray(features)) {
    throw violation('features to be an array', { api_metadata: metadata });
  }

  const acc: Acc = { b: null };
  let start: DateBound | null = null;
  let end: DateBound | null = null;
  let undated = 0;
  let ungeolocated = 0;
  const uids: string[] = [];

  features.forEach((f: unknown, idx: number) => {
    if (!isObj(f)) throw violation('each feature to be an object', { feature_index: idx });
    const p = f.properties;
    if (!isObj(p)) throw violation('feature properties to be an object', { feature_index: idx });
    if (typeof p.id !== 'string' || p.id === '') {
      throw violation('feature properties.id to be a non-empty string', { feature_index: idx });
    }
    uids.push(p.id);

    const us = optionalUdate(p, 'udatestart', idx);
    const ue = optionalUdate(p, 'udateend', idx);
    if (us === null && ue === null) undated++;
    if (us !== null && (start === null || us < start.udate)) {
      start = { udate: us, as_written: asWritten(p, 'datestart') };
    }
    if (ue !== null && (end === null || ue > end.udate)) {
      end = { udate: ue, as_written: asWritten(p, 'dateend') };
    }

    const g = f.geometry;
    if (g === undefined || g === null) {
      ungeolocated++;
      return;
    }
    addGeometry(g, idx, acc);
  });

  const b = acc.b;
  return {
    metadata,
    record_count: features.length,
    extent: b === null ? null : [b.minLon, b.minLat, b.maxLon, b.maxLat],
    date_range: start === null && end === null ? null : { start, end },
    undated_count: undated,
    ungeolocated_count: ungeolocated,
    record_uids: uids,
  };
}
