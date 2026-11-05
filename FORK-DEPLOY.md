# Fork deploy: the Linux server from phuzzled/openbot

A Linux server (Animus One) that installs from this fork gets the newest upstream OpenBot release
with the fork changes of `FORK.md` on top, and updates from this fork only. The desktop app on a Mac
stays on upstream. It is a client of the server, and this pipeline does not build it.

## How it works

| Part | File | What it does |
|---|---|---|
| Sync | `.github/workflows/fork-sync.yml` | Each night at 03:37 UTC, and on a manual run. When upstream has a release tag that `main` does not contain, it merges that tag into `main` in a branch, then runs the desktop typecheck, the unit test files that fork commits touched, and the fork end-to-end checks (`stall-sweep`, `plan-continuation`, `timed-waits`, `timed-waits-followup`, `timed-waits-adversarial`, `agent-waits-tools`). When all pass, it pushes `main`, tags the next fork version, and calls the release. When `main` has fork commits with no release, it does the same with no merge. |
| Release | `.github/workflows/fork-release.yml` | Builds the x64 and arm64 AppImages as `release.yml` does, checks them, and publishes them with `latest-linux.yml`, `latest-linux-arm64.yml` and `SHA256SUMS.txt` as the latest GitHub Release of this fork. The hosting files (`resources/hosting/*`) are in each AppImage. |
| Steps | `scripts/fork/fork-release.sh` | Finds the upstream base, the next fork version and the fork tests, and checks the update feed. |
| Update feed | `electron-builder.yml`, `scripts/install-server.sh`, `scripts/hosting/openbot-hosted-update`, `src/main/host-release-service.ts` | Name `phuzzled/openbot`. The install, the update timer, `sudo openbot update`, and the update check in Server Settings read the releases of this fork. |

The sync follows upstream **release tags** (`releases/latest` of `nightly-labs/openbot`), never
upstream `main`. It merges, it does not rebase, so `main` is never force-pushed. Upstream tags go to
`refs/upstream-tags/*` in the job, never to the tags of this fork.

A merge conflict, a typecheck error or a failed test ships nothing: no push to `main`, no tag, no
release. The job opens an issue "Fork sync blocked: upstream vX.Y.Z" (or adds a comment to the open
one). A merge that tested red is on the branch `fork-sync/vX.Y.Z`.

### Versions

The installer, the update timer and the release manifest accept `X.Y.Z` only, and each compares
versions as numbers (`sort -V` in the scripts, `newerRelease` in `host-release-service.ts`). A fork
release on upstream `X.Y.Z` is:

    X.Y.P   with   P = (Z + 1) * 1000 + N,   N = 1, 2, ... 999

| Upstream base | Fork releases |
|---|---|
| v0.60.0 | 0.60.1001, 0.60.1002, ... |
| v0.60.3 | 0.60.4001, ... |
| v0.61.0 | 0.61.1001, ... |

- Each fork release is newer than its upstream release, so the installer accepts the switch from
  upstream.
- Each fork release is newer than each fork release before it, so the timer takes it. The script
  stops when a new version would not be.
- No fork version is also an upstream version (upstream patch numbers stay far below 1000).
- The source keeps the upstream version in `package.json`. The release job writes the fork version
  into the build only, so a sync never has a conflict on it.

The server never goes back to upstream by itself: its feed is this fork. Only a manual run of the
upstream `install-server.sh` installs upstream, and that refuses a release older than the
installed one.

## One-time GitHub setup

Do these in `https://github.com/phuzzled/openbot/settings` before the first run.

1. **Enable Actions on the fork.** Open the **Actions** tab and click "I understand my workflows, go
   ahead and enable them". This fork has run no workflow yet.
2. **Enable Issues.** Settings > General > Features > Issues. They are off now, and the sync reports
   a block as an issue.
3. **Turn off the upstream workflows.** They need upstream secrets, and a pushed tag starts
   `release.yml`, which then fails:

   ```sh
   for w in release.yml release-android.yml release-ios.yml ci.yml cla.yml changelog.yml \
     cloudflare-preview.yml contribution-policy.yml cua-driver.yml mobile-release-announcement.yml \
     norbiai-review.yml provider-cli-canary.yml remote-desktop-runtime.yml status-page.yml \
     windows-installer-e2e.yml; do gh workflow disable "$w" --repo phuzzled/openbot; done
   ```

   Keep `ci.yml` on if you want the full upstream CI on each push to `main` (it is slow).
4. **Add the secret `FORK_SYNC_TOKEN`** (Settings > Secrets and variables > Actions). A fine-grained
   personal access token for `phuzzled/openbot` only, with **Contents: Read and write** and
   **Workflows: Read and write**. An upstream release nearly always changes `.github/workflows`, and
   `GITHUB_TOKEN` cannot push such a change. Without this secret the sync uses `GITHUB_TOKEN`, and
   the push of such a merge fails.
5. **Workflow permissions** (Settings > Actions > General): the default "Read repository contents"
   is correct. Each job asks for the write access that it needs.
6. If `main` gets branch protection, let the owner of `FORK_SYNC_TOKEN` push to it.

The Linux build reads no other secret and no variable. It does not sign, notarize, attest, push a
Docker image, or deploy to Cloudflare, boat or Discord.

## Switch Animus One from upstream to the fork

Run these on Animus One. The default service user is `openbot`; the installed one is in
`/opt/OpenBot/hosted/service-user`.

