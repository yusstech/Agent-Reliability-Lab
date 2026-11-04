// Identifier formats shared by the provider APIs, the fault engine and the write path.
// The migration CHECK constraints mirror these; keep them in sync.
export const ORDER_ID = /^ord_[a-z0-9]{1,32}$/;
export const SHIPMENT_ID = /^shp_[a-z0-9]{1,32}$/;
export const ENTITY_ID = /^(ord|shp)_[a-z0-9]{1,32}$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
