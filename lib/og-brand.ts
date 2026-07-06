import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Brand lockup for the Satori OG templates. Satori can't use CSS vars or
 * currentColor, so the masters in assets/brand/ are recolored per use and
 * inlined as data URIs (evenodd fill survives the <img> path; inline <svg>
 * fill-rule support in Satori is unreliable). Server/build only.
 */
const read = (file: string) => readFileSync(join(process.cwd(), 'assets', 'brand', file), 'utf8');
const MARK = read('oravan-mark.svg');
const WORDMARK = read('oravan-wordmark.svg');

const uri = (svg: string, fill: string) =>
  `data:image/svg+xml;base64,${Buffer.from(svg.replaceAll('currentColor', fill)).toString('base64')}`;

export const markDataUri = (fill: string) => uri(MARK, fill);
export const wordmarkDataUri = (fill: string) => uri(WORDMARK, fill);
/** Width per 1px of height, from the wordmark's 1947.6 x 691.5 viewBox. */
export const WORDMARK_RATIO = 1947.6 / 691.5;
