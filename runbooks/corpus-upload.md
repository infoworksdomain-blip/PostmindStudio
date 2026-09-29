# Corpus upload: from the hard drive to Studio's library (Phase 19)

This runbook gets the 50,000 reference videos from the operator's hard drive into Cloudflare R2,
then into Studio's library. The ingest itself is [corpus-ingestion.md](corpus-ingestion.md); this
runbook ends by handing over to it.

| | |
| --- | --- |
| **Who** | **Operator**: plugs in the drive, clicks in the Cloudflare dashboard, pastes the key into Notepad, reviews. **Engineer** (the lead): runs every command. |
| **Where** | The operator's Windows 10 PC (the drive is plugged in there), with this repository checked out and `npm install` done. |
| **Bucket** | `eu-corpus-source`, EU jurisdiction, keys under `videos/`. Temporary: deleted after the ingest (step 17). |
| **Time** | The scan prints the upload time for 10, 50 and 100 Mbit/s. Leave the PC on for that long. |
| **Cost** | The scan prints it. At $0.015 per GB-month after the free 10 GB, 2 TB is about $30 a month; uploads and downloads cost nothing at this size ([R2 pricing](https://developers.cloudflare.com/r2/pricing/), read 2026-09-29). |

Sources (read 2026-09-29): [rclone Cloudflare R2](https://rclone.org/s3/#cloudflare-r2),
[rclone install](https://rclone.org/install/), [rclone flags](https://rclone.org/docs/),
[rclone filtering](https://rclone.org/filtering/),
[rclone check](https://rclone.org/commands/rclone_check/),
[rclone local file names](https://rclone.org/local/),
[R2 tokens](https://developers.cloudflare.com/r2/api/tokens/),
[R2 data location](https://developers.cloudflare.com/r2/reference/data-location/),
[R2 delete buckets](https://developers.cloudflare.com/r2/buckets/delete-buckets/).

In the commands below, `E:\Videos` stands for the folder on the drive that holds the videos.
Use the real drive letter and folder. Commands run in **PowerShell** from the repository folder.

## What the tools do

| Tool | Does | Changes |
| --- | --- | --- |
| `npm run corpus:scan` | Counts the videos, finds files Studio would refuse, duplicates and awkward names, estimates time and cost, writes the **upload list**. | Nothing on the drive. Writes only the files you name, and refuses to write them inside the video folder. |
| `npm run corpus:rclone-config` | Writes the **env file** template, then the **rclone config** from it. | Two files in your user folder. The secret is never printed. |
| `scripts\corpus\upload.ps1` (or `upload.sh`) | Copies exactly the files in the upload list to the bucket; `-Test` copies 20; `-Verify` checks them. | Adds objects to the bucket. Never deletes anything. |
| `npm run corpus:manifest` | Writes the manifest `corpus.csv` for `ingest-corpus.ts` and checks it with the same validator. | Nothing on the drive. |

What Studio refuses (from `src/lib/studio/library/ingest.ts`): files over **200 MB** (200 MiB,
`MAX_SOURCE_BYTES`) and empty files. The ingest does not look at the extension: FFmpeg reads the
file and a non-video fails with "Source has no video duration". The tools accept **mp4, mov and
webm**, the formats Studio's own video uploads take. If the scan shows many other video files
(`.mkv`, `.m4v`, `.avi`), ingest one of each in the sample first; if they work, add
`--also-accept mkv,m4v` to **both** the scan and the manifest commands.

## 1. Install rclone (engineer, once)

rclone is the upload program. In PowerShell:

```powershell
winget install Rclone.Rclone
```

Close PowerShell, open a new window, and check it with `rclone version`. If `winget` is missing,
update "App Installer" from the Microsoft Store, or download the Windows "Intel/AMD - 64 Bit" zip
from <https://rclone.org/downloads/>, extract `rclone.exe`, and pass its path to the upload script
with `-RcloneExe C:\path\to\rclone.exe` (rclone.org/install, "Windows installation").

## 2. Scan the folder (engineer; operator reviews)

```powershell
npm run corpus:scan -- "E:\Videos" --out "$env:USERPROFILE\corpus-scan.json" --upload-list "$env:USERPROFILE\corpus-files.txt" --skip-duplicates
```

The tool only reads. It prints:

- how many files of each type and how big they are, and the largest files;
- **files Studio would refuse**, with the reason. They are left out of the upload list:
  - *larger than 200 MB*: shorten or re-encode them into a separate folder, or leave them out;
  - *not an accepted format*: photos, documents and so on. Nothing to do;
  - *bad name*: the name has a full-width symbol (such as `？` or `：`) or a character the
    upload tool would change. Rename those files **now, before the upload**;
- **duplicates**: files with the same size and the same first and last megabyte. With
  `--skip-duplicates` only the first copy (by path) is uploaded. Without it every copy is uploaded
  and Studio stores the content once (the second one comes back as `DUPLICATE`);
- **names worth a look**: accents, `#`, `%`, `+`, `&` or double spaces. They upload fine;
- the upload time and the R2 cost.

The full detail is in `corpus-scan.json`. If you rename or move anything, **run the scan again**
so the upload list matches the drive.

**The folder names become the tags and the category.** The first folder picks the category when
its name is one of the library categories (for example `Lifestyle`, `Education`,
`Product marketing`, or a sub-category such as `Fitness`), and a second folder can narrow it
(`Lifestyle\Fitness`). Folder names such as `French` or `pt-BR` set the language; `TikTok`,
`Instagram`, `YouTube` and so on set the platform. The categories are in
`prisma/data/library-taxonomy.json`. If you want to reorganise folders, do it **now**: after the
upload the paths are fixed.

## 3. Create the bucket (operator, Cloudflare dashboard)

1. Sign in at <https://dash.cloudflare.com> and open **R2 object storage**.
2. Click **Create bucket**.
3. Name: `eu-corpus-source`.
4. Under **Location**, choose **Specify jurisdiction**, then **European Union (EU)**. This cannot be
   changed later, and Studio's own buckets are EU too (r2-setup.md step 1).
5. Click **Create bucket**.

## 4. Create the upload key (operator, Cloudflare dashboard)

1. Go back to **R2 object storage**. Under **Account Details**, click **Manage** next to
   **API Tokens**.
2. Click **Create Account API token**.
3. Name it `corpus upload`.
4. Permissions: **Object Read & Write**.
5. Scope it to **specific buckets only**, and pick only `eu-corpus-source`.
6. If there is an expiry (TTL) option, choose a date after the upload will have finished, for
   example one month.
7. Click **Create Account API token**.
8. **Leave this page open.** It shows an **Access Key ID** and a **Secret Access Key**. You need
   both in step 5. Cloudflare may not show the secret again.

## 5. Put the key in the env file (engineer starts, operator pastes)

Engineer, with the Cloudflare account ID (dashboard → R2 overview → Account Details):

```powershell
npm run corpus:rclone-config -- --init --account-id <ACCOUNT_ID>
```

This creates `%USERPROFILE%\postmind-corpus.env` with empty places for the key. Operator:

1. Press **Windows key + R**, type `notepad %USERPROFILE%\postmind-corpus.env`, press **Enter**.
2. After `CORPUS_R2_ACCESS_KEY_ID=` paste the **Access Key ID** (right-click → Paste).
3. After `CORPUS_R2_SECRET_ACCESS_KEY=` paste the **Secret Access Key**.
4. No spaces and no quote marks. Press **Ctrl+S**, then close Notepad and the Cloudflare page.

Never email, chat or screenshot this file.

## 6. Write the rclone config (engineer)

```powershell
npm run corpus:rclone-config
```

It writes `%USERPROFILE%\.config\rclone\postmind-corpus.conf` with the remote `postmind-corpus`:
provider Cloudflare, endpoint `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`, and
`no_check_bucket = true` (rclone's R2 page: needed for "Object Read & Write" tokens, which cannot
create buckets). It prints the endpoint and the first and last four characters of the key ID,
never the secret. A wrong paste is reported by name (for example "CORPUS_R2_SECRET_ACCESS_KEY is
not an R2 Secret Access Key"): fix the env file and run it again.

Check the key works (an empty answer is correct; an error such as 403 means the key is wrong or
not scoped to the bucket):

```powershell
rclone lsf --config "$env:USERPROFILE\.config\rclone\postmind-corpus.conf" postmind-corpus:eu-corpus-source
```

## 7. Test batch: 20 videos (engineer)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\corpus\upload.ps1 -Source "E:\Videos" -FilesFrom "$env:USERPROFILE\corpus-files.txt" -Test
```

It copies the first 20 files of the list to `eu-corpus-source/videos/…`. Operator: in the
dashboard, open the bucket. You should see a `videos/` folder with the same folder names as the
drive. Logs are in `%USERPROFILE%\postmind-corpus-logs`.

## 8. Full upload (engineer starts it; the PC stays on)

1. Stop the PC sleeping while it is plugged in: **Settings → System → Power & sleep → Sleep: Never**
   (set it back afterwards).
2. Run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\corpus\upload.ps1 -Source "E:\Videos" -FilesFrom "$env:USERPROFILE\corpus-files.txt"
   ```

- It runs `rclone copy` with 8 uploads at a time (`-Transfers`), 16 checkers (`-Checkers`),
  5 whole-run retries 30 s apart and 20 retries per request, a progress display, and a log file.
- **It can be stopped and restarted.** Ctrl+C, a reboot, a lost connection: run the same command
  again. rclone skips files already in the bucket with the same size and date, so it carries on
  where it stopped. It never deletes anything.
- If your internet is slow for everyone else in the house, use `-Transfers 4`.
- Exit code 0 means every file is up. Anything else: run it again; if it keeps failing, the reason
  is at the end of the log.

## 9. Verify (engineer)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\corpus\upload.ps1 -Source "E:\Videos" -FilesFrom "$env:USERPROFILE\corpus-files.txt" -Verify
```

`rclone check --one-way` compares every listed file with the bucket, by size and checksum. It reads
the whole drive again, so it takes a while; `-Verify -Quick` compares sizes only. It writes
`verify-…-missing.txt`, `verify-…-different.txt` and `verify-…-errors.txt` in the log folder. If any
file is missing or different, run step 8 again, then verify again. Go on only when it says
"OK: all … files are in the bucket and match".

## 10. Generate the manifest (engineer)

Use the **same** `--skip-duplicates` (and `--also-accept`, if used) as the scan:

```powershell
npm run corpus:manifest -- "E:\Videos" --bucket eu-corpus-source --prefix videos/ --out "$env:USERPROFILE\corpus.csv" --upload-list "$env:USERPROFILE\corpus-files.txt" --skip-duplicates
```

Each row, in the format of `corpus/manifest.template.csv`:

| Column | From |
| --- | --- |
| `url` | `s3://eu-corpus-source/videos/<path on the drive, with />`: exactly the key the upload wrote |
| `title` | the file name without the extension, `_` and `-` as spaces, sentence case (all-capital words such as `UK` stay) |
| `tags` | the folder names, `a\|b\|c`, lower case with dashes |
| `category` | the top folder when it names a library category, narrowed by the second folder; empty otherwise (Claude classifies it) |
| `sourceRef` | `corpus-` + a hash of the path: the same file always gets the same id |
| `language` | only when a folder is a language (`French`, `fr`, `pt-BR`) or the file name has one in brackets (`(Spanish)`, `[en]`); words such as "French toast" do not count |
| `sourcePlatform` | when the path names exactly one of tiktok, instagram, youtube, facebook, snapchat, linkedin, pinterest, twitter |

The tool then checks the file with the same validator `ingest-corpus.ts` uses, prints the category
counts and every rejected row, and confirms that every row is a file in the upload list. It exits
with 1 if a row is rejected or the lists differ (usually: the folder changed after the upload, or
the options differ from the scan).

## 11. Review the manifest (operator, with the engineer)

- Read the category counts: do they match how the drive is organised?
- Look at 20 random rows: are the titles and tags sensible?
- To correct a title, tags, category or language, edit the cell in a text editor. **Never change
  the `url` column** and never rename files on the drive now: the url must stay the uploaded key.
- Excel changes CSV files when it saves them. To look at it in Excel, use **Data → From Text/CSV**
  (UTF-8) and do not save; edit in Notepad or VS Code.

## 12. Let Studio read the bucket (engineer, server)

Studio reads `s3://` sources with its own R2 key (the app token, r2-setup.md step 2), so that key
must also reach `eu-corpus-source`. One S3 client serves one jurisdiction; the bucket is EU like
Studio's buckets, so that works.

1. Cloudflare → R2 → **Manage API Tokens** → **Create Account API token**: **Object Read & Write**,
   scoped to Studio's buckets (the ones in the current app token) **plus** `eu-corpus-source`.
   (Cloudflare applies one permission to all the buckets a token is scoped to.)
2. On the server, in the app env file (`/etc/postmind-studio/production.env`, vps-deploy.md), put
   the new key in `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` and add
   `STUDIO_CORPUS_S3_BUCKETS=eu-corpus-source/videos/`. Restart the stack so web and worker read it.
3. Check the site still loads images and videos, then delete the old app token in Cloudflare.

## 13. Resize the server to 8 GB first (engineer)

The 2 GB server cannot run the corpus ingest (vps-deploy.md section 1, "What does NOT fit in
2 GB"). Resize it to a type with **8 GB RAM** by the "Resize in place" steps there, keeping the
disk size so you can scale back down. Then raise `STUDIO_LIBRARY_CONCURRENCY` and set
`STUDIO_LIBRARY_PLAN_TIER=ENTERPRISE` as corpus-ingestion.md "Cost" and "Throughput math"
describe.

## 14. Pre-flight (engineer, server)

On the VPS the one-shot `ops` container has the app's env and keeps `ops/results/` on the host
(`${STUDIO_STATE_DIR:-/var/lib/postmind-studio}/production/results`). Copy the manifest there, for
example `scp "$env:USERPROFILE\corpus.csv" <user>@<server>:/var/lib/postmind-studio/production/results/`,
then run the pre-flight with the admin URL and a staff token (corpus-ingestion.md "Tools"). Type
the token at a hidden prompt so it stays out of the shell history; `-e NAME` without a value passes
it from the shell:

```
read -rs -p 'Staff token: ' STUDIO_STAFF_TOKEN && export STUDIO_STAFF_TOKEN
export STUDIO_URL=https://<your Studio address>
bash scripts/vps/compose.sh production run --rm -e STUDIO_URL -e STUDIO_STAFF_TOKEN ops \
  node --import tsx scripts/ops/ingest-corpus.ts ops/results/corpus.csv --preflight --sample 100
```

It checks the admin API and taxonomy, the tier, the job slots, write access to the library bucket,
that every s3:// row is inside `STUDIO_CORPUS_S3_BUCKETS` (with HEAD probes of up to 20 objects),
and the manifest. Fix every FAIL. Run the sample and full ingest the same way, so the state file
(`ops/results/corpus.csv.state.json`) survives between runs.

## 15–16. Sample ingest, review, full ingest

Follow [corpus-ingestion.md](corpus-ingestion.md) steps 2 to 5: the 100-video sample
(`--sample 100 --seed 7 --apply`), the operator's review checklist, then the full run
(`--apply --queue-concurrency 8 --workers 2`) with the same state file, and monitoring.

## 17. Afterwards: delete the source bucket (operator + engineer)

Only after the full run meets corpus-ingestion.md "Verification". Studio keeps its own copy of
every video in the library bucket, so the source bucket is no longer needed. The hard drive stays
the backup.

1. Engineer: on the server, remove `STUDIO_CORPUS_S3_BUCKETS` (or the `eu-corpus-source` entry),
   swap the app key back to one scoped to Studio's buckets only (as in step 12), restart, and delete
   the step 12 token.
2. Operator, Cloudflare dashboard → **R2 object storage** → `eu-corpus-source` → **Settings**:
   - **Empty Bucket** → **Empty** → confirm. For a large bucket it runs in the background; wait
     until it shows the bucket is empty.
   - **Delete Bucket** → **Delete** → confirm.
3. Operator: **Manage API Tokens** → delete the `corpus upload` token.
4. Engineer: delete `%USERPROFILE%\postmind-corpus.env` and
   `%USERPROFILE%\.config\rclone\postmind-corpus.conf` (they hold the deleted key), and resize the
   server back down if you want (vps-deploy.md section 1).

## If something goes wrong

| Symptom | Cause and fix |
| --- | --- |
| `rclone is not installed` | Step 1, then open a new PowerShell window. |
| `403 Forbidden` / `AccessDenied` | The key is wrong, expired, or not scoped to `eu-corpus-source`: redo steps 4 to 6. |
| `NoSuchBucket` or a bucket error | The bucket name or jurisdiction differ: the bucket must be `eu-corpus-source` in the EU jurisdiction. |
| The upload stops, the PC slept, the drive was unplugged | Plug it in and run the same command again. It resumes. |
| Verify lists missing files | Run the upload again, then verify again. |
| The manifest says the lists differ | The folder changed, or the options differ from the scan. Re-run the scan with the same options, re-run the upload (it copies only what is new), then the manifest. |
| Ingest failure "not in STUDIO_CORPUS_S3_BUCKETS" | Step 12, point 2. |
| Ingest failure "Source object is empty" / "larger than 200 MB" | The scan should have caught it; drop the row. |

## GAP / not verified

- No real upload was run while writing this (no bucket or key yet): the scripts are tested with a
  stand-in for rclone, and the config against rclone's documented format.
- Whether an existing Cloudflare token's bucket list can be edited was not checked: step 12 creates
  a new token instead, which always works.
- Formats other than mp4, mov and webm are not tried by the ingest's tests; prove them in the sample.
