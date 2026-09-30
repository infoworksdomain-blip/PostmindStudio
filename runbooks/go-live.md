# Go live: from nothing to a live PostMind Studio

| | |
| --- | --- |
| **What** | One ordered, click-by-click guide that takes you from empty accounts to a live Studio site on one Hetzner server. It follows the detailed runbooks and links to them. Where this guide and a detailed runbook differ, the detailed runbook is the reference. |
| **Check** | `npm run setup:check` says READY; `https://<your domain>/api/health/ready` answers 200; you can sign up, pay in Stripe test mode and receive the emails. |
| **Who** | The operator (you). No developer needed, but you will copy a few commands into a terminal. |

## 0. Before you start

### 0.1 How to use this guide

Work from top to bottom. Every step says:

- **Click:** where to go in a website.
- **Copy:** what to copy from there.
- **Paste into:** the exact line of the settings file (the name before the `=`).
- **Check:** how to know it worked.

Words you will meet:

- **Settings file**: a plain text file with one setting per line, `NAME='value'`. Production uses `production.env`; staging uses `staging.env`. On the server they live in `/etc/postmind-studio/`.
- **Secret**: a password-like value (key, token). Write it only into the settings file and your password manager. **Never** paste a secret into a chat, an email, a ticket or this repository. Always put secrets between single quotes: `NAME='value'`.
- **Terminal**: the command window. On Windows use **Git Bash**; on a Mac use **Terminal**. Lines in grey boxes are commands: copy the whole line, paste it, press Enter.
- **Placeholders** look like `<your domain>`. Replace the whole thing, including `<` and `>`.

If a button in a website is not where this guide says, look for a similar name nearby. The guide marks every label it could not confirm in the provider's own documentation with "(may be labelled differently)".

### 0.2 What you need

- Accounts you already have: Hetzner Cloud (with the firewall and the SSH key named `my-laptop`), Cloudflare (with your domain), Stripe, Resend, Google Cloud, Meta for Developers, AWS, GitHub.
- A password manager (for every secret below).
- Your laptop with Git, Node.js 24 and this repository. Once, in the repository folder, run:

```bash
npm install
```

- Your own legal texts (terms and privacy policy at least), written or approved by your lawyer.

### 0.3 Your domain names

Pick the two web addresses now and use them everywhere:

- Production: `studio.<your domain>` (example: `studio.postmind.ai`).
- Staging (later, optional): `studio-staging.<your domain>`.

## 1. Make the settings file

### 1.1 Create the file with the random secrets filled in

- **Click:** nothing; open the terminal in the repository folder.
- **Run** (replace the domain):

```bash
npm run setup:env -- --env production --domain studio.<your domain>
```

- It writes two files into the git-ignored `.secrets/` folder: `.secrets/production.env` and `.secrets/production.backup.env`. It generates the random secrets for you (`POSTGRES_PASSWORD`, `METRICS_TOKEN`, `STUDIO_INTERNAL_SERVICE_TOKEN`, `BETTER_AUTH_SECRET`, `STUDIO_UNSUBSCRIBE_SECRET`, and `PG_BACKUP_CIPHER_PASS` in the backup file) and fills in what is already known: the R2 account id, the bucket names, `STUDIO_ENV`, `STUDIO_MODE=standalone`. It never overwrites an existing file (add `--force` only if you really want to start again; the old secrets are then lost).
- **Copy:** open both files in a text editor. Copy `PG_BACKUP_CIPHER_PASS` into your password manager now: **without it no backup can ever be restored.**
- **Check:** run the checker. It lists everything still missing; that list is your to-do list for the rest of this guide. It never prints a value.

```bash
npm run setup:check -- .secrets/production.env
```

Keep the two files open. Every "Paste into" below means: find that line in `.secrets/production.env` (or the backup file when it says so) and put the value between single quotes.

## 2. Hetzner: the server

Details: [vps-deploy.md](vps-deploy.md) sections 1 and 2.

### 2.1 Check the firewall rules

