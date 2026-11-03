# Captured fixtures

Captured by `npm run capture-fixtures` with User-Agent `tlcmap-mcp/0.1.0 (+https://test-mcp.tlcmap.org)`.
Bytes are stored exactly as received unless stated. Do not edit by hand.

## layer-206.json

- URL: https://tlcmap.org/layers/206/json
- HTTP status: 200
- Captured (UTC): 2026-11-03T06:46:40.319Z
- Features: 52
- Size: 109369 bytes
- sha256: 34aa22de5b7b32f184e26906bbf5cbde2dfb22399075f461387b07d33d787cb8

## layer-1125.json

- URL: https://tlcmap.org/layers/1125/json
- HTTP status: 200
- Captured (UTC): 2026-11-03T06:46:40.704Z
- Features: 94
- Size: 235824 bytes
- sha256: fef262fa4881e64e974f49ccd774bc3bdf5a310139f06d6da8fa796c83734a19

## layer-2749-trimmed.json

- URL: https://tlcmap.org/layers/2749/json
- HTTP status: 200
- Captured (UTC): 2026-11-03T06:46:41.735Z
- Original size: 4457978 bytes, 1602 features
- Trimming rule: `JSON.stringify({...feed, features: feed.features.slice(0, 20)})` plus a trailing newline
- Trimmed features: 20
- Size: 45515 bytes
- sha256: adeb89832448aa0480fca5b279ab8f24bab4dc46da96fed4795087ee8b9bab63

## layer-missing.json

- URL: https://tlcmap.org/layers/99999999/json
- HTTP status: 200
- Captured (UTC): 2026-11-03T06:46:41.911Z
- Features: 0
- Note: a missing layer is answered with HTTP 200, `metadata.warnnig` and an empty `features` array (not an absent key).
- Size: 670 bytes
- sha256: bc89e61c89134991251e38da8c532797b5e7ae217380b0c674fe56f85cc0828c
