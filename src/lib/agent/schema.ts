/**
 * Zod to JSON Schema, for the small subset the tool contracts use.
 *
 * It exists so the schema ADVERTISED to the model is generated from the very
 * same Zod object the server validates with. Hand-writing the JSON Schema would
 * let the two drift, and a drifted contract is how an undeclared property ends
 * up silently accepted.
 *
 * `additionalProperties: false` everywhere, because every tool schema is strict.
 */
import type { z } from 'zod';

type JsonSchema = Record<string, unknown>;

interface AnyDef {
  type?: string;
  typeName?: string;
  checks?: unknown[];
  format?: string;
  values?: unknown;
  entries?: Record<string, unknown>;
  innerType?: unknown;
  element?: unknown;
  shape?: Record<string, unknown>;
}

/** Zod 4 names the kind in `_def.type`; Zod 3 used `_def.typeName`. Accept both. */
function kindOf(def: AnyDef): string {
  return (def.type ?? def.typeName ?? '').toString().toLowerCase().replace(/^zod/, '');
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = (schema as unknown as { _def: AnyDef })._def;
  const kind = kindOf(def);

  switch (kind) {
    case 'object': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const field = value as z.ZodTypeAny;
        properties[key] = zodToJsonSchema(field);
        if (!field.isOptional()) required.push(key);
      }
      return {
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
      };
    }
    case 'string': {
      const out: JsonSchema = { type: 'string' };
      if (def.format === 'uuid') out.format = 'uuid';
      for (const raw of def.checks ?? []) {
        const check = (raw as { _zod?: { def?: Record<string, unknown> } })._zod?.def
          ?? (raw as Record<string, unknown>);
        const check$ = check as { check?: string; kind?: string; format?: string; minimum?: number; maximum?: number; value?: number };
        const name = check$.check ?? check$.kind ?? check$.format;
        if (name === 'min_length' || name === 'min') out.minLength = check$.minimum ?? check$.value;
        if (name === 'max_length' || name === 'max') out.maxLength = check$.maximum ?? check$.value;
        if (name === 'uuid') out.format = 'uuid';
      }
      return out;
    }
    case 'enum': {
      const values = def.entries ? Object.values(def.entries) : def.values;
      return { type: 'string', enum: values as unknown[] };
    }
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'optional':
    case 'default':
      return zodToJsonSchema(def.innerType as z.ZodTypeAny);
    case 'array':
      return { type: 'array', items: zodToJsonSchema((def.element ?? def.innerType) as z.ZodTypeAny) };
    default:
      // An unmapped type is a mistake in a tool contract, not something to paper
      // over with a permissive schema that would accept anything.
      throw new Error(`zodToJsonSchema: unsupported type ${kind || 'unknown'}`);
  }
}
