# Meta connect — Studio's own Facebook Login for Business (Phase 18 §2.10)

| | |
| --- | --- |
| **Applies to** | `STUDIO_META_CONNECT=studio` (the default in `STUDIO_MODE=standalone`). In core mode PostMind Core runs the Meta login and pushes tokens; see [platform-account-revocation.md](platform-account-revocation.md). |
| **Owner** | Operator (Meta app settings, App Review), on-call engineer (callbacks, reconnects). |
| **Code** | `platforms/meta-oauth.ts` (login client), `services/meta-connect.ts` (connect, deauthorise, data deletion), `platforms/meta-signed-request.ts`, `app/api/meta/{deauthorize,data-deletion}`, `app/meta/data-deletion` (status page). |

Sources, read 2026-09-29: Facebook Login for Business
(developers.facebook.com/docs/facebook-login/facebook-login-for-business), the manual login flow
(…/facebook-login/guides/advanced/manual-flow), long-lived tokens
(…/facebook-login/guides/access-tokens/get-long-lived), Secure Requests / `appsecret_proof`
(…/graph-api/guides/secure-requests), the data-deletion callback
(…/development/create-an-app/app-dashboard/data-deletion-callback), Instagram content
publishing (…/instagram-platform/content-publishing), Instagram insights
(…/instagram-platform/insights), the Reels Publishing API (…/video-api/guides/reels-publishing),
Page Videos (…/graph-api/reference/page/videos) and video insights
(…/graph-api/reference/video/video_insights).

## How it works

1. **Connect.** On `/connections` the user clicks **Connect with Facebook**
   (`POST /api/studio/platform-connections/oauth-init {platform:"meta", businessId}`). Studio
   stores a single-use state (Redis, 10 minutes) bound to the organisation, the user and the
   business, and sends the browser to
   `https://www.facebook.com/{v}/dialog/oauth?client_id&redirect_uri&state&response_type=code&config_id`.
   Meta's dialog shows the configuration: the user picks which Pages and Instagram accounts to
   share. Meta documents no PKCE for this flow; the server-side state is the CSRF protection.
2. **Callback** (`GET /api/studio/platform-connections/oauth-callback`). The state must be
   unused and unexpired, and the browser's own Studio session must be the user and organisation
   that started it (otherwise `?connection_error=wrong_user`). Studio then, server to server:
   - exchanges the code at `GET graph.facebook.com/{v}/oauth/access_token` (with the app secret);
   - exchanges that token for a long-lived user token (`grant_type=fb_exchange_token`, ~60 days);
   - reads `/me?fields=id,name` (the app-scoped user id), `/me/permissions` (granted scopes) and
     `/me/accounts?fields=id,name,access_token,tasks,instagram_business_account{id,username,name}`.
   Every Graph call carries `appsecret_proof`.
3. **Stored.** Each granted Page (where the user has the `CREATE_CONTENT` task) becomes a
   `facebook` connection and each Instagram professional account linked to it an `instagram`
   connection, with the **Page token** sealed by KMS (`platform_connections.connectedVia='studio'`,
   `metaUserId` = the app-scoped user id). Page tokens obtained from a long-lived user token do
   not expire, so there is no refresh job. The user token is discarded. The browser returns to
   `/connections?connected=meta&count=N`. Nothing publishable granted:
   `?connection_error=meta_no_accounts`.
4. **Publishing and metrics** use the stored Page token on `graph.facebook.com` (Reels, feed
   video, insights) with `appsecret_proof`; `rupload.facebook.com` (Facebook Reels upload) takes
   the token in its `Authorization: OAuth` header as documented.
5. **Revocation** is detected by the daily account-status check (17.3) and by Graph error 190 on
   any call: the connection becomes `needs_reconnect`, its owner is notified, and the Connections
   page offers **Reconnect** (the same login again) and **Disconnect** (tokens wiped).

## Operator: Meta app settings (one-off)

All of these are in the Meta App Dashboard of **Studio's own** app (not Core's).

1. **App type: Business**, with the product **Facebook Login for Business** added. Complete
   **Business Verification** for the business portfolio that owns the app.
