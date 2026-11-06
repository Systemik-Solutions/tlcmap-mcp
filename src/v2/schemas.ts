import { z } from 'zod';
import { TlcmapError } from '../errors.js';

const int = z.number().int();
const text = z.string().nullable();
const bbox = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const pageSchema = z.looseObject({
  returned: int,
  per_page: int,
  next_cursor: z.string().nullable(),
  next: z.string().nullable(),
});

export const undatedSchema = z.looseObject({ total: int, no_date: int, unparseable_date: int });

export const dateRangeSchema = z.looseObject({ start: int, end: int }).nullable();

export const summarySchema = z.looseObject({
  total: int,
  extent: bbox.nullable(),
  no_coordinates_count: int,
  date_range: dateRangeSchema,
  undated: undatedSchema,
  unparseable_dates: int,
  by_source: z.looseObject({ layers: int, anps: int, ncg: int, text: int }),
  by_layer: z.array(z.looseObject({ layer_id: int, name: text, count: int, warning: text })).optional(),
});

export const placesSummarySchema = summarySchema.extend({
  by_layer: z.array(z.looseObject({ layer_id: int, name: text, count: int, warning: text })),
});

export const layerSchema = z.looseObject({
  id: int,
  name: text,
  description: text,
  subject_keywords: z.array(z.string()),
  record_type: text,
  creator: text,
  publisher: text,
  contact: text,
  citation: text,
  doi: text,
  source_url: text,
  linkback: text,
  license: text,
  rights: text,
  language: text,
  warning: text,
  declared: z.looseObject({
    latitude_from: z.number().nullable(),
    latitude_to: z.number().nullable(),
    longitude_from: z.number().nullable(),
    longitude_to: z.number().nullable(),
    temporal_from: text,
    temporal_to: text,
  }),
  created: text,
  created_at: text,
  updated_at: text,
  url: z.string(),
});

export const catalogueEntrySchema = z.looseObject({
  id: int,
  name: text,
  description: text,
  creator: text,
  record_type: text,
  record_count: int,
  matching_count: int.nullable(),
  bbox: bbox.nullable(),
  date_range: dateRangeSchema,
  undated: undatedSchema,
  has_license: z.boolean(),
  has_warning: z.boolean(),
  url: z.string(),
});

export const featureSchema = z.looseObject({
  type: z.literal('Feature'),
  geometry: z
    .looseObject({ type: z.literal('Point'), coordinates: z.tuple([z.number(), z.number()]) })
    .nullable(),
  properties: z.looseObject({
    id: z.string().min(1),
    name: text,
    placename: text,
    description: text,
    datasource: z.enum(['layers', 'anps', 'ncg', 'text']).nullable(),
    layer_id: int.nullable(),
    record_type: text,
    state: text,
    lga: text,
    parish: text,
    feature_term: text,
    datestart: text,
    dateend: text,
    udatestart: int.nullable(),
    udateend: int.nullable(),
    source: text,
    external_url: text,
    image_url: text,
    glycerine_url: text,
    url: z.string(),
    created_at: text,
    updated_at: text,
    extended_data: z.record(z.string(), z.string()),
    extended_data_unreadable: z.boolean(),
  }),
});

const queryEcho = z.looseObject({});

export const layerDetailResponse = z.looseObject({ layer: layerSchema, summary: summarySchema });

export const layerFeaturesResponse = z.looseObject({
  type: z.literal('FeatureCollection'),
  layer: layerSchema,
  query: queryEcho,
  summary: summarySchema,
  page: pageSchema,
  features: z.array(featureSchema),
});

export const catalogueResponse = z.looseObject({
  query: queryEcho,
  total: int,
  page: pageSchema,
  layers: z.array(catalogueEntrySchema),
});

export const placesResponse = z.looseObject({
  type: z.literal('FeatureCollection'),
  query: queryEcho,
  summary: placesSummarySchema,
  page: pageSchema,
  features: z.array(featureSchema),
});

export const placesSummaryOnlyResponse = z.looseObject({ query: queryEcho, summary: placesSummarySchema });

export const errorBodySchema = z.looseObject({
  error: z.looseObject({ code: z.string(), message: z.string(), details: z.looseObject({}) }),
});

export type V2Page = z.infer<typeof pageSchema>;
export type V2Summary = z.infer<typeof summarySchema>;
export type V2PlacesSummary = z.infer<typeof placesSummarySchema>;
export type V2Layer = z.infer<typeof layerSchema>;
export type V2CatalogueEntry = z.infer<typeof catalogueEntrySchema>;
export type V2Feature = z.infer<typeof featureSchema>;
export type V2LayerDetailResponse = z.infer<typeof layerDetailResponse>;
export type V2LayerFeaturesResponse = z.infer<typeof layerFeaturesResponse>;
export type V2CatalogueResponse = z.infer<typeof catalogueResponse>;
export type V2PlacesResponse = z.infer<typeof placesResponse>;
export type V2PlacesSummaryOnlyResponse = z.infer<typeof placesSummaryOnlyResponse>;
export type V2ErrorBody = z.infer<typeof errorBodySchema>;

function violation(expected: string): TlcmapError {
  return new TlcmapError('UPSTREAM_CONTRACT_VIOLATION', 'TLCMap returned a response that does not match API v2.', {
    expected,
  });
}

/** Fatal UTF-8 decode, JSON parse, then schema; any failure is an upstream contract violation. */
export function parseV2<S extends z.ZodType>(body: Buffer, schema: S): z.infer<S> {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw violation('UTF-8 JSON');
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw violation(`${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}`);
  }
  return result.data;
}

export function checkLayerIdentity(layer: { id: number }, layerId: number): void {
  if (layer.id !== layerId) throw violation(`layer.id to equal ${layerId}`);
}

export function checkFeaturesOfLayer(features: { properties: { layer_id: number | null } }[], layerId: number): void {
  if (features.some((f) => f.properties.layer_id !== layerId)) {
    throw violation(`every feature to have layer_id ${layerId}`);
  }
}

export function withoutFeatures<T extends { features?: unknown }>(doc: T): Omit<T, 'features'> {
  const rest: Partial<T> = { ...doc };
  delete rest.features;
  return rest as Omit<T, 'features'>;
}
