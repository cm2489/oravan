/** Merge data/headlines-v2.json into bills.json (en) and bills-es.json (es). */
import { readFileSync, writeFileSync } from 'node:fs';

const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
const es = JSON.parse(readFileSync('data/bills-es.json', 'utf8'));
const v2 = JSON.parse(readFileSync('data/headlines-v2.json', 'utf8'));
const slug = (b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();

let merged = 0;
for (const b of bills) {
  const h = v2[slug(b)];
  if (!h) continue;
  b.ai_headline = h.en;
  if (es[slug(b)]) es[slug(b)].headline = h.es;
  merged++;
}
writeFileSync('data/bills.json', JSON.stringify(bills));
writeFileSync('data/bills-es.json', JSON.stringify(es));
console.log(`merged ${merged} headlines into both corpora`);
