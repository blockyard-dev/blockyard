import type { Manifest } from '../types/manifest';

export type ManifestLocale = {
  name?: string;
  description?: string;
  blocks?: Record<string, {
    text?: string;
    repeatLabel?: string;
    args?: Record<string, {
      label?: string;
      help?: string;
      options?: Record<string, string | { label: string }>;
    }>;
  }>;
  buttons?: Record<string, { label?: string }>;
  sections?: Record<string, { title?: string }>;
  config?: Record<string, { label?: string; help?: string }>;
  panels?: Record<string, { name?: string }>;
};

export type TranslatableManifest = Manifest & { locales?: Record<string, ManifestLocale> };

/** Build a display-only copy. Contract comparison and project IR keep using the raw manifest. */
export function localizeManifest(
  source: Manifest,
  locales: Record<string, ManifestLocale> | undefined,
  locale: string,
): Manifest {
  const out = structuredClone(source) as TranslatableManifest;
  delete out.locales;
  const overlays = [locales?.[source.defaultLocale ?? 'zh-TW'], locales?.[locale]];
  for (const overlay of overlays) {
    if (!overlay) continue;
    if (overlay.name !== undefined) out.name = overlay.name;
    if (overlay.description !== undefined) out.description = overlay.description;
    for (const item of out.palette ?? []) {
      if ('opcode' in item) {
        const translated = overlay.blocks?.[item.opcode];
        if (!translated) continue;
        if (translated.text !== undefined) item.text = translated.text;
        for (const [name, arg] of Object.entries(item.args ?? {})) {
          applyArg(arg, translated.args?.[name]);
        }
        if (item.repeat) {
          if (translated.repeatLabel !== undefined) item.repeat.label = translated.repeatLabel;
          for (const [name, arg] of Object.entries(item.repeat.args)) {
            applyArg(arg, translated.args?.[name]);
          }
        }
      } else if ('button' in item) {
        const label = overlay.buttons?.[item.button]?.label;
        if (label !== undefined) item.label = label;
      } else if (item.id) {
        const title = overlay.sections?.[item.id]?.title;
        if (title !== undefined) item.section = title;
      }
    }
    for (const config of out.config ?? []) {
      const translated = overlay.config?.[config.key];
      if (translated?.label !== undefined) config.label = translated.label;
      if (translated?.help !== undefined) config.help = translated.help;
    }
    for (const panel of out.panels ?? []) {
      const name = overlay.panels?.[panel.id]?.name;
      if (name !== undefined) panel.name = name;
    }
  }
  return out;
}

function applyArg(
  arg: { label?: string | null; help?: string | null; options?: Array<{ value: string; label?: string | null }> | null },
  translated?: { label?: string; help?: string; options?: Record<string, string | { label: string }> },
) {
  if (!translated) return;
  if (translated.label !== undefined) arg.label = translated.label;
  if (translated.help !== undefined) arg.help = translated.help;
  for (const option of arg.options ?? []) {
    const value = translated.options?.[option.value];
    if (value !== undefined) option.label = typeof value === 'string' ? value : value.label;
  }
}
