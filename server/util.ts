import type { ZodType, ZodTypeDef } from 'zod';
import { badRequest } from './errors.js';
import { txt } from './strings.js';

export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, data: unknown): T {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw badRequest(r.error.issues[0]?.message ?? txt.errors.invalidData, 'validation');
  return r.data;
}

export function intParam(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(txt.errors.invalidId);
  return n;
}

export function optInt(v: unknown): number | undefined {
  if (v === undefined || v === '' || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