2. **App settings → Basic**: note the App ID and App secret → `META_APP_ID`, `META_APP_SECRET`.
   Set **Privacy Policy URL** and **Terms of Service URL** (the `/legal/privacy` and `/legal/terms`
   pages), the app icon and category. **Data Deletion Request URL** (choose "Data deletion
   callback URL"): `https://<host>/api/meta/data-deletion`.
3. **App settings → Advanced → Security**: turn on **Require App Secret** (Studio sends
   `appsecret_proof` on every call). Optionally allow-list the VPS egress IP under **Server IP
   allowlist**.
4. **Facebook Login for Business → Settings**:
   - **Client OAuth login**: on. **Web OAuth login**: on. **Enforce HTTPS**: on.
     **Use Strict Mode for redirect URIs**: on.
   - **Valid OAuth Redirect URIs**: exactly
     `https://<host>/api/studio/platform-connections/oauth-callback` (and the staging host's
     equivalent). If `META_REDIRECT_URI` is set it must equal this entry.
   - **Deauthorize callback URL**: `https://<host>/api/meta/deauthorize`.
5. **Facebook Login for Business → Configurations → Create configuration**:
   - Login variation: **General**. Access token: **User access token** (Studio acts when the
     user presses Publish or schedules a post; the Page tokens it derives do not expire).
     Token expiration: **60 days** (the default for user tokens; Page tokens are unaffected).
   - Assets: **Pages** and **Instagram accounts**.
   - Permissions (all required):

     | Permission | Why |
     | --- | --- |
     | `pages_show_list` | list the Pages the user granted (`/me/accounts`); Reels and Page video publishing |
     | `pages_read_engagement` | required by the Reels Publishing API, Page Videos and Instagram publishing / insights |
     | `pages_manage_posts` | publish Reels and feed videos to the Page |
     | `read_insights` | Page video insights (analytics polling) |
     | `pages_manage_engagement` | optional: the Video Insights reference lists it next to `read_insights`; add it only if Page video insights are refused without it |
     | `instagram_basic` | read the linked Instagram professional account |
     | `instagram_content_publish` | publish Reels / feed videos to Instagram |
     | `instagram_manage_insights` | Instagram media insights (analytics polling) |
     | `business_management` | only if customers' Pages are reached through a business portfolio (Business Manager) role |

     `email` and `public_profile` are granted automatically. If a customer's role on the Page
     comes through a business portfolio, Meta's IG publishing and insights docs also list
     `ads_management` and `ads_read`; add them only if App Review shows such customers.
   - Save → copy the **Configuration ID** → `META_LOGIN_CONFIG_ID`.
6. **App Review**: request **Advanced Access** for every permission above (plus `public_profile`,
   which FLfB apps need before going live). Screencast: Connect → choose a Page and IG account →
   publish a Reel from Studio → analytics page. Until Advanced Access is granted only people with
   a role on the app can connect.
7. **Env** (VPS `/etc/postmind-studio/studio.env`, see `deploy/vps/.env.example`):
   `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID`, `META_GRAPH_VERSION=v26.0` (and
   `META_GRAPH_API_VERSION=v26.0` for the publishers), optional `META_REDIRECT_URI` (defaults to
   `${APP_URL}/api/studio/platform-connections/oauth-callback`). Restart web and workers.
   **Connect with Facebook** appears once all three are set; until then Connections says the
   app still needs its settings (`GET /api/studio/platform-connections` → `meta.configured:false`).

## Callbacks

- `POST /api/meta/deauthorize` — Meta posts `signed_request` when a user removes the app (or a
  Page removes it: `profile_id`). Studio verifies the HMAC-SHA256 signature with the app secret
  (401 if it does not match; nothing is read before that), revokes every Studio-connected Meta
  connection of that user (or that Page) and wipes the tokens. Audit
  `studio.connection.meta_deauthorized` (actor `system:meta-callback`).
- `POST /api/meta/data-deletion` — same verification; revokes, wipes tokens and clears the Meta
  user id, granted scopes and account names, then answers
  `{ "url": "https://<host>/meta/data-deletion?code=…", "confirmation_code": "…" }`. The code is
  alphanumeric and HMAC-signed (issued time + number of connections), so the public status page
  can show the result without storing anything and a made-up code shows "not found". Audit
  `studio.connection.meta_data_deleted`.
- Both answer **404** unless `STUDIO_META_CONNECT=studio` and `META_APP_SECRET` is set, and are
  rate limited per client address (`STUDIO_PUBLIC_RATE_LIMIT_*`). They must not sit behind a
  Cloudflare challenge.
- **Test**: log in to Studio's app with a test user, connect, then on Facebook → Settings →
  Apps and Websites remove the app (deauthorize) and use **View removed apps → Send request**
  (data deletion). Check the rows: `SELECT platform, state, "metaUserId" FROM
  studio.platform_connections WHERE "connectedVia" = 'studio' ORDER BY "connectedAt" DESC LIMIT 10`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `?connection_error=validation_error` right after the dialog | The user cancelled (`error=access_denied`), or the state expired (>10 minutes) or was reused. Connect again. |
| `?connection_error=wrong_user` | The callback reached a browser signed in as someone else (or signed out). Sign in as the user who clicked Connect and start again. |
| `?connection_error=meta_no_accounts` | No Page was shared, or the user lacks the `CREATE_CONTENT` task on the Pages they chose. Ask a Page admin to connect, or grant the task. |
| `?connection_error=platform_error` on the callback | Graph refused the code exchange: redirect URI not listed exactly, wrong app secret, or `config_id` from another app. Check steps 4–5. |
| Every Graph call fails with "appsecret_proof" errors | `META_APP_SECRET` does not match the app (rotated in the dashboard but not in env). |
| Instagram account missing after connect | The IG account is not a professional account, or it is not linked to the Page, or the user did not select it in the dialog. |
| IG publish fails but FB works | Page Publishing Authorization (PPA) pending on the Page, or `instagram_content_publish` lacks Advanced Access. |

## Rotation

Rotate the app secret in the dashboard (App settings → Basic → Reset), update `META_APP_SECRET`
on the VPS and restart web + workers together. Stored Page tokens stay valid; old data-deletion
confirmation codes stop verifying (their status page then shows "not found" — keep a note of the
rotation date for support).
