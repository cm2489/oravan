# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: feed.spec.ts >> search filters and clears
- Location: tests/feed.spec.ts:13:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText(/No bills match/)
Expected: visible
Timeout: 300ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 300ms
  - waiting for getByText(/No bills match/)


Call Log:
- Test timeout of 90000ms exceeded
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - link "Skip to main content" [ref=e2]:
    - /url: "#main"
  - banner [ref=e3]:
    - generic [ref=e4]:
      - link "Rostra" [ref=e5]:
        - /url: /
        - img [ref=e7]
        - text: Rostra
      - navigation "Primary" [ref=e11]:
        - link "Home" [ref=e12]:
          - /url: /
        - link "Bills" [ref=e13]:
          - /url: /bills
        - link "My reps" [ref=e14]:
          - /url: /reps
        - link "My impact" [ref=e15]:
          - /url: /impact
        - link "Why call?" [ref=e16]:
          - /url: /why-call
      - link "En español" [ref=e17]:
        - /url: /es/bills
        - img [ref=e18]
        - text: En español
  - main [ref=e22]:
    - generic [ref=e23]:
      - heading "Active bills, decoded" [level=1] [ref=e24]
      - paragraph [ref=e25]: Every bill moving through Congress right now, translated into plain language by AI. Filter by what matters to you.
      - generic [ref=e26]:
        - generic [ref=e27]:
          - generic [ref=e28]: Search bills
          - generic [ref=e29]:
            - img
            - searchbox "Search bills" [active] [ref=e30]: zzzzqqq
            - generic [ref=e31]: /
        - group "All topics" [ref=e32]:
          - button "All topics" [pressed] [ref=e33]
          - button "Jobs & the economy" [ref=e34]
          - button "Health care" [ref=e35]
          - button "Security & foreign affairs" [ref=e36]
          - button "Environment & energy" [ref=e37]
          - button "Government & democracy" [ref=e38]
          - button "Crime & justice" [ref=e39]
          - button "Family & community" [ref=e40]
          - button "Education" [ref=e41]
          - button "Immigration" [ref=e42]
          - button "AI & technology" [ref=e43]
          - button "Housing" [ref=e44]
          - button "Rights & liberties" [ref=e45]
        - paragraph [ref=e46]: Topic picks are saved only on this device, never on a server.
        - paragraph [ref=e47]: 522 of 522 bills
        - region "Act now" [ref=e48]:
          - heading "Act now" [level=2] [ref=e49]
          - paragraph [ref=e50]: Votes or floor action expected. Calls matter most here.
          - generic [ref=e51]:
            - link "S.J.Res. 99 Heading to a vote Senate moves to restore automatic work permit renewals Immigration Last action Apr 28" [ref=e52]:
              - /url: /bills/sjres-99-119
              - generic [ref=e53]:
                - generic [ref=e54]: S.J.Res. 99
                - generic [ref=e55]: ·
                - generic [ref=e56]: Heading to a vote
              - heading "Senate moves to restore automatic work permit renewals" [level=3] [ref=e57]
              - generic [ref=e58]:
                - generic [ref=e59]: Immigration
                - generic [ref=e60]: Last action Apr 28
            - link "S.J.Res. 139 Heading to a vote Senate moves to restore Colorado's EPA haze plan Environment & energy Last action Apr 28" [ref=e61]:
              - /url: /bills/sjres-139-119
              - generic [ref=e62]:
                - generic [ref=e63]: S.J.Res. 139
                - generic [ref=e64]: ·
                - generic [ref=e65]: Heading to a vote
              - heading "Senate moves to restore Colorado's EPA haze plan" [level=3] [ref=e66]
              - generic [ref=e67]:
                - generic [ref=e68]: Environment & energy
                - generic [ref=e69]: Last action Apr 28
            - link "S.J.Res. 141 Heading to a vote Senate moves to restore CFPB medical debt rules Jobs & the economy Last action Apr 26" [ref=e70]:
              - /url: /bills/sjres-141-119
              - generic [ref=e71]:
                - generic [ref=e72]: S.J.Res. 141
                - generic [ref=e73]: ·
                - generic [ref=e74]: Heading to a vote
              - heading "Senate moves to restore CFPB medical debt rules" [level=3] [ref=e75]
              - generic [ref=e76]:
                - generic [ref=e77]: Jobs & the economy
                - generic [ref=e78]: Last action Apr 26
            - link "S.J.Res. 145 Heading to a vote Senate bill targets CFPB's scrapped credit report rule Jobs & the economy Last action Apr 26" [ref=e79]:
              - /url: /bills/sjres-145-119
              - generic [ref=e80]:
                - generic [ref=e81]: S.J.Res. 145
                - generic [ref=e82]: ·
                - generic [ref=e83]: Heading to a vote
              - heading "Senate bill targets CFPB's scrapped credit report rule" [level=3] [ref=e84]
              - generic [ref=e85]:
                - generic [ref=e86]: Jobs & the economy
                - generic [ref=e87]: Last action Apr 26
            - link "S.J.Res. 149 Heading to a vote Senate moves to restore CFPB contract-for-deed rules Jobs & the economy Last action Apr 26" [ref=e88]:
              - /url: /bills/sjres-149-119
              - generic [ref=e89]:
                - generic [ref=e90]: S.J.Res. 149
                - generic [ref=e91]: ·
                - generic [ref=e92]: Heading to a vote
              - heading "Senate moves to restore CFPB contract-for-deed rules" [level=3] [ref=e93]
              - generic [ref=e94]:
                - generic [ref=e95]: Jobs & the economy
                - generic [ref=e96]: Last action Apr 26
            - link "S.J.Res. 130 Heading to a vote Senate bill would restore CFPB overdraft fee guidance Jobs & the economy Last action Apr 26" [ref=e97]:
              - /url: /bills/sjres-130-119
              - generic [ref=e98]:
                - generic [ref=e99]: S.J.Res. 130
                - generic [ref=e100]: ·
                - generic [ref=e101]: Heading to a vote
              - heading "Senate bill would restore CFPB overdraft fee guidance" [level=3] [ref=e102]
              - generic [ref=e103]:
                - generic [ref=e104]: Jobs & the economy
                - generic [ref=e105]: Last action Apr 26
          - button "Show all 43" [ref=e106]
        - region "Moving" [ref=e107]:
          - heading "Moving" [level=2] [ref=e108]
          - paragraph [ref=e109]: Advancing through committees and onto the calendar.
          - generic [ref=e110]:
            - link "H.R. 6238 In markup NIH maternal health program seeks $73M yearly boost Health care Last action May 20" [ref=e111]:
              - /url: /bills/hr-6238-119
              - generic [ref=e112]:
                - generic [ref=e113]: H.R. 6238
                - generic [ref=e114]: ·
                - generic [ref=e115]: In markup
              - heading "NIH maternal health program seeks $73M yearly boost" [level=3] [ref=e116]
              - generic [ref=e117]:
                - generic [ref=e118]: Health care
                - generic [ref=e119]: Last action May 20
            - link "H.R. 2001 In markup Federal dental workforce grants extended through 2030 Health care Last action May 20" [ref=e120]:
              - /url: /bills/hr-2001-119
              - generic [ref=e121]:
                - generic [ref=e122]: H.R. 2001
                - generic [ref=e123]: ·
                - generic [ref=e124]: In markup
              - heading "Federal dental workforce grants extended through 2030" [level=3] [ref=e125]
              - generic [ref=e126]:
                - generic [ref=e127]: Health care
                - generic [ref=e128]: Last action May 20
            - link "H.R. 3491 In markup NIH must launch INCLUDE Project to fund Down syndrome research across lifespan Health care Last action May 20" [ref=e129]:
              - /url: /bills/hr-3491-119
              - generic [ref=e130]:
                - generic [ref=e131]: H.R. 3491
                - generic [ref=e132]: ·
                - generic [ref=e133]: In markup
              - heading "NIH must launch INCLUDE Project to fund Down syndrome research across lifespan" [level=3] [ref=e134]
              - generic [ref=e135]:
                - generic [ref=e136]: Health care
                - generic [ref=e137]: Last action May 20
            - link "H.R. 8352 In markup State police licensing boards gain FBI record access Crime & justice Last action Apr 21" [ref=e138]:
              - /url: /bills/hr-8352-119
              - generic [ref=e139]:
                - generic [ref=e140]: H.R. 8352
                - generic [ref=e141]: ·
                - generic [ref=e142]: In markup
              - heading "State police licensing boards gain FBI record access" [level=3] [ref=e143]
              - generic [ref=e144]:
                - generic [ref=e145]: Crime & justice
                - generic [ref=e146]: Last action Apr 21
            - link "H.R. 8283 In markup Bill targets foreign AI model extraction attacks Security & foreign affairs Last action Apr 21" [ref=e147]:
              - /url: /bills/hr-8283-119
              - generic [ref=e148]:
                - generic [ref=e149]: H.R. 8283
                - generic [ref=e150]: ·
                - generic [ref=e151]: In markup
              - heading "Bill targets foreign AI model extraction attacks" [level=3] [ref=e152]
              - generic [ref=e153]:
                - generic [ref=e154]: Security & foreign affairs
                - generic [ref=e155]: Last action Apr 21
            - link "H.R. 4920 In markup BIS would get $25M yearly for tech upgrades under new bill Security & foreign affairs Last action Apr 21" [ref=e156]:
              - /url: /bills/hr-4920-119
              - generic [ref=e157]:
                - generic [ref=e158]: H.R. 4920
                - generic [ref=e159]: ·
                - generic [ref=e160]: In markup
              - heading "BIS would get $25M yearly for tech upgrades under new bill" [level=3] [ref=e161]
              - generic [ref=e162]:
                - generic [ref=e163]: Security & foreign affairs
                - generic [ref=e164]: Last action Apr 21
          - button "Show all 109" [ref=e165]
        - region "On the radar" [ref=e166]:
          - heading "On the radar" [level=2] [ref=e167]
          - paragraph [ref=e168]: "Earlier stages: worth watching, less time pressure."
          - generic [ref=e169]:
            - link "H.R. 9027 In committee Pentagon fuel discount bill targets military exchange gas stations Security & foreign affairs Last action May 25" [ref=e170]:
              - /url: /bills/hr-9027-119
              - generic [ref=e171]:
                - generic [ref=e172]: H.R. 9027
                - generic [ref=e173]: ·
                - generic [ref=e174]: In committee
              - heading "Pentagon fuel discount bill targets military exchange gas stations" [level=3] [ref=e175]
              - generic [ref=e176]:
                - generic [ref=e177]: Security & foreign affairs
                - generic [ref=e178]: Last action May 25
            - link "H.R. 8994 In committee Bill would let indie musicians bargain collectively with Spotify and YouTube Jobs & the economy Last action May 20" [ref=e179]:
              - /url: /bills/hr-8994-119
              - generic [ref=e180]:
                - generic [ref=e181]: H.R. 8994
                - generic [ref=e182]: ·
                - generic [ref=e183]: In committee
              - heading "Bill would let indie musicians bargain collectively with Spotify and YouTube" [level=3] [ref=e184]
              - generic [ref=e185]:
                - generic [ref=e186]: Jobs & the economy
                - generic [ref=e187]: Last action May 20
            - link "H.R. 9007 In committee HHS pilot program would cover formula costs for families shut out of WIC Health care Last action May 20" [ref=e188]:
              - /url: /bills/hr-9007-119
              - generic [ref=e189]:
                - generic [ref=e190]: H.R. 9007
                - generic [ref=e191]: ·
                - generic [ref=e192]: In committee
              - heading "HHS pilot program would cover formula costs for families shut out of WIC" [level=3] [ref=e193]
              - generic [ref=e194]:
                - generic [ref=e195]: Health care
                - generic [ref=e196]: Last action May 20
            - link "H.R. 8923 In committee Medicare home observation pilot program set for two-year trial under HHS Health care Last action May 19" [ref=e197]:
              - /url: /bills/hr-8923-119
              - generic [ref=e198]:
                - generic [ref=e199]: H.R. 8923
                - generic [ref=e200]: ·
                - generic [ref=e201]: In committee
              - heading "Medicare home observation pilot program set for two-year trial under HHS" [level=3] [ref=e202]
              - generic [ref=e203]:
                - generic [ref=e204]: Health care
                - generic [ref=e205]: Last action May 19
            - link "H.R. 8885 In committee Bill would bar Treasury from paying \"weaponization\" settlements to Trump allies Government & democracy Last action May 18" [ref=e206]:
              - /url: /bills/hr-8885-119
              - generic [ref=e207]:
                - generic [ref=e208]: H.R. 8885
                - generic [ref=e209]: ·
                - generic [ref=e210]: In committee
              - heading "Bill would bar Treasury from paying \"weaponization\" settlements to Trump allies" [level=3] [ref=e211]
              - generic [ref=e212]:
                - generic [ref=e213]: Government & democracy
                - generic [ref=e214]: Last action May 18
            - link "S. 4550 In committee Federal maternal health bill directs $190M to CDC for emergency data Health care Last action May 17" [ref=e215]:
              - /url: /bills/s-4550-119
              - generic [ref=e216]:
                - generic [ref=e217]: S. 4550
                - generic [ref=e218]: ·
                - generic [ref=e219]: In committee
              - heading "Federal maternal health bill directs $190M to CDC for emergency data" [level=3] [ref=e220]
              - generic [ref=e221]:
                - generic [ref=e222]: Health care
                - generic [ref=e223]: Last action May 17
          - button "Show all 370" [ref=e224]
  - contentinfo [ref=e225]:
    - generic [ref=e226]:
      - paragraph [ref=e227]: "Rostra is free, nonpartisan civic infrastructure. No accounts, no tracking: your data never leaves your device."
      - paragraph [ref=e228]: Bill summaries and scripts are AI-drafted and clearly marked. Always review before you use them.
      - navigation "Footer" [ref=e229]:
        - link "Privacy" [ref=e230]:
          - /url: /privacy
        - link "Terms" [ref=e231]:
          - /url: /terms
        - link "Why call?" [ref=e232]:
          - /url: /why-call
  - alert [ref=e233]
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | 
  3  | test('feed renders capped bands with show-all expansion', async ({ page }) => {
  4  |   await page.goto('/bills');
  5  |   await expect(page.getByRole('heading', { name: 'Act now' })).toBeVisible();
  6  |   const before = await page.locator('a[href*="/bills/"]').count();
  7  |   const showAll = page.getByRole('button', { name: /show all/i }).first();
  8  |   await showAll.click();
  9  |   const after = await page.locator('a[href*="/bills/"]').count();
  10 |   expect(after).toBeGreaterThan(before);
  11 | });
  12 | 
  13 | test('search filters and clears', async ({ page }) => {
  14 |   test.slow(); // hydration-gated; needs runway under full parallel load
  15 |   await page.goto('/bills');
  16 |   const search = page.getByRole('searchbox');
  17 |   // The count line is prerendered in static HTML, so it can't prove React is
  18 |   // awake. A nonsense query producing the empty state can: it only renders
  19 |   // after hydration. Retry until that happens, then test the real flow.
  20 |   await expect(async () => {
  21 |     await search.fill('zzzzqqq');
  22 |     await expect(page.getByText(/No bills match/)).toBeVisible({ timeout: 300 });
> 23 |   }).toPass();
     |      ^ Error: expect(locator).toBeVisible() failed
  24 |   await search.fill('veterans');
  25 |   await expect(page.getByText(/No bills match/)).toBeHidden();
  26 |   await search.press('Escape');
  27 |   await expect(search).toHaveValue('');
  28 | });
  29 | 
  30 | test('topic chip filters the feed and persists', async ({ page }) => {
  31 |   await page.goto('/bills');
  32 |   await page.getByRole('button', { name: 'Health care' }).click();
  33 |   await expect(page.getByRole('button', { name: 'Health care' })).toHaveAttribute('aria-pressed', 'true');
  34 |   const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('rostra.prefs') ?? '{}'));
  35 |   expect(prefs.interests).toContain('health');
  36 | });
  37 | 
  38 | test('"/" focuses search on desktop', async ({ page, isMobile }) => {
  39 |   test.skip(!!isMobile, 'keyboard accelerator');
  40 |   await page.goto('/bills');
  41 |   // retry until hydration has attached the listener
  42 |   await expect(async () => {
  43 |     await page.keyboard.press('/');
  44 |     await expect(page.getByRole('searchbox')).toBeFocused({ timeout: 250 });
  45 |   }).toPass();
  46 | });
  47 | 
```