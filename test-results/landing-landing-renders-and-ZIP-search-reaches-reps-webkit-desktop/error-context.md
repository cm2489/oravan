# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: landing.spec.ts >> landing renders and ZIP search reaches reps
- Location: tests/landing.spec.ts:3:5

# Error details

```
Error: expect(page).toHaveURL(expected) failed

Expected pattern: /\/reps\?zip=78501/
Received string:  "http://localhost:3300/"
Timeout: 5000ms

Call log:
  - Expect "toHaveURL" with timeout 5000ms
    14 × unexpected value "http://localhost:3300/"

```

```yaml
- link "Skip to main content":
  - /url: "#main"
- banner:
  - link "Rostra":
    - /url: /
  - navigation "Primary":
    - link "Home":
      - /url: /
    - link "Bills":
      - /url: /bills
    - link "My reps":
      - /url: /reps
    - link "My impact":
      - /url: /impact
    - link "Why call?":
      - /url: /why-call
  - link "En español":
    - /url: /es
- main:
  - heading "Congress counts calls." [level=1]
  - paragraph: Make yours count in under 5 minutes. Find your representatives, understand the bills that touch your life in plain language, and say your piece. No account. No app. Just you and the phone.
  - text: Your ZIP code
  - textbox "Your ZIP code":
    - /placeholder: e.g. 20002
  - button "Find my representatives"
  - alert: That doesn't look like a US ZIP code. Try 5 digits.
  - region "Worth a call this week":
    - heading "Worth a call this week" [level=2]
    - paragraph: The bills moving right now, decoded into plain language by AI.
    - link "Browse all 522 active bills":
      - /url: /bills
    - link "H.R. 1993 Passed one chamber Commemorative coins planned for 9/11's 25th anniversary Jobs & the economy Last action May 20":
      - /url: /bills/hr-1993-119
      - text: H.R. 1993 Passed one chamber
      - heading "Commemorative coins planned for 9/11's 25th anniversary" [level=3]
      - text: Jobs & the economy Last action May 20
    - link "H.R. 7343 Heading to a vote Bill expands foster youth education and training aid Jobs & the economy Last action May 10":
      - /url: /bills/hr-7343-119
      - text: H.R. 7343 Heading to a vote
      - heading "Bill expands foster youth education and training aid" [level=3]
      - text: Jobs & the economy Last action May 10
    - link "H.R. 7995 Heading to a vote Bill adds mentoring goals to federal foster care program Family & community Last action May 10":
      - /url: /bills/hr-7995-119
      - text: H.R. 7995 Heading to a vote
      - heading "Bill adds mentoring goals to federal foster care program" [level=3]
      - text: Family & community Last action May 10
    - link "H.R. 7529 Heading to a vote States could use Chafee funds for foster youth legal aid Family & community Last action May 10":
      - /url: /bills/hr-7529-119
      - text: H.R. 7529 Heading to a vote
      - heading "States could use Chafee funds for foster youth legal aid" [level=3]
      - text: Family & community Last action May 10
  - region "How it works":
    - heading "How it works" [level=2]
    - list:
      - listitem:
        - text: "1"
        - heading "Find your three" [level=3]
        - paragraph: Your ZIP code finds your House representative and two senators, with their DC and local office numbers.
      - listitem:
        - text: "2"
        - heading "Pick a bill, get the plain version" [level=3]
        - paragraph: Every active bill is decoded from legal language into words a neighbor would use.
      - listitem:
        - text: "3"
        - heading "Get your script" [level=3]
        - paragraph: Tell us where you stand and get a 30-second script. Edit it until it sounds like you.
      - listitem:
        - text: "4"
        - heading "Call, or leave a voicemail" [level=3]
        - paragraph: Offices tally voicemails the same as live calls. After hours works too. Then log how it went.
  - heading "Does calling actually work?" [level=2]
  - paragraph: Yes, and better than email, petitions, or posts. Congressional staff tally calls daily and report the counts to the member.
  - link "Read why calling works":
    - /url: /why-call
  - heading "Built for your safety" [level=2]
  - paragraph: No sign-up, no cookies that follow you, no political profile stored on any server. Everything personal lives in your browser, and you can erase it with one tap.
  - link "Read our privacy promise":
    - /url: /privacy
- contentinfo:
  - paragraph: The Rostra was the platform in the Roman Forum where any citizen could address the powerful. Step up.
  - paragraph: "Rostra is free, nonpartisan civic infrastructure. No accounts, no tracking: your data never leaves your device."
  - paragraph: Bill summaries and scripts are AI-drafted and clearly marked. Always review before you use them.
  - navigation "Footer":
    - link "Privacy":
      - /url: /privacy
    - link "Terms":
      - /url: /terms
    - link "Why call?":
      - /url: /why-call
- alert
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | 
  3  | test('landing renders and ZIP search reaches reps', async ({ page }) => {
  4  |   await page.goto('/');
  5  |   await expect(page.getByRole('heading', { level: 1 })).toContainText('Congress counts calls');
  6  |   await page.getByLabel('Your ZIP code').fill('78501');
  7  |   await page.getByRole('button', { name: /find my representatives/i }).click();
> 8  |   await expect(page).toHaveURL(/\/reps\?zip=78501/);
     |                      ^ Error: expect(page).toHaveURL(expected) failed
  9  |   await expect(page.getByText('Monica De La Cruz')).toBeVisible();
  10 | });
  11 | 
  12 | test('no horizontal overflow on either landing locale', async ({ page }) => {
  13 |   for (const path of ['/', '/es']) {
  14 |     await page.goto(path);
  15 |     const overflow = await page.evaluate(
  16 |       () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  17 |     );
  18 |     expect(overflow, `${path} must not scroll horizontally`).toBeLessThanOrEqual(0);
  19 |   }
  20 | });
  21 | 
  22 | test('spanish landing is fully localized', async ({ page }) => {
  23 |   await page.goto('/es');
  24 |   await expect(page.getByRole('heading', { level: 1 })).toContainText('El Congreso cuenta las llamadas');
  25 |   await expect(page.getByLabel('Tu código postal')).toBeVisible();
  26 | });
  27 | 
  28 | test('footer privacy link is reachable and clickable on mobile', async ({ page, isMobile }) => {
  29 |   test.skip(!isMobile, 'regression guard for the mobile tab-bar overlap');
  30 |   await page.goto('/');
  31 |   const link = page.locator('footer').getByRole('link', { name: 'Privacy' });
  32 |   await link.scrollIntoViewIfNeeded();
  33 |   await link.click();
  34 |   await expect(page).toHaveURL(/\/privacy/);
  35 | });
  36 | 
```