1. Check the state, and that the fork has a release for this machine:

   ```sh
   openbot status
   uname -m        # x86_64 uses latest-linux.yml, aarch64 uses latest-linux-arm64.yml
   curl -fsSL https://github.com/phuzzled/openbot/releases/latest/download/latest-linux.yml
   ```

2. Stop the upstream update timer, so it stages no upstream release during the switch:

   ```sh
   sudo systemctl stop openbot-update.timer
   ```

3. Back up. No backup is made before a database migration, and an older OpenBot cannot open a
   database that a newer one migrated:

   ```sh
   user=$(cat /opt/OpenBot/hosted/service-user)
   sudo systemctl stop openbot.service
   sudo tar --exclude=opt/OpenBot/staged -C / -czf /root/openbot-before-fork-$(date +%F).tgz \
     "var/lib/$user" srv/openbot-hosted opt/OpenBot
   ```

   The home folder has the data, and `/srv/openbot-hosted` has the keyring with the key of the
   encrypted data. Keep them together. `/opt/OpenBot` is the installed upstream release, which a
   rollback needs.

4. Read the schema version:

   ```sh
   db=$(sudo find "/var/lib/$user" -name openbot.db -print -quit); echo "$db"
   sudo apt-get install -y sqlite3
   sudo sqlite3 -readonly "$db" 'SELECT MAX(version) FROM schema_migrations'
   ```

   Upstream v0.60.0 gives 53, and upstream v0.61.0 gives 55. The fork is on the upstream release
   v0.61.0 and adds no upstream migration (its tables are outside the migration sequence, see
   `FORK.md`), so after the switch it gives 55. A database of v0.60.0 gets the upstream migrations 54
   and 55 at the first start of the fork. A number above 55 means that the database is newer than the
   fork: stop, and do not install.

5. Install the fork. The install keeps the user, the account server and the display size of the
   installed server, and starts OpenBot and the timer:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/phuzzled/openbot/main/scripts/install-server.sh | sudo bash
   ```

6. Verify:

   ```sh
   openbot status                                   # OpenBot 0.61.1001 (or newer), signed in
   grep '^RELEASES=' /opt/OpenBot/hosted/openbot-hosted-update   # phuzzled/openbot
   systemctl is-active openbot.service openbot-update.timer
   openbot logs                                     # no start errors
   sudo sqlite3 -readonly "$db" 'SELECT MAX(version) FROM schema_migrations'
   ```

   Then open the server from the Mac app. The app shows a version warning for the server (the
   versions differ), and works. See "Client and server" below.

### Roll back to upstream

The upstream installer refuses a release older than the installed fork release, so a rollback is a
restore of the backup. Data that the server made after the switch is lost.

```sh
sudo systemctl stop openbot-update.timer openbot.service
user=$(cat /opt/OpenBot/hosted/service-user)
sudo rm -rf /opt/OpenBot "/var/lib/$user" /srv/openbot-hosted
sudo tar -C / -xzf /root/openbot-before-fork-YYYY-MM-DD.tgz
sudo systemctl daemon-reload
sudo systemctl start openbot.service openbot-update.timer
openbot status
```

The restored `openbot-hosted-update` reads the upstream feed again. A later fork release stays
installable with step 5.

## When the sync issue opens

- **Merge conflict.** The issue lists the files. On a computer:

  ```sh
  git fetch origin && git switch main && git pull
  git fetch --no-tags https://github.com/nightly-labs/openbot.git '+refs/tags/vX.Y.Z:refs/upstream-tags/vX.Y.Z'
  git merge --no-ff -m "Merge upstream OpenBot vX.Y.Z" 'refs/upstream-tags/vX.Y.Z^{commit}'
  # Resolve. Keep the FORK.md rules: no upstream migration number, fork tables in fork-schema.ts,
  # the update feed on phuzzled/openbot (scripts/fork/fork-release.sh check-feed).
  git push origin main
  ```

  Then run the sync (`gh workflow run fork-sync.yml --repo phuzzled/openbot`). It finds the tag in
  `main`, runs the tests, tags and releases.
- **Typecheck or test failure.** The issue has the end of each failed log, and the merge is on
  `fork-sync/vX.Y.Z`. Fix it on that branch, merge the branch into `main`, push, and run the sync.
- **Update feed check.** Upstream added a release URL to a server feed file. Change it to
  `phuzzled/openbot`, as `FORK.md` lists.
- Close the issue, and delete `fork-sync/vX.Y.Z`.

To release fork commits before the nightly run: `gh workflow run fork-sync.yml --repo
phuzzled/openbot`. To build an existing tag again: `gh workflow run fork-release.yml --repo
phuzzled/openbot -f tag=v0.60.1001`.

## Client and server

The Mac app and the server agree on a Team protocol range (`LOCAL_TEAM_PROTOCOL`, protocols 1 to 9
in v0.61.0), not on the app version. A connection fails ("incompatible") only when the ranges do
not overlap. The fork does not change the Team protocol. The fork adds two optional fields
(`wakeAt`, `timeWakes`) to an agent wait; an upstream app ignores them.

- The app version of the server differs from the app (for example 0.60.1001 and 0.60.0). At each new
  connection the app shows a version warning. With a fork server of a higher number, it tells the
  user to update the app. This is a warning only.
- When upstream releases a new version, the Mac app can update before the server (the sync runs
  each night). A server one release behind is normally inside the protocol range. An upstream
  release that raises the protocol minimum makes the server "incompatible" until the sync releases
  it; a sync issue then blocks the server. Fix the issue first.
