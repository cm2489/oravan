# ES redistribution spot-check — decoded bill-content sample (S23)

**What this is:** a documented sample of 12 real bills' Spanish decodes, assembled
for Colby's native-speaker spot-check (interim substitute per U7, same
constraint as the S6 call-script pass in `docs/es-script-spotcheck.md`) — a
rubric, pass/fail criteria, and a log section for the dated result. Per
`docs/ideation/2026-07-05-build-gtm-strategy.md` §1.3 S23: "close the standing
ES redistribution bar flag before MCP and embeds put more Spanish AI-generated
text in front of third parties."

**What this is not:** a completed review. No live native-speaker pass has been
run as part of this PR — this document assembles real, already-published data
(every headline/tldr quoted below is the actual `data/bills-es.json` content,
not invented for this doc) and the rubric to run it against. §6 is where the
dated result gets logged, post-merge, exactly as S6's doc did for the
call-script lane.

---

## 1. Why this sample, why now

Two things changed since the corpus's ES decodes were last reviewed at scale:

- **`get_bill` (MCP, S10, merged and live)** returns a bill's full Spanish
  decode — headline, tl;dr, and the what/who/why/cost sections — to any
  agent that calls it with `locale: "es"`. That's a real, live redistribution
  surface today, not a future one.
- **The bill-card embed widget (S14)** — the other surface the strategy names
  ("MCP responses and embed widgets") — has **not** shipped yet; only the
  rep-lookup widget (S13, PR #42, open) exists, and it carries no bill
  decode text at all. So today's actual redistribution surface for decoded
  Spanish bill content is the MCP tool and the website itself; the embed
  half of the risk is still ahead of us, not yet live.

This spot-check clears the **existing corpus's** redistribution risk only.
It is not a substitute for the ES-reviewer hire, which stays a precondition
for nominations and state-expansion ES decode specifically (§1.2 of the
build/GTM strategy) — this is the interim, Colby-run check that covers what's
already shipped in the meantime.

## 2. Sample — 12 bills, 3 buckets

Picked from the live corpus (`data/bills.json` + `data/bills-es.json`,
1,665 of 1,667 bills carry an ES decode), not hand-picked for tone — a
spread across urgency and age:

| Bucket | Citation | Slug | Status | Urgency | Topic |
|---|---|---|---|---|---|
| High-urgency | SJRES 188 | `sjres-188-119` | floor_vote | 0.612 | environment_energy |
| High-urgency | HR 7086 | `hr-7086-119` | floor_vote | 0.597 | education |
| High-urgency | S 2666 | `s-2666-119` | floor_vote | 0.582 | ai_technology |
| High-urgency | S 4632 | `s-4632-119` | floor_vote | 0.582 | jobs_economy |
| Recently-decoded | HR 9200 | `hr-9200-119` | committee | 0.237 | (uncategorized) |
| Recently-decoded | HR 9172 | `hr-9172-119` | committee | 0.237 | jobs_economy |
| Recently-decoded | HR 9089 | `hr-9089-119` | committee | 0.147 | (uncategorized) |
| Recently-decoded | SJRES 194 | `sjres-194-119` | committee | 0.147 | (uncategorized) |
| Older / settled | HR 1 | `hr-1-119` | signed | 0.050 | jobs_economy |
| Older / settled | HR 4405 | `hr-4405-119` | signed | 0.050 | crime_justice |
| Older / settled | HJRES 88 | `hjres-88-119` | signed | 0.050 | environment_energy |
| Older / settled | HR 1968 | `hr-1968-119` | signed | 0.050 | jobs_economy |

"Recently-decoded" uses `introduced_date` as the closest available proxy for
decode recency — the pipeline has no dedicated `decoded_at` timestamp, and
decode-before-publish means a bill's `introduced_date` is close to when it
first entered the corpus already decoded. "Older / settled" picks `signed`
bills spanning nearly a year, including two (HR 4405, HJRES 88) whose subject
matter is the kind register/neutrality checks most need to catch.

Each bill is reachable two ways for the live pass: the bill page itself
(`/es/bills/{slug}`) and the MCP tool (`get_bill`, `{ slug: "{slug}", locale:
"es" }`) — the two real redistribution surfaces named above.

### 2.1 High-urgency

**SJRES 188** — floor_vote, urgency 0.612
- EN headline: "Senate moves to restore EPA power plant pollution limits"
- ES headline: "El Senado busca reactivar normas de emisiones de la EPA"
- EN tl;dr: "Congress is voting on whether to block an EPA rule that removed air pollution limits for coal- and oil-fired power plants."
- ES tl;dr: "El Congreso vota si bloquear una regla de la EPA que eliminó los límites de contaminación del aire para plantas eléctricas de carbón y petróleo."

**HR 7086** — floor_vote, urgency 0.597
- EN headline: "Federal grants would fund state programs helping charter schools secure buildings"
- ES headline: "Subsidios federales financiarían programas estatales para que escuelas charter consigan edificios"
- EN tl;dr: "HR 7086 lets the Education Dept. fund state programs that help charter schools find, rent, or renovate facilities, covering up to 60% of costs."
- ES tl;dr: "HR 7086 permite al Departamento de Educación financiar programas estatales que ayuden a las escuelas charter a encontrar, alquilar o renovar instalaciones, cubriendo hasta el 60% de los costos."

**S 2666** — floor_vote, urgency 0.582
- EN headline: "FCC would form task force to study foreign robocall scams under Senate bill"
- ES headline: "Proyecto de ley pide a la FCC crear grupo especial contra robocalls extranjeras"
- EN tl;dr: "Senate bill S 2666 would require the FCC to form a task force within 270 days to study and report on illegal foreign robocalls."
- ES tl;dr: "El proyecto S 2666 le exigiría a la FCC formar un grupo especial en 270 días para estudiar y reportar sobre robocalls ilegales del extranjero."

**S 4632** — floor_vote, urgency 0.582
- EN headline: "Automatic funding bill would end government shutdowns when budgets are late"
- ES headline: "Proyecto de ley activaría fondos automáticos para evitar cierres del gobierno"
- EN tl;dr: "Senate bill S 4632 would auto-fund the government at prior-year levels every 14 days when Congress misses a budget deadline."
- ES tl;dr: "El proyecto S 4632 financiaría al gobierno automáticamente al nivel del año anterior, renovándose cada 14 días si el Congreso no aprueba un presupuesto a tiempo."

### 2.2 Recently-decoded

**HR 9200** — committee, urgency 0.237, introduced 2026-06-08
- EN headline: "House bill HR 9200 targets US border security with scope yet unknown"
- ES headline: "Proyecto HR 9200 busca reforzar la seguridad fronteriza de EE. UU."
- EN tl;dr: "HR 9200 aims to strengthen US border security, but its specific measures and costs are unknown without the full bill text."
- ES tl;dr: "HR 9200 busca fortalecer la seguridad en las fronteras de EE. UU., pero sin el texto completo no se conocen sus medidas ni costos exactos."

**HR 9172** — committee, urgency 0.237, introduced 2026-06-08
- EN headline: "Bill extends wash sale and constructive sale tax rules to cryptocurrency"
- ES headline: "Proyecto de ley aplica reglas fiscales de acciones a las criptomonedas"
- EN tl;dr: "HR 9172 would apply existing stock tax rules to crypto, closing a loophole used to claim losses and defer gains."
- ES tl;dr: "HR 9172 aplicaría reglas fiscales ya existentes a las criptomonedas para eliminar una laguna usada para reclamar pérdidas y diferir ganancias."

**HR 9089** — committee, urgency 0.147, introduced 2026-06-02
- EN headline: "New federal commission would study Social Security and Medicare finances"
- ES headline: "Una nueva comisión federal estudiaría las finanzas del Seguro Social y Medicare"
- EN tl;dr: "HR 9089 creates a temporary bipartisan commission to study Social Security and Medicare funding shortfalls and report recommendations to Congress."
- ES tl;dr: "HR 9089 crea una comisión bipartidista temporal para estudiar la escasez de fondos del Seguro Social y Medicare y presentar recomendaciones al Congreso."

**SJRES 194** — committee, urgency 0.147, introduced 2026-06-02
- EN headline: "Senate resolution moves to kill D.C. police body camera transparency law"
- ES headline: "Resolución del Senado busca anular ley de transparencia policial en D.C."
- EN tl;dr: "SJRES 194 would cancel a D.C. law setting body camera rules for police use-of-force incidents if passed by both chambers and signed."
- ES tl;dr: "SJRES 194 cancelaría una ley de D.C. sobre cámaras corporales policiales en casos de uso de fuerza, si el Congreso la aprueba y el Presidente la firma."

### 2.3 Older / settled

**HR 1** — signed 2025-07-04
- EN headline: "HR 1 reshapes taxes, Medicaid, and student loans"
- ES headline: "Reforma fiscal recorta Medicaid y préstamos estudiantiles"
- EN tl;dr: "A sweeping new law changes taxes, food and health benefits, student loans, energy policy, and immigration fees for most Americans."
- ES tl;dr: "Una nueva ley amplia cambia los impuestos, los beneficios de salud y alimentación, los préstamos estudiantiles, la energía y las tarifas de inmigración para la mayoría de los estadounidenses."
- *Why sampled:* the single highest-profile, most consequential bill in the
  corpus — the ES headline compresses a reconciliation-scale bill into one
  line, the sharpest test of whether compression drops legal substance.

**HR 4405** — signed 2025-11-19
- EN headline: "Justice Department ordered to publish Epstein files within 30 days"
- ES headline: "Ley obliga al Departamento de Justicia a publicar archivos de Epstein en 30 días"
- EN tl;dr: "HR 4405 gives DOJ 30 days to post Epstein investigative records online in searchable form, with strict limits on what can be redacted."
- ES tl;dr: "HR 4405 le da al Departamento de Justicia 30 días para publicar en línea los archivos sobre Epstein, con límites estrictos sobre qué se puede ocultar."
- *Why sampled:* politically charged subject matter — the sharpest test of
  register/neutrality holding in Spanish.

**HJRES 88** — signed 2025-06-12
- EN headline: "Federal vote strips California of its stricter electric vehicle sales mandate"
- ES headline: "Votación federal elimina el mandato de vehículos eléctricos de California"
- EN tl;dr: "Congress voided the EPA waiver letting California require rising EV sales, forcing the state and about a dozen others back to federal emissions rules."
- ES tl;dr: "El Congreso anuló el permiso de la EPA que permitía a California exigir una mayor venta de vehículos eléctricos, lo que obliga al estado y a otros a seguir las normas federales."
- *Why sampled:* another politically charged, state-vs-federal subject —
  same register test as HR 4405 from a different angle.

**HR 1968** — signed 2025-03-15, the oldest bill in the sample
- EN headline: "Federal government funded through September 2025 under new spending law"
- ES headline: "Nueva ley financia el gobierno federal hasta septiembre de 2025"
- EN tl;dr: "HR 1968 funds the entire federal government through Sept. 30, 2025, mostly at 2024 spending levels, and extends key health programs."
- ES tl;dr: "HR 1968 financia todo el gobierno federal hasta el 30 de sept. de 2025, en su mayoría con los mismos niveles de gasto de 2024, y prorroga programas de salud clave."

## 3. Rubric

Per bill, pass/fail on three dimensions (the three the S23 scope names):

1. **Accuracy of legal meaning** — does the ES headline/tl;dr/sections state
   what the bill actually does, matching the EN decode's legal substance?
   Concrete figures (percentages, dollar amounts, day counts — "60% of
   costs," "270 days," "30 days") must survive translation exactly; no
   invented facts, no dropped conditions, no softened or sharpened claims
   relative to the English decode.
2. **Register/neutrality** — natural, professional Latin American Spanish,
   no machine-stiff phrasing, matching the warmth and plainness of
   `messages/es.json`'s own house style. Strictly nonpartisan: no party
   language, no advocacy-group jargon, no alarmism — in Spanish exactly as in
   English, regardless of how charged the bill's subject matter is (this is
   precisely why HR 4405 and HJRES 88 are in the sample).
3. **Label presence** — the AI-drafted/human-reviewed disclosure appears
   correctly wherever this content surfaces. On the bill page itself, that's
   the localized `bill.aiDisclaimer` string. Over MCP, it's the `ai_label`
   field in the citation envelope — which is a known gap worth flagging
   here, not fixed in this PR: `buildEnvelope` (`lib/core/mcp.ts`) emits
   `AI_LABEL_TEXT` in English regardless of the `locale` a query requested,
   so an agent surfacing only the envelope's own disclosure text to a
   Spanish-speaking end user currently shows them an English sentence. The
   new `/citations` page (this same PR) states this plainly; it isn't
   silently smoothed over here either.

## 4. Pass/fail criteria

All three dimensions must pass for a bill to clear the sample; any one
dimension failing fails the bill. With n=12, this is a spot check, not a
statistically powered audit — the criterion below is "did anything fail,"
not a pass-rate threshold, because a sample this size can't honestly support
a percentage claim (same epistemic discipline the build/GTM strategy applies
to its own traffic claims: state what was actually checked, not a number the
sample can't carry).

A failing bill is **flagged to the ES-reviewer-hire backlog below and never
silently patched** — per the S23 scope note and the strategy's standing rule
on corrections generally (see `/citations`'s "what happens when a correction
is confirmed" section).

## 5. ES-reviewer backlog (dated log)

| Date | Bill | Dimension failed | Note | Status |
|---|---|---|---|---|
| — | — | — | *None logged yet — no live pass has been run against this sample.* | — |

## 6. Dated result log

```
Date run:
Reviewer:
Bills sampled: 12/12
Pass: __ / 12
Fail: __ / 12  (each listed in §5 with the failing dimension and a verbatim note)
Notes:
```

No entry exists yet. Per the S6 precedent, the live pass happens post-merge,
and this is where it gets recorded — S23's done-criterion is "one dated
spot-check logged," not a passing grade.

## 7. Out of scope, on purpose

- **Call scripts** — a separate surface with its own spot-check material,
  already covered in `docs/es-script-spotcheck.md` (S6). This document is
  decoded bill *content* (headline/tl;dr/sections), not generated call
  scripts.
- **State-expansion ES decode** — gated separately on the ES-reviewer hire
  (or an equivalent bilingual-org partnership), a precondition per §1.2 of
  the build/GTM strategy, not something this spot-check substitutes for.
- **Localizing the MCP envelope's `ai_label`/`source`/`license` fields per
  locale** — named as a gap in §3 above, not fixed here. A real follow-up,
  not a silent scope cut.
