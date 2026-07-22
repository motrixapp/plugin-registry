import { z } from 'zod'

// Wire schema for the Motrix plugin registry — contract v1.
//
// THIS FILE IS THE SOURCE OF TRUTH. Copies are vendored into:
//   - motrix-website  src/data/plugins.ts
//   - motrix-turbo    src/shared/schemas/registry.ts
// together with the byte-identical schema/registry.fixture.json.
// Lockstep rule: any wire-shape change lands in all three repos in the
// same PR cycle, and evolution is additive-only — never rename, retype,
// or remove a published field. Design doc: motrix-website
// docs/superpowers/specs/2026-07-10-plugin-registry-api-design.md.

export const REGISTRY_URL = 'https://dl.motrix.app/registry/plugins.json'

/** Absolute base every icon/screenshot URL must live under (spec §3.3). */
export const ASSETS_BASE_URL = 'https://dl.motrix.app/registry/assets'

/** Dot-namespaced lowercase plugin id; `motrix.*` is reserved for builtins. */
export const REGISTRY_PLUGIN_ID_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/

/**
 * Registered category slugs. Adding a slug is an additive change; entries
 * in this repo must use registered slugs (CI-enforced in
 * scripts/validate.ts). Consumers may be more lenient — the app buckets
 * unknown slugs under "other", the website filters them.
 */
export const REGISTERED_CATEGORIES = [
  'site-resolver',
  'post-action',
  'automation',
  'integration',
] as const

const LocalizedTextSchema = z.object({
  en: z.string().min(1),
  zh: z.string().min(1).optional(),
})

const LocalizedListSchema = z.object({
  en: z.array(z.string().min(1)),
  zh: z.array(z.string().min(1)).optional(),
})

export const RegistryPluginSchema = z.object({
  id: z.string().regex(REGISTRY_PLUGIN_ID_RE),
  name: LocalizedTextSchema,
  description: LocalizedTextSchema,
  version: z.string().min(1),
  author: z.object({ name: z.string().min(1), url: z.url().optional() }),
  origin: z.enum(['builtin', 'community']),
  categories: z.array(z.string().min(1)).min(1),
  engines: z.object({ motrix: z.string().min(1) }),
  // Consent preview only — actual grants always come from the manifest
  // inside the package (spec §6.3).
  permissions: z.array(z.string().min(1)).default([]),
  optionalPermissions: z.array(z.string().min(1)).default([]),
  hostPermissions: z.array(z.string().min(1)).default([]),
  // Install pointer + integrity anchor. Required for community entries
  // (CI-enforced); absent for builtins, which ship with the app.
  package: z
    .object({
      url: z.url(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      size: z.number().int().positive(),
    })
    .optional(),
  repository: z.url().optional(),
  homepage: z.url().optional(),
  icon: z.string().optional(),
  screenshots: z.array(z.string()).default([]),
  features: LocalizedListSchema.optional(),
  updatedAt: z.iso.date(),
  featured: z.boolean().default(false),
})
export type RegistryPlugin = z.infer<typeof RegistryPluginSchema>

export const RegistryFileSchema = z.object({
  version: z.literal(1),
  /** Stamped by the aggregation CI at publish time. */
  generatedAt: z.iso.datetime(),
  plugins: z.array(RegistryPluginSchema),
})
export type RegistryFile = z.infer<typeof RegistryFileSchema>
