/** Congress-style display citation from bill type + number, e.g. "S.J.Res. 99". */
const TYPE_LABELS: Record<string, string> = {
  hr: 'H.R.',
  s: 'S.',
  hres: 'H.Res.',
  sres: 'S.Res.',
  hjres: 'H.J.Res.',
  sjres: 'S.J.Res.',
  hconres: 'H.Con.Res.',
  sconres: 'S.Con.Res.',
};

export function formatCitation(billType: string, billNumber: number): string {
  return `${TYPE_LABELS[billType.toLowerCase()] ?? billType.toUpperCase()} ${billNumber}`;
}
