# InAir Meta Lead Dashboard — Netlify setup

A live dashboard for the InAir / InVac Meta campaigns:

- **Meta Ads:** spend, leads, cost per lead, campaigns, ads, cities and the daily and monthly trend.
- **Zoho CRM:** lead status and quality, plus whether each campaign's leads are reaching Zoho.
- **ERPNext:** what the leads became (quotes, won orders, order value).

The team signs in with one shared password.

## How it works

```
Browser (you / team)
   │  team password → secure cookie
   ▼
Netlify site ── public/index.html, login.html (the dashboard page; contains no data and no keys)
   │
   ├─ /api/data          → Meta Marketing API + Zoho CRM, live on every load / refresh (cached 2 min)
   ├─ /api/erpnext-sync  → background job: matches Zoho leads to ERPNext by phone, stores the monthly table
   ├─ nightly (2:00 am IST) starts /api/erpnext-sync
   └─ /api/login, /api/logout
```

**Where things are kept:**
- All keys live only in Netlify's environment variables, on the server side.
- Phone numbers are used in memory during the ERPNext match and are never stored. Only the monthly summary table is kept.

**When the data refreshes:**
- **Meta and Zoho:** live. The page loads them when opened, refreshes every 10 minutes while the tab is open, and refreshes again on **↻ Refresh data**.
- **ERPNext:** rebuilt every night at 2 am, or on **Update ERPNext**, which takes a few minutes.

---

## 1. Put the project on Netlify

**Option A (recommended): GitHub**
1. Create a **private** GitHub repository and upload this folder's contents.
2. In Netlify, choose **Add new site → Import an existing project**, then pick the repository.
3. Leave the build settings as they are. `netlify.toml` already sets them.

**Option B: Netlify CLI**
```bash
npm install -g netlify-cli
cd inair-lead-dashboard
npm install
netlify login
netlify init          # create a new site
netlify deploy --prod
```

Netlify's drag-and-drop upload won't work for this project, because it doesn't deploy the server functions.

## 2. Add the environment variables

In Netlify, go to **Site configuration → Environment variables** and add these, then redeploy.

| Variable | Value |
|---|---|
| `DASH_PASSWORD` | The team password, long and unique. |
| `SESSION_SECRET` | 32+ random characters, for example from `openssl rand -hex 32`. Changing it signs everyone out. |
| `META_TOKEN` | Meta system-user token with `ads_read` (see 3a). |
| `META_AD_ACCOUNT` | `595722941743303` |
| `ZOHO_CLIENT_ID` | From the Zoho API console (see 3b). |
| `ZOHO_CLIENT_SECRET` | From the Zoho API console. |
| `ZOHO_REFRESH_TOKEN` | From step 3b. |
| `ZOHO_DC` | `in`. Use `com` or `eu` if your Zoho account is in another data centre. |
| `ERP_URL` | `https://portal.incygys.in` |
| `ERP_API_KEY` | From the read-only ERPNext user (see 3c). |
| `ERP_API_SECRET` | From the read-only ERPNext user. |
| `META_API_VERSION` | Optional. Default `v23.0`. Raise it when Meta retires that version. |
| `ZOHO_LEAD_SOURCES` | Optional. Default `Meta Ads,Facebook Ads` (the agency 3DM campaigns arrive as Facebook Ads), as a comma-separated list. |
| `MATCH_FROM` | Optional. Default `2024-01-01`, the earliest Zoho lead date used in the ERPNext match. |
| `META_DATASET_ID` | For sending lead outcomes to Meta (section 6): the CRM data source ID from Events Manager. |
| `META_CAPI_TOKEN` | For section 6: the Conversions API access token generated in that data source's Settings. |
| `META_CAPI_TEST_CODE` | Optional, only while testing (section 6). Remove it to go live. |

## 3. Get the keys (read-only everywhere)

### 3a. Meta token
1. Go to **developers.facebook.com → My Apps → Create app**, choose type **Business**, and link it to the Incygys business.
2. Go to **business.facebook.com → Business settings → Users → System users → Add**, with the role **Employee**.
3. Under **Assign assets → Ad accounts**, select account `595722941743303` and give it **View performance** only.
4. Under **Generate new token**, pick the app, choose expiry **Never**, and tick the permission **`ads_read`** only.
5. Copy the token into `META_TOKEN`.

The lead forms are currently under an individual's profile. Moving them to the company Page doesn't affect this token.

