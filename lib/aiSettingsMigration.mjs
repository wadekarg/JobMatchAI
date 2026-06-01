/**
 * Idempotently ensures aiSettings has a `keys` field.
 *
 * The pre-2026-06 shape was {provider, apiKey, model, temperature} —
 * a single apiKey covering the active provider. The new shape adds
 * `keys: {<providerId>: <apiKey>}` so we can auto-fill the API key
 * field when the user switches providers in Settings.
 *
 * Behavior:
 *   - Already-migrated input (has `keys`) → returned unchanged
 *     (reference-equal).
 *   - Old shape with non-empty apiKey + provider → seed keys with
 *     {[provider]: apiKey}.
 *   - Old shape with empty apiKey → seed keys with {} (nothing to
 *     remember yet).
 *   - null / undefined / non-object → returned unchanged (the caller's
 *     default-object path takes over).
 *
 * Pure — does not mutate input.
 */
export function migrateAiSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  if (settings.keys) return settings;
  if (!settings.apiKey || !settings.provider) {
    return { ...settings, keys: {} };
  }
  return { ...settings, keys: { [settings.provider]: settings.apiKey } };
}
