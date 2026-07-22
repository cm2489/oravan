import { buildThemeCss, type ResolvedEmbedTheme } from '@/lib/embed-theme';

/*
 * The single delivery point for embed theming (brand-preview build): one
 * server-rendered <style> tag of validated custom-property declarations —
 * see lib/embed-theme.ts's buildThemeCss for why this is still
 * "custom properties are the ONLY theming mechanism".
 *
 * A style tag at :root (not inline vars on the widget's <main>) because the
 * fixed-height iframe shows <body> below short content — inline vars can't
 * recolor that band, which for action-panel refusal states (that never
 * resize) is a permanently mismatched stripe on a themed host page.
 *
 * dangerouslySetInnerHTML is required, not a shortcut: React text children
 * escape the double quotes the FONT_VALUES stacks legitimately contain.
 * Nothing here is dangerous by construction — buildThemeCss re-verifies
 * every hex and only interpolates closed-map values.
 */
export function EmbedThemeStyle({ theme }: { theme: ResolvedEmbedTheme }) {
  return <style dangerouslySetInnerHTML={{ __html: buildThemeCss(theme) }} />;
}