### 3b. Zoho refresh token
1. Go to **api-console.zoho.in → Add client → Self Client** and copy the Client ID and Client Secret.
2. On the **Generate code** tab, enter the scope `ZohoCRM.coql.READ,ZohoCRM.modules.leads.READ`, set the duration to 10 minutes, and copy the code.
3. Within 10 minutes, run:
   ```bash
   curl -X POST "https://accounts.zoho.in/oauth/v2/token?grant_type=authorization_code&client_id=CLIENT_ID&client_secret=CLIENT_SECRET&code=CODE"
   ```
4. Copy `refresh_token` from the reply into `ZOHO_REFRESH_TOKEN`. It doesn't expire unless it's revoked.

### 3c. ERPNext API key
1. In ERPNext, create a user such as `dashboard@incygys.in` with **read-only** access to **Lead, Opportunity, Customer and Sales Order**. A custom role with Read only is cleanest. Don't give it any write, submit or delete rights.
2. Open that user and choose **Settings → API Access → Generate Keys**.
3. Copy the API Key and API Secret into `ERP_API_KEY` and `ERP_API_SECRET`.

## 4. First run
1. Open the site and sign in with `DASH_PASSWORD`.
2. Meta and Zoho figures load straight away.
3. The ERPNext table shows the 27 Oct 2026 starting figures. Press **Update ERPNext** once to build it from live data.
4. Share the site address and the password with the team.

## 5. If something shows "Failed to load"
- **Meta:** check that `META_TOKEN` still has `ads_read` on account 595722941743303. If Meta says the API version is too old, raise `META_API_VERSION`.
- **Zoho:** check the data centre (`ZOHO_DC`) and that the refresh token's scopes include `coql.READ`.
- **ERPNext:** the status line under the ERPNext table shows the last error. Check that the read-only user can open the four document types.
- **Function logs:** go to **Netlify → Logs → Functions** and look at `data` or `erpnext-sync`.

## 6. Send lead outcomes to Meta (Conversions API for CRM)

Every hour (at :20) the site reads Meta leads in Zoho whose status changed and sends their stage to Meta:

| Zoho status | Stage sent |
|---|---|
| Any new Meta lead | Lead |
| Future, NEW LEAD FUTURE | Contacted |
| Prospect, Opportunity WARM/HOT, Waiting for Floor Plan, AR/ ID | Qualified |
| Price Quotation Shared, Negotiation | Quotation |
| Booked | Won |
| Un Qualified, FULLY BUILD, CASUAL ENQUARY, BUDGET ISSUE, WRONG PROUDUCT, Lost, Dealers | Disqualified |

- Earlier stages are sent too when a lead jumps ahead (Incoming → Opportunity HOT sends Contacted and Qualified).
- Each stage goes once per lead. Events older than 7 days, and leads older than 28 days, are not sent (Meta discards them).
- The Meta lead ID is sent when Zoho has it (`leadchain0__Social_Lead_ID`), plus the phone and email, hashed with SHA-256.
- Zoho is only read. Nothing else is stored apart from which stages were sent.

**Turn it on:** add `META_DATASET_ID` and `META_CAPI_TOKEN`, redeploy. Until both are set, the hourly job does nothing.

**Check it (signed in):**
- `/api/capi`: last runs and stages sent so far.
- `/api/capi?dry=1`: the events the next run would send. Nothing is sent.
- Run it now: open the browser console on the dashboard and run `fetch('/api/capi', {method: 'POST'}).then(r => r.json()).then(console.log)`.

**Testing first:** set `META_CAPI_TEST_CODE` to the code shown in Events Manager → Test events. Events then show up there only (a sample of up to 50 per run, and nothing is marked as sent). Remove the variable to go live; the same leads are then sent for real.

## Files
```
netlify.toml                      build + security headers
public/index.html                 dashboard (InAir brand)
public/login.html                 team sign-in
netlify/functions/data.mjs        live data endpoint
netlify/functions/login.mjs       sign in / out
netlify/functions/erpnext-sync.mjs  background ERPNext match
netlify/functions/nightly.mjs     2 am IST schedule
netlify/functions/capi-hourly.mjs hourly: lead stages to Meta
netlify/functions/capi.mjs        /api/capi status, preview and run now
netlify/lib/capi.mjs              Zoho status → Meta stage, sending, de-duplication
netlify/lib/*.mjs                 Meta, Zoho, ERPNext, auth helpers
```