- **Click:** [Hetzner Console](https://console.hetzner.com) → your project → **Firewalls** (left menu) → open your firewall.
- **Check:** the inbound rules are exactly:
  - TCP **22** (SSH), ideally only from your own IP address;
  - TCP **80** and TCP **443** from any address (the certificate provider must reach port 80);
  - UDP **443** from any address (optional).

  Nothing else inbound. Outbound: leave empty (everything allowed).

### 2.2 Remove the old server (only if it has nothing you need)

- **Click:** **Servers** → the old server → delete it (may be labelled differently). Deleting cannot be undone; skip this if you are not sure what is on it.
- Why: Hetzner only lets you add an SSH key when a server is created ("no longer possible to add an SSH key via the Hetzner Console" afterwards), so the server must be recreated with the key.

### 2.3 Create the server with your SSH key and firewall

- **Click:** **Servers** (left menu) → **Add server**. Choose:
  - **Location:** Falkenstein or Nuremberg (Germany).
  - **Image:** Ubuntu 26.04 (24.04 also works).
  - **Type:** CPX12 (shared x86, 1 vCPU, 2 GB). Not the ARM "CAX" types. If CPX12 is unavailable, pick the next x86 size.
  - **Networking:** public IPv4 on (IPv6 optional).
  - **SSH keys:** tick `my-laptop`.
  - **Firewalls:** tick your firewall.
  - **Backups:** optional (extra cost; see [vps-deploy.md](vps-deploy.md) section 11).
  - **Name:** `postmind-studio-1`.
  - Then **Create & Buy now**.
- **Copy:** the server's IPv4 address (Hetzner: click the address to copy it; the exact panel may be labelled differently).
- **Paste into:** your notes (not the settings file). You need it for DNS and the terminal.
- **Check:** the server shows as running; in your firewall, **Resources** lists the server (if not: firewall → **Resources** → **Apply to** → the server).

## 3. Cloudflare: the web address

Details: [vps-deploy.md](vps-deploy.md) section 3.

### 3.1 Point the domain at the server

- **Click:** [Cloudflare dashboard](https://dash.cloudflare.com) → your domain → **DNS** → **Records** → **Add record**.
  - Type `A`, Name `studio`, IPv4 address = the server's IP, **Proxy status: DNS only** (grey cloud). Save.
  - Delete any older `A`, `AAAA` or `CNAME` record with the name `studio` (for example an old Render one).
- **Paste into:** `STUDIO_DOMAIN` is already `studio.<your domain>` if you used `--domain` in step 1.1. `ACME_EMAIL`: an email address you read (the certificate provider sends expiry warnings there).
- **Check:** after a few minutes, in the terminal: `nslookup studio.<your domain>` shows the server IP.
- Keep it **DNS only** until after the first deploy. Turning on the orange cloud later needs extra steps ([vps-deploy.md](vps-deploy.md) section 3).

## 4. Prepare the server (once)

Details: [vps-deploy.md](vps-deploy.md) sections 4 and 5.

### 4.1 Run the bootstrap

- **Run** on your laptop, in the repository folder (replace `<ip>`):

```bash
scp deploy/vps/bootstrap.sh root@<ip>:/root/
ssh root@<ip> 'bash /root/bootstrap.sh'
```

- It updates the server, creates the `deploy` user with your key, switches on the firewall and automatic security updates, installs Docker, and then turns off root and password logins. From now on you log in as `deploy`.
- **Check:**

```bash
ssh deploy@<ip> 'sudo ufw status; docker compose version'
```

  It shows ports 22, 80, 443 and a Docker Compose version.

### 4.2 Put the code on the server

- **Run:**

```bash
ssh deploy@<ip> 'git clone https://github.com/infoworksdomain-blip/PostmindStudio.git /opt/postmind-studio'
```

  If the repository is private, follow [vps-deploy.md](vps-deploy.md) step 5.1 (a read-only deploy key).

### 4.3 Let the server download the app image

The app arrives as a ready-built image from GitHub. The server needs a read-only GitHub token once.

- **Click:** GitHub → your profile picture → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token** → **Generate new token (classic)**. Note: `studio server image pull`; tick only **read:packages**; **Generate token**.
- **Copy:** the token (shown once).
- **Paste into:** not the settings file. On the server:

```bash
ssh deploy@<ip>
read -rs CR_PAT && echo "$CR_PAT" | docker login ghcr.io -u <your github user> --password-stdin && unset CR_PAT
```

  (after the first line, paste the token and press Enter; nothing is shown while you paste).
- **Check:** it prints `Login Succeeded`.

## 5. Cloudflare R2: file storage

Details: [r2-setup.md](r2-setup.md). All buckets use the **EU jurisdiction**. The jurisdiction cannot be changed after a bucket is created, and EU buckets are reached at `https://<account id>.eu.r2.cloudflarestorage.com`.

The R2 account id is `1ec9cdb965c538b74ce6dd16831dd819` (not a secret). `setup:env` already put it in `R2_ACCOUNT_ID`, with `STORAGE_PROVIDER='r2'` and `R2_JURISDICTION='eu'`.

| Setting | Production | Staging |
| --- | --- | --- |
| `S3_BUCKET_ASSETS` | `eu1prod` | `studio1eu` |
| `S3_BUCKET_RENDERS` | `eu2prod` | `eustudio2` |
| `S3_BUCKET_THUMBNAILS` | `eu3prod` | `eustudio3` |
| `S3_BUCKET_LIBRARY` | `eu4prod` | `eustudio4` |
| `S3_BACKUP_BUCKET` | `eu-backup-prod` | `eu-backup-staging` |
| Corpus source (library import) | `eu-corpus-source` | |

### 5.1 Check the staging buckets

- **Click:** Cloudflare → **R2 object storage** → **Overview**.
- **Check:** `studio1eu`, `eustudio2`, `eustudio3`, `eustudio4` exist and each shows the EU jurisdiction. If one does not, recreate it as in 5.2.

### 5.2 Recreate the production buckets with the EU jurisdiction

- **Click:** **R2 object storage** → **Overview** → open `eu1prod` → delete it (Cloudflare: "To delete a bucket, you must first empty it"). Repeat for `eu2prod`, `eu3prod`, `eu4prod`. Only do this while they hold nothing you need.
- **Click:** **R2 object storage** → **Overview** → **Create bucket** → name `eu1prod` → under **Location** choose **Specify jurisdiction** → **European Union (EU)** (may be labelled differently) → **Create bucket**. Repeat for `eu2prod`, `eu3prod`, `eu4prod`.
- **Check:** each bucket's page shows the EU jurisdiction.
- Do **not** add a bucket lock to any bucket (it stops deletions that the app and GDPR need).

### 5.3 Create the backup and corpus buckets

- **Click:** **Create bucket** as in 5.2, EU jurisdiction, for `eu-backup-prod`, `eu-backup-staging` and (if it does not exist yet) `eu-corpus-source`.
- **Paste into:** `S3_BACKUP_BUCKET` is already `eu-backup-prod` in `production.env`.
- **Check:** the three buckets show the EU jurisdiction.

### 5.4 CORS: let browsers upload into the assets bucket

- **Click:** **R2 object storage** → `eu1prod` → **Settings** → **CORS Policy** → **Add CORS policy** → **JSON** tab. Paste (replace the domain) and **Save**:

```json
[
  {
    "AllowedOrigins": ["https://studio.<your domain>"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

- Staging: the same on `studio1eu` with `https://studio-staging.<your domain>`.
- **Check:** after the first deploy, uploading a video in the app works (without this rule the upload fails with a network error).

### 5.5 Lifecycle rules (automatic clean-up)

Every R2 bucket already has a default rule that aborts unfinished uploads after 7 days. Add two more rules per environment:

- **Click:** `eu1prod` → **Settings** → **Object Lifecycle Rules** → **Add rule**: name `studio-intermediates-expire-30d`, prefix `intermediates/`, delete objects 30 days after upload (field names may be labelled differently) → **Save changes**.
- **Click:** `eu4prod` → **Settings** → **Object Lifecycle Rules** → **Add rule**: name `studio-library-staging-expire-2d`, prefix `library/staging/`, delete after 2 days → **Save changes**.
- Staging: the same on `studio1eu` and `eustudio4`.
- Do **not** add expiry rules to the backup buckets (the backup job manages them).
- **Check:** each rule is listed on the bucket's settings. (A developer can also apply them with `scripts/ops/apply-s3-lifecycle.ts`, [r2-setup.md](r2-setup.md) step 4.)

### 5.6 The four storage tokens

You create four tokens: the app's token and the backup job's token, for production and for staging.

- **Click:** **R2 object storage** → **Overview** → **Account Details** → **API Tokens** → **Manage** → **Create Account API token**.

1. **Production app token.** Name `studio-app-production`. Permission **Object Read & Write**. Scope: only `eu1prod`, `eu2prod`, `eu3prod`, `eu4prod` and `eu-corpus-source`. Create.
   - **Copy:** Access Key ID and Secret Access Key (the secret is shown once).
   - **Paste into:** `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` in `production.env`.
2. **Production backup token.** Name `studio-backup-production`. Permission **Object Read & Write**. Scope: `eu1prod`, `eu2prod`, `eu3prod` and `eu-backup-prod`.
   - **Paste into:** `S3_BACKUP_ACCESS_KEY_ID` and `S3_BACKUP_SECRET_ACCESS_KEY` in `production.backup.env`.
   - This dashboard token could also delete live files; keep it only in the backup file. A tighter token needs the Cloudflare API ([r2-setup.md](r2-setup.md) step 7).
3. **Staging app token.** As 1, scoped to `studio1eu`, `eustudio2`, `eustudio3`, `eustudio4`: goes into `staging.env` (section 17).
4. **Staging backup token.** As 2, scoped to `studio1eu`, `eustudio2`, `eustudio3` and `eu-backup-staging`: goes into `staging.backup.env`.

- Never add a backup bucket to an app token: the app must not be able to read or delete backups.
- **Check:** `npm run setup:check -- .secrets/production.env` no longer lists the R2 and backup keys as missing.

### 5.7 The corpus bucket setting

- **Paste into:** add a line `STUDIO_CORPUS_S3_BUCKETS='eu-corpus-source'` to `production.env` (only needed when you import the reference library; see [corpus-ingestion.md](corpus-ingestion.md)).

## 6. AWS KMS: the encryption key

Studio encrypts stored social-media tokens with a key held in AWS KMS. The app only needs to use that one key.

### 6.1 Create the key

- **Click:** [AWS console](https://console.aws.amazon.com) → top right region selector → pick your region (for example **Europe (London) eu-west-2**) → search **KMS** → **Customer managed keys** → **Create key**.
  - Key type **Symmetric**, key usage **Encrypt and decrypt** → **Next**.
  - **Alias:** `postmind-studio-production` → **Next**.
  - Key administrators: yourself (optional) → **Next**. Key users: **none** (the user in 6.2 gets access through its own policy) → **Next** → **Finish**.
- **Copy:** open the key; copy its **ARN** (`arn:aws:kms:<region>:<account id>:key/<key id>`).
- **Paste into:** `KMS_KEY_ID` (the ARN) and `AWS_REGION` (for example `eu-west-2`).
- Why no key users: the default key policy "allows access to the AWS account and enables IAM policies", so the IAM policy below is enough.

### 6.2 Create the user that may only use this key

- **Click:** search **IAM** → **Users** → **Create user** → User name `postmind-studio-kms` → **Next** → leave permissions empty → **Create user**.
- **Click:** open the user → **Permissions** tab → **Add permissions** → **Create inline policy** → **Policy editor: JSON**. Replace everything with this, putting your key's ARN in `Resource`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "StudioEnvelopeEncryptionOnly",
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "arn:aws:kms:<REGION>:<ACCOUNT_ID>:key/<KEY_ID>"
    }
  ]
}
```

  → **Next** → Policy name `postmind-studio-kms-use` → **Create policy**.
- This follows AWS's example "Allow a user to encrypt and decrypt with specific KMS keys", with `kms:GenerateDataKey` added (Studio creates a data key per secret).

### 6.3 Create the user's access key

- **Click:** the user → **Security credentials** tab → **Access keys** → **Create access key** → use case **Other** (AWS docs; your console may offer a more specific choice such as an application outside AWS) → **Next** → **Create access key**.
- **Copy:** Access key ID and Secret access key (shown once; **Done** hides it forever).
- **Paste into:** `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
- **Check:** `setup:check` shows `AWS_REGION`, `KMS_KEY_ID`, `AWS_ACCESS_KEY_ID` as OK. After the first deploy, connecting a social account works (that is when the key is first used).

