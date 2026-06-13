# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: feed.spec.ts >> search filters and clears
- Location: tests/feed.spec.ts:15:5

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
        - region "Moving" [ref=e48]:
          - heading "Moving" [level=2] [ref=e49]
          - paragraph [ref=e50]: Advancing through committees and onto the calendar.
          - generic [ref=e51]:
            - link "H.R. 1993 Passed one chamber Commemorative coins planned for 9/11's 25th anniversary Jobs & the economy Last action May 20" [ref=e52]:
              - /url: /bills/hr-1993-119
              - generic [ref=e53]:
                - generic [ref=e54]: H.R. 1993
                - generic [ref=e55]: ·
                - generic [ref=e56]: Passed one chamber
              - heading "Commemorative coins planned for 9/11's 25th anniversary" [level=3] [ref=e57]
              - generic [ref=e58]:
                - generic [ref=e59]: Jobs & the economy
                - generic [ref=e60]: Last action May 20
            - link "H.R. 7343 Heading to a vote Bill expands foster youth education and training aid Jobs & the economy Last action May 10" [ref=e61]:
              - /url: /bills/hr-7343-119
              - generic [ref=e62]:
                - generic [ref=e63]: H.R. 7343
                - generic [ref=e64]: ·
                - generic [ref=e65]: Heading to a vote
              - heading "Bill expands foster youth education and training aid" [level=3] [ref=e66]
              - generic [ref=e67]:
                - generic [ref=e68]: Jobs & the economy
                - generic [ref=e69]: Last action May 10
            - link "H.R. 7995 Heading to a vote Bill adds mentoring goals to federal foster care program Family & community Last action May 10" [ref=e70]:
              - /url: /bills/hr-7995-119
              - generic [ref=e71]:
                - generic [ref=e72]: H.R. 7995
                - generic [ref=e73]: ·
                - generic [ref=e74]: Heading to a vote
              - heading "Bill adds mentoring goals to federal foster care program" [level=3] [ref=e75]
              - generic [ref=e76]:
                - generic [ref=e77]: Family & community
                - generic [ref=e78]: Last action May 10
            - link "H.R. 7529 Heading to a vote States could use Chafee funds for foster youth legal aid Family & community Last action May 10" [ref=e79]:
              - /url: /bills/hr-7529-119
              - generic [ref=e80]:
                - generic [ref=e81]: H.R. 7529
                - generic [ref=e82]: ·
                - generic [ref=e83]: Heading to a vote
              - heading "States could use Chafee funds for foster youth legal aid" [level=3] [ref=e84]
              - generic [ref=e85]:
                - generic [ref=e86]: Family & community
                - generic [ref=e87]: Last action May 10
            - link "H.R. 7432 Passed one chamber Foster care vouchers would rise to $12,000 under HR 7432 Family & community Last action May 19" [ref=e88]:
              - /url: /bills/hr-7432-119
              - generic [ref=e89]:
                - generic [ref=e90]: H.R. 7432
                - generic [ref=e91]: ·
                - generic [ref=e92]: Passed one chamber
              - heading "Foster care vouchers would rise to $12,000 under HR 7432" [level=3] [ref=e93]
              - generic [ref=e94]:
                - generic [ref=e95]: Family & community
                - generic [ref=e96]: Last action May 19
            - link "H.R. 7463 Heading to a vote Foster youth college vouchers raised to $12,000 yearly Family & community Last action May 6" [ref=e97]:
              - /url: /bills/hr-7463-119
              - generic [ref=e98]:
                - generic [ref=e99]: H.R. 7463
                - generic [ref=e100]: ·
                - generic [ref=e101]: Heading to a vote
              - heading "Foster youth college vouchers raised to $12,000 yearly" [level=3] [ref=e102]
              - generic [ref=e103]:
                - generic [ref=e104]: Family & community
                - generic [ref=e105]: Last action May 6
          - button "Show all 9" [ref=e106]
        - region "On the radar" [ref=e107]:
          - heading "On the radar" [level=2] [ref=e108]
          - paragraph [ref=e109]: "Earlier stages: worth watching, less time pressure."
          - generic [ref=e110]:
            - link "S.J.Res. 99 Heading to a vote Senate moves to restore automatic work permit renewals Immigration Last action Apr 28" [ref=e111]:
              - /url: /bills/sjres-99-119
              - generic [ref=e112]:
                - generic [ref=e113]: S.J.Res. 99
                - generic [ref=e114]: ·
                - generic [ref=e115]: Heading to a vote
              - heading "Senate moves to restore automatic work permit renewals" [level=3] [ref=e116]
              - generic [ref=e117]:
                - generic [ref=e118]: Immigration
                - generic [ref=e119]: Last action Apr 28
            - link "S.J.Res. 139 Heading to a vote Senate moves to restore Colorado's EPA haze plan Environment & energy Last action Apr 28" [ref=e120]:
              - /url: /bills/sjres-139-119
              - generic [ref=e121]:
                - generic [ref=e122]: S.J.Res. 139
                - generic [ref=e123]: ·
                - generic [ref=e124]: Heading to a vote
              - heading "Senate moves to restore Colorado's EPA haze plan" [level=3] [ref=e125]
              - generic [ref=e126]:
                - generic [ref=e127]: Environment & energy
                - generic [ref=e128]: Last action Apr 28
            - link "S.J.Res. 141 Heading to a vote Senate moves to restore CFPB medical debt rules Jobs & the economy Last action Apr 26" [ref=e129]:
              - /url: /bills/sjres-141-119
              - generic [ref=e130]:
                - generic [ref=e131]: S.J.Res. 141
                - generic [ref=e132]: ·
                - generic [ref=e133]: Heading to a vote
              - heading "Senate moves to restore CFPB medical debt rules" [level=3] [ref=e134]
              - generic [ref=e135]:
                - generic [ref=e136]: Jobs & the economy
                - generic [ref=e137]: Last action Apr 26
            - link "S.J.Res. 145 Heading to a vote Senate bill targets CFPB's scrapped credit report rule Jobs & the economy Last action Apr 26" [ref=e138]:
              - /url: /bills/sjres-145-119
              - generic [ref=e139]:
                - generic [ref=e140]: S.J.Res. 145
                - generic [ref=e141]: ·
                - generic [ref=e142]: Heading to a vote
              - heading "Senate bill targets CFPB's scrapped credit report rule" [level=3] [ref=e143]
              - generic [ref=e144]:
                - generic [ref=e145]: Jobs & the economy
                - generic [ref=e146]: Last action Apr 26
            - link "S.J.Res. 149 Heading to a vote Senate moves to restore CFPB contract-for-deed rules Jobs & the economy Last action Apr 26" [ref=e147]:
              - /url: /bills/sjres-149-119
              - generic [ref=e148]:
                - generic [ref=e149]: S.J.Res. 149
                - generic [ref=e150]: ·
                - generic [ref=e151]: Heading to a vote
              - heading "Senate moves to restore CFPB contract-for-deed rules" [level=3] [ref=e152]
              - generic [ref=e153]:
                - generic [ref=e154]: Jobs & the economy
                - generic [ref=e155]: Last action Apr 26
            - link "S.J.Res. 130 Heading to a vote Senate bill would restore CFPB overdraft fee guidance Jobs & the economy Last action Apr 26" [ref=e156]:
              - /url: /bills/sjres-130-119
              - generic [ref=e157]:
                - generic [ref=e158]: S.J.Res. 130
                - generic [ref=e159]: ·
                - generic [ref=e160]: Heading to a vote
              - heading "Senate bill would restore CFPB overdraft fee guidance" [level=3] [ref=e161]
              - generic [ref=e162]:
                - generic [ref=e163]: Jobs & the economy
                - generic [ref=e164]: Last action Apr 26
          - button "Show all 513" [ref=e165]
  - contentinfo [ref=e166]:
    - generic [ref=e167]:
      - paragraph [ref=e168]: The Rostra was the platform in the Roman Forum where any citizen could address the powerful. Step up.
      - paragraph [ref=e169]: "Rostra is free, nonpartisan civic infrastructure. No accounts, no tracking: your data never leaves your device."
      - paragraph [ref=e170]: Bill summaries and scripts are AI-drafted and clearly marked. Always review before you use them.
      - navigation "Footer" [ref=e171]:
        - link "Privacy" [ref=e172]:
          - /url: /privacy
        - link "Terms" [ref=e173]:
          - /url: /terms
        - link "Why call?" [ref=e174]:
          - /url: /why-call
  - alert [ref=e175]
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | 
  3  | test('feed renders capped bands with show-all expansion', async ({ page }) => {
  4  |   await page.goto('/bills');
  5  |   // Bands are populated by honest, decayed urgency - assert the first
  6  |   // rendered band rather than hardcoding which one qualifies today.
  7  |   await expect(page.locator('section[aria-labelledby^=band-] h2').first()).toBeVisible();
  8  |   const before = await page.locator('a[href*="/bills/"]').count();
  9  |   const showAll = page.getByRole('button', { name: /show all/i }).first();
  10 |   await showAll.click();
  11 |   const after = await page.locator('a[href*="/bills/"]').count();
  12 |   expect(after).toBeGreaterThan(before);
  13 | });
  14 | 
  15 | test('search filters and clears', async ({ page }) => {
  16 |   test.slow(); // hydration-gated; needs runway under full parallel load
  17 |   await page.goto('/bills');
  18 |   const search = page.getByRole('searchbox');
  19 |   // The count line is prerendered in static HTML, so it can't prove React is
  20 |   // awake. A nonsense query producing the empty state can: it only renders
  21 |   // after hydration. Retry until that happens, then test the real flow.
  22 |   await expect(async () => {
  23 |     await search.fill('zzzzqqq');
  24 |     await expect(page.getByText(/No bills match/)).toBeVisible({ timeout: 300 });
> 25 |   }).toPass();
     |      ^ Error: expect(locator).toBeVisible() failed
  26 |   await search.fill('veterans');
  27 |   await expect(page.getByText(/No bills match/)).toBeHidden();
  28 |   await search.press('Escape');
  29 |   await expect(search).toHaveValue('');
  30 | });
  31 | 
  32 | test('topic chip filters the feed and persists', async ({ page }) => {
  33 |   await page.goto('/bills');
  34 |   await page.getByRole('button', { name: 'Health care' }).click();
  35 |   await expect(page.getByRole('button', { name: 'Health care' })).toHaveAttribute('aria-pressed', 'true');
  36 |   const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('rostra.prefs') ?? '{}'));
  37 |   expect(prefs.interests).toContain('health');
  38 | });
  39 | 
  40 | test('"/" focuses search on desktop', async ({ page, isMobile }) => {
  41 |   test.skip(!!isMobile, 'keyboard accelerator');
  42 |   await page.goto('/bills');
  43 |   // retry until hydration has attached the listener
  44 |   await expect(async () => {
  45 |     await page.keyboard.press('/');
  46 |     await expect(page.getByRole('searchbox')).toBeFocused({ timeout: 250 });
  47 |   }).toPass();
  48 | });
  49 | 
```