## 7. Resend: email

Details: [email-resend.md](email-resend.md).

### 7.1 Add and verify your sending domain

- **Click:** [Resend](https://resend.com) → **Domains** → **Add Domain** → `mail.<your domain>` (Resend recommends a subdomain) → region **eu-west-1 (Ireland)** → add.
- **Copy:** the records on the domain's **Records** tab.
- **Paste into:** Cloudflare → your domain → **DNS** → **Records** → **Add record**, one per record, exactly as Resend shows, all **DNS only**:
  - `TXT` `resend._domainkey.mail` (the DKIM key, `p=…`);
  - `MX` `send.mail` → `feedback-smtp.eu-west-1.amazonses.com`, priority 10;
  - `TXT` `send.mail` → `v=spf1 include:amazonses.com ~all`.
- **Check:** Resend shows the domain as **Verified** (often within 15 minutes, up to 72 hours).
- Then add `TXT` `_dmarc` → `v=DMARC1; p=none; rua=mailto:<a mailbox you read>;` in Cloudflare.
- Leave open and click tracking **off** for this domain (it rewrites the links in password-reset emails).

### 7.2 API key

- **Click:** **API Keys** → **Create API Key** → name `studio-production` → permission **Sending access** → domain `mail.<your domain>` → create.
- **Copy:** the key (starts with `re_`, shown once).
- **Paste into:** `RESEND_API_KEY`.

### 7.3 Sender addresses

- **Paste into:**
  - `STUDIO_EMAIL_FROM='PostMind Studio <no-reply@mail.<your domain>>'`
  - `STUDIO_SUPPORT_EMAIL`: a support address you read (shown in every email footer and on the site).
  - `STUDIO_EMAIL_REPLY_TO`: where replies go (optional).
  - `STUDIO_SALES_EMAIL`: shown for Enterprise enquiries (optional).

### 7.4 Webhook (delivery reports)

- **Click:** **Webhooks** → **Add Webhook** → URL `https://studio.<your domain>/api/email/resend/webhook` → events `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed` → add.
- **Copy:** the signing secret on the webhook's details page (starts with `whsec_`).
- **Paste into:** `RESEND_WEBHOOK_SECRET`.
- **Check:** `setup:check` shows the four email keys OK. After the deploy, the webhook page shows successful deliveries.

## 8. Stripe: payments (test mode first)

Details: [billing-stripe.md](billing-stripe.md). Do everything in **test mode** (Stripe's "sandbox"; keys start `sk_test_`) first. Section 16 repeats it in live mode.

### 8.1 Test API key

- **Click:** [Stripe Dashboard](https://dashboard.stripe.com) → make sure the test/sandbox mode is selected → [API keys](https://dashboard.stripe.com/apikeys) → **Secret key** → reveal.
- **Copy:** the secret key (`sk_test_…`).
- **Paste into:** `STRIPE_SECRET_KEY`.

### 8.2 Create the products and prices (test mode)

- **Run** on your laptop (paste the key when asked; nothing is shown):

```bash
read -rs STRIPE_SECRET_KEY && export STRIPE_SECRET_KEY
npx tsx scripts/billing/seed-stripe-test.ts --dry-run
npx tsx scripts/billing/seed-stripe-test.ts
```

  It refuses live keys.
- **Check:** Stripe → **Product catalogue** (may be labelled differently) shows `studio_basic`, `studio_standard`, `studio_plus`, `studio_enterprise` and the top-up packs, all in GBP.

### 8.3 Customer portal

- **Run** (same terminal, replace the domain):

```bash
APP_URL=https://studio.<your domain> npx tsx scripts/billing/portal-config.ts
```

- **Copy:** the printed id (starts with `bpc_`).
- **Paste into:** `STRIPE_PORTAL_CONFIGURATION_ID`.
- **Check:** Stripe → [customer portal settings](https://dashboard.stripe.com/settings/billing/portal) shows the configuration.

### 8.4 Webhook with its 15 events

- **Click:** Stripe → **Workbench** → **Webhooks** → **Create an event destination** (may be labelled **Create new destination**) → **Your account** → API version **2026-08-26.dahlia** → select these 15 events → **Continue** → **Webhook endpoint** → **Continue** → Endpoint URL `https://studio.<your domain>/api/billing/stripe/webhook` → **Create destination**:
  - `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
  - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `customer.subscription.trial_will_end`
  - `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`
  - `customer.updated`, `charge.refunded`, `charge.dispute.created`
- **Copy:** the signing secret on the destination's page (**Reveal secret**; may be labelled **Click to reveal**), starts `whsec_`.
- **Paste into:** `STRIPE_WEBHOOK_SECRET`.
- **Check:** `setup:check` reminds you that the secret key and webhook secret must come from the same mode (test with test, live with live). After the deploy, the destination shows successful deliveries when you subscribe.

### 8.5 Stripe Tax and UK VAT

- **Click:** [Tax settings](https://dashboard.stripe.com/settings/tax) → confirm the head office address, preset product tax code *Software as a service (SaaS) – business use* (`txcd_10103001`), default tax behaviour **Exclusive** → **Get started**.
- **Click:** Tax → **Locations** tab → **+Add registration** → United Kingdom → **I've already registered** → **Continue** → **Start collecting immediately** → **Continue** → **Start collecting**. Add EU OSS only if you sell to EU consumers.
- **Check:** the Locations tab lists the UK registration as active.

### 8.6 Failed payments (Smart Retries)

- **Click:** Stripe → **Billing** → **Revenue recovery** → [Retries](https://dashboard.stripe.com/revenue_recovery/retries) → Smart Retries on → when all retries fail: **mark the subscription as unpaid** (recommended). Turn on Stripe's customer emails for failed payments and expiring cards (location may be labelled differently).
- **Check:** the page shows Smart Retries enabled and the "unpaid" choice.

### 8.7 Branding

- **Click:** [Branding](https://dashboard.stripe.com/settings/branding): logo, icon, colours. [Public details](https://dashboard.stripe.com/settings/public): support email and website.
- **Check:** a test Checkout page (after the deploy) shows your logo.

## 9. Google: "Continue with Google" sign-in

Optional but recommended. Without it only email and password sign-in is shown. This is a **separate** OAuth client from the YouTube one.

### 9.1 Consent screen (Google Auth Platform)

- **Click:** [Google Cloud console](https://console.cloud.google.com) → your project → menu → **Google Auth Platform** → **Branding** → **Get Started**: app name `PostMind Studio`, support email → **Audience: External** → contact email → **Finish** → **Create**.
- **Click:** **Branding**: add the home page `https://studio.<your domain>`, privacy policy `https://studio.<your domain>/legal/privacy`, terms `https://studio.<your domain>/legal/terms`, and your domain under authorised domains.
- **Click:** **Data Access** → **Add or Remove Scopes**: only `openid`, `email`, `profile` (basic scopes; no app verification needed for them).

### 9.2 OAuth client

- **Click:** **Clients** → **Create Client** → type **Web application** → name `studio-signin` → **Authorised redirect URIs**: `https://studio.<your domain>/api/auth/callback/google` (and later `https://studio-staging.<your domain>/api/auth/callback/google`) → **Create**.
- **Copy:** Client ID and Client secret.
- **Paste into:** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### 9.3 Publish

- **Click:** **Audience** → **Publish app** (move from Testing to In production). In Testing only listed test users can sign in and their sign-ins expire after 7 days.
- Because the consent screen shows your app name, Google asks for brand verification: **Branding** → **Verify Branding** (needs the public home page, the privacy policy on the same domain, and the domain verified in Google Search Console; review can take 2–3 business days) → **Publish branding**.
- **Check:** after the deploy, "Continue with Google" appears on `/sign-in` and signs you in.

## 10. Meta: Facebook and Instagram connect

Details: [meta-connect.md](meta-connect.md). This is **Studio's own** Meta app.

### 10.1 The app

- **Click:** [Meta for Developers](https://developers.facebook.com/apps) → your app. If you still need to create it: **Create app** → app details → use cases (choose the one that includes **Facebook Login for Business**; Meta's current flow is use-case based and older docs call this a "Business" app, so the wording may be labelled differently) → your business portfolio → **Go to dashboard**.
- Complete **Business Verification** for the business portfolio (**Settings** → **Basic** → **Verification** → **Start Verification**; may be labelled differently).

### 10.2 Basic settings

- **Click:** **App settings** → **Basic**.
- **Copy:** App ID and App secret (**Show**).
- **Paste into:** `META_APP_ID` and `META_APP_SECRET`.
- **Fill in on that page:** Privacy Policy URL `https://studio.<your domain>/legal/privacy`, Terms of Service URL `https://studio.<your domain>/legal/terms`, User data deletion: callback URL `https://studio.<your domain>/api/meta/data-deletion`, icon, category → **Save changes**.

### 10.3 Security

- **Click:** **App settings** → **Advanced** → **Security** → turn on **Require App Secret** → **Save changes**.

### 10.4 Login settings

- **Click:** **Facebook Login for Business** → **Settings** (may be labelled **Facebook Login** → **Settings**):
  - Client OAuth login **on**, Web OAuth login **on**, Enforce HTTPS **on**, Use Strict Mode for redirect URIs **on**.
  - Valid OAuth Redirect URIs: `https://studio.<your domain>/api/studio/platform-connections/oauth-callback` (and the staging one later).
  - Deauthorize callback URL: `https://studio.<your domain>/api/meta/deauthorize`.
  - **Save changes**.

### 10.5 Configuration and permissions

- **Click:** **Facebook Login for Business** → **Configurations** → **+ Create configuration**: login variation **General**, token **User access token**, expiry **60 days**, assets **Pages** and **Instagram accounts**, permissions `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights` (and `business_management` only if customers reach Pages through a business portfolio) → **Create**.
- **Copy:** the Configuration ID.
- **Paste into:** `META_LOGIN_CONFIG_ID`.

### 10.6 App Review and live mode

- **Click:** **App Review** → **Permissions and Features**: request **Advanced Access** for each permission above and `public_profile` → **Submit for Review**, with a screencast: Connect → choose a Page and Instagram account → publish a Reel → the analytics page. Until approved, only people with a role on the app can connect.
- After approval: switch the **App Mode** toggle (top bar) to **Live**.
- **Check:** after the deploy, `/connections` shows **Connect with Facebook** (it stays hidden until `META_APP_ID`, `META_APP_SECRET` and `META_LOGIN_CONFIG_ID` are all set).

## 11. The other providers

The video, voice and publishing providers each need a key. Where each comes from is in [vps-deploy.md](vps-deploy.md) section 6 and [render-deploy.md](render-deploy.md) step 4.

- **Paste into:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_DEFAULT_VOICE_ID`, `SHOTSTACK_API_KEY`, `HIVE_API_KEY`, `ASSEMBLYAI_API_KEY`, `STUDIO_FONTS_BASE_URL`, `TIKTOK_CLIENT_KEY`/`_SECRET`, `YOUTUBE_CLIENT_ID`/`_SECRET`, `X_CLIENT_ID`/`_SECRET`, `LINKEDIN_CLIENT_ID`/`_SECRET`.
- In the TikTok, YouTube (Google), X and LinkedIn developer portals register the redirect `https://studio.<your domain>/api/studio/platform-connections/oauth-callback?platform=<tiktok|youtube|x|linkedin>`.
- Optional: `OPS_ALERT_WEBHOOK_URL` (a Slack incoming webhook for server alerts), `SENTRY_DSN` (error reports).

## 12. Legal texts

Details: [vps-deploy.md](vps-deploy.md) "Legal documents".

### 12.1 Fill in the drafts and have them reviewed

- The site shows `content/legal/en-GB/terms.md`, `privacy.md`, `cookies.md`, `acceptable-use.md`, `dpa.md` and `subprocessors.md`. The repository ships **complete drafts** of all six (UK law, written from what Studio actually does). Only two things remain: your company details and a solicitor's review.
- Each draft contains fill-in markers in double square brackets, for example `[[COMPANY LEGAL NAME]]`, `[[COMPANY NUMBER]]`, `[[REGISTERED ADDRESS]]`, `[[ICO REGISTRATION NUMBER]]`, `[[CONTACT EMAIL]]`, `[[PRIVACY EMAIL]]` and `[[DPO OR PRIVACY LEAD]]`. `content/legal/FILL-IN.md` lists every marker, the files it appears in and where to find the value (Companies House for the company name, number and address; the [ICO register of fee payers](https://ico.org.uk/ESDWebPages/Search) for the ICO number).
- **Public sign-up stays closed in production** while the Terms of Service or the Privacy Policy still contains a marker; the other four show a "draft" banner and a warning in the Admin Centre until they are filled in.
- **Click:** GitHub → the repository → `content/legal/en-GB/terms.md` → the pencil (**Edit this file**; may be labelled differently) → replace every `[[…]]` marker with your details (keep the rest) → **Commit changes** → create a branch and open a pull request → merge it once the checks are green. Repeat for the other five. Translations are optional (`content/legal/fr/terms.md` and so on).
- Have a qualified solicitor (England and Wales) review all six texts before launch. If you change a retention or trial setting (`STUDIO_CANCELLED_RETENTION_DAYS`, `STUDIO_PURGE_GRACE_DAYS`, `STUDIO_TRIAL_DAYS` and the others in `FILL-IN.md`), change the text to match.
- **Paste into:** `STUDIO_LEGAL_ENTITY_NAME` (your company's legal name, shown in the footer; use the same value as `[[COMPANY LEGAL NAME]]`).
- **Check:** on your laptop, after `git pull`: `npx tsx scripts/legal/check-ready.ts` lists every document as `ok` (a `FILL-IN` line names the markers still left), and `npm run setup:check -- .secrets/production.env` shows `OK legal texts`. The texts are built into the app image, so they go live with the next deploy of that commit.
- If you must launch before the texts are ready, set `STUDIO_SIGNUPS_ENABLED='false'` (invite-only).

## 13. Check the settings and copy them to the server

### 13.1 Final check

- **Run:**

```bash
npm run setup:check -- .secrets/production.env
```

- **Check:** the last line says **READY** and the exit is clean. Fix every `MISSING` and `WRONG` line; read every `CHECK` line (reminders, for example that you are still on Stripe test keys).

### 13.2 Copy to the server

- **Run:**

```bash
scp .secrets/production.env .secrets/production.backup.env deploy@<ip>:/etc/postmind-studio/
ssh deploy@<ip> 'chmod 600 /etc/postmind-studio/*.env'
```

- Make sure every secret is in your password manager, then delete the two files from your laptop.

## 14. First deploy and the checks after it

Details: [vps-deploy.md](vps-deploy.md) section 7 and [deploy.md](deploy.md).

### 14.1 Deploy

- **Click:** GitHub → the repository → **Actions** → **CI** → the latest green run on `main` (its `publish-image` job succeeded). **Copy:** the full commit id (SHA).
- **Run:**

```bash
ssh deploy@<ip>
cd /opt/postmind-studio && git pull
bash scripts/vps/deploy.sh <sha>
sudo bash scripts/vps/install-timers.sh production
```

- `deploy.sh` checks the settings again, starts the database, backups, web and worker, gets the HTTPS certificate and waits until the site answers. It stops at the first problem and says which setting is wrong.

### 14.2 Checks

- `https://studio.<your domain>/api/health/ready` in a browser shows a success answer (HTTP 200).
- On the server:

```bash
bash scripts/vps/healthcheck.sh production
bash scripts/vps/compose.sh production ps
bash scripts/vps/backup.sh production db --type full
bash scripts/vps/backup.sh production info
```

  The health check says OK, every service is healthy, the first full backup succeeds and is listed.
- In a private browser window: `/`, `/pricing` and `/sign-up` load.
- Stripe test: sign up, choose a plan, pay with Stripe's test card `4242 4242 4242 4242`; the Stripe webhook shows deliveries and the plan appears under Settings → Billing.
- Email: the sign-up verification email arrives; Resend shows it delivered.
- Upload a video (checks the CORS rule of 5.4).
- Add an external uptime check of `https://studio.<your domain>/api/health/ready` with any monitoring service outside Hetzner ([vps-deploy.md](vps-deploy.md) section 10).

## 15. The first superadmin

Details: [auth.md](auth.md). There is no default password.

- **Run** on the server (use your own address):

```bash
bash scripts/vps/compose.sh production run --rm ops node --import tsx scripts/auth/create-superadmin.ts --email <you@your domain>
```

- It creates your staff account (or promotes an existing one) and emails a set-password link.
- **Click:** the link in the email → set a password → sign in → `/account/security` → turn on two-step verification. Staff tools are locked until it is on.
- **Check:** `/admin` opens and shows no legal-readiness warning.

## 16. Switch Stripe to live mode

Do this once the test run in 14.2 works.

1. **Activate the account:** [Stripe onboarding](https://dashboard.stripe.com/account/onboarding): verify your business and bank details.
2. **Switch the Dashboard to live mode**, then repeat in live mode:
   - products and prices by hand, exactly as the table in [billing-stripe.md](billing-stripe.md) section 1 (GBP, tax behaviour exclusive, the exact **lookup keys**, product metadata `studio_tier`); the seed script only works in test mode;
   - 8.3 portal configuration (run `portal-config.ts` with the **live** key) → new `STRIPE_PORTAL_CONFIGURATION_ID`;
   - 8.4 webhook destination → new `STRIPE_WEBHOOK_SECRET`;
   - 8.5 tax, 8.6 retries and 8.7 branding if they are not shared with test mode.
3. **Paste into** the server's `/etc/postmind-studio/production.env` (edit with `nano`): the live `sk_live_…` in `STRIPE_SECRET_KEY`, and the live webhook secret and portal id. Change the key **and** the webhook secret together.
4. Run the checker against a copy on your laptop (or re-check each line), then redeploy the **same** SHA: `bash scripts/vps/deploy.sh <current sha>`.
5. **Check:** buy the cheapest plan with a real card, see it in Stripe live mode and in Studio, then refund and cancel it.

## 17. Switching on staging

Details: [vps-deploy.md](vps-deploy.md) section 9. On the 2 GB server run staging only while you test.

1. **Cloudflare:** an `A` record `studio-staging` → the same server IP, DNS only.
2. **Settings:** `npm run setup:env -- --env staging --domain studio-staging.<your domain>`. It fills in the staging buckets, `SHOTSTACK_ENVIRONMENT='stage'`, the staging ports and the smaller memory sizes. Fill it as in sections 5–11 with **test** keys only (Stripe `sk_test_`, a separate Stripe test webhook for the staging address, the staging R2 tokens from 5.6). `ACME_EMAIL` is read from the production file. Then `npm run setup:check -- .secrets/staging.env`.
3. **Copy:** `scp .secrets/staging.env .secrets/staging.backup.env deploy@<ip>:/etc/postmind-studio/` and `chmod 600` as in 13.2.
4. **Deploy:** on the server `bash scripts/vps/deploy.sh --env staging <sha>` and `sudo bash scripts/vps/install-timers.sh staging`.
5. **Switch off** after testing: `bash scripts/vps/deploy.sh --env staging --stop` and `sudo bash scripts/vps/install-timers.sh staging --remove` (data is kept).

## 18. Troubleshooting

| What you see | What to do |
| --- | --- |
| `setup:check` says `MISSING` | The line is empty: find the step above that names that setting. |
| `setup:check` says `WRONG` | The reason says what shape is expected (for example "must start with re_"). Copy the value again; check you did not include spaces or the quotes of the website. |
| `deploy.sh` stops with `… in /etc/postmind-studio/production.env: …` | Same as above, on the server file. |
| The site is not reachable | DNS not pointing at the server yet, port 80 closed in the Hetzner firewall, or the Cloudflare record is proxied (orange) before the first certificate. |
| Uploads fail with a network error | The CORS rule of 5.4 is missing or has a different domain. |
| Sign-up says it is not open yet | Terms or privacy are still placeholders (section 12), or `STUDIO_SIGNUPS_ENABLED='false'`. |
| No emails arrive | Resend domain not verified yet, or `STUDIO_EMAIL_FROM` is not on the verified domain. |

## Sources

Every page below was read on 2026-09-29. Labels the documentation did not confirm are marked "(may be labelled differently)" above.

- Hetzner: [creating a server](https://docs.hetzner.com/cloud/servers/getting-started/creating-a-server/), [server FAQ](https://docs.hetzner.com/cloud/servers/faq/), [creating a firewall](https://docs.hetzner.com/cloud/firewalls/getting-started/creating-a-firewall/), [firewall FAQ](https://docs.hetzner.com/cloud/firewalls/faq/), [connecting to the server](https://docs.hetzner.com/cloud/servers/getting-started/connecting-to-the-server/).
- Cloudflare: [create DNS records](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/), [proxy status](https://developers.cloudflare.com/dns/proxy-status/), [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/), [R2 create buckets](https://developers.cloudflare.com/r2/buckets/create-buckets/), [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/), [R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/), [R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/), [find account and zone IDs](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/).
- GitHub: [managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
- AWS: [create a symmetric KMS key](https://docs.aws.amazon.com/kms/latest/developerguide/create-symmetric-cmk.html), [default key policy](https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-default.html), [KMS IAM policy examples](https://docs.aws.amazon.com/kms/latest/developerguide/customer-managed-policies.html), [IAM users for workloads](https://docs.aws.amazon.com/IAM/latest/UserGuide/getting-started-workloads.html), [adding IAM policies](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_manage-attach-detach.html), [creating policies in the console](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_create-console.html), [managing access keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/access-keys-admin-managed.html).
- Stripe: [API keys](https://docs.stripe.com/keys), [sandboxes](https://docs.stripe.com/sandboxes), [webhooks](https://docs.stripe.com/webhooks), [event destinations](https://docs.stripe.com/workbench/event-destinations), [Tax set-up](https://docs.stripe.com/tax/set-up), [Tax registrations](https://docs.stripe.com/tax/registering), [Smart Retries](https://docs.stripe.com/billing/revenue-recovery/smart-retries), [no-code customer portal](https://docs.stripe.com/customer-management/activate-no-code-customer-portal), [activate your account](https://docs.stripe.com/get-started/account/activate).
- Resend: [add a domain](https://resend.com/docs/add-a-domain), [regions](https://resend.com/docs/dashboard/domains/regions), [Cloudflare DNS](https://resend.com/docs/knowledge-base/cloudflare), [API keys](https://resend.com/docs/dashboard/api-keys/introduction), [create a webhook](https://resend.com/docs/webhooks/create-webhook), [verify webhooks](https://resend.com/docs/webhooks/verify-webhooks-requests), [event types](https://resend.com/docs/webhooks/event-types).
- Google: [configure the OAuth consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent), [OAuth for web server apps](https://developers.google.com/identity/protocols/oauth2/web-server), [publishing status](https://support.google.com/cloud/answer/15549945), [brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification).
- Meta: [create an app](https://developers.facebook.com/docs/development/create-an-app/), [Facebook Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business/), [login security](https://developers.facebook.com/docs/facebook-login/security/), [basic settings](https://developers.facebook.com/docs/development/create-an-app/app-dashboard/basic-settings), [advanced settings](https://developers.facebook.com/docs/development/create-an-app/app-dashboard/advanced-settings), [App Review submission](https://developers.facebook.com/docs/app-review/submission-guide), [business verification](https://developers.facebook.com/docs/development/release/business-verification), [app modes](https://developers.facebook.com/docs/development/build-and-test/app-modes).
