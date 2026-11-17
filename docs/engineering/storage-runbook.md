# Storage runbook — set-up, backup, restore, retention

For the owner, on the Ubuntu laptop. Nothing here has been run against a real account: the commands were
exercised with the same tools against local test repositories only. Every step that creates an account, grants
access, uploads or deletes is marked **[you decide]**. No agent should run those steps for you.

Design: `arvi-hybrid-storage-v0.7.md`. Decision: `adr-0001-hybrid-storage.md`.

## 0. Before anything else

- Your uncommitted work and unpushed commits exist only on the laptop. A backup of the *profile* does not cover
  them. Commit and push them first (the procedure is in `cloud-continuation-v0.6.1.md`, section 6).
- Do not point any of this at `/home/roy/MemoBrOS*` worktrees. Code is GitHub's job.
- Check whether the disk is encrypted: `lsblk -o NAME,FSTYPE,MOUNTPOINT | grep -i crypt`. If it is not, a lost
  laptop exposes the profile and the keyring whatever the backups do.

## 1. Install the tools **[you decide: a package install]**

```bash
sudo apt install restic rclone libsecret-tools
restic version && rclone version
```

## 2. Passwords: make them, write them down, then store them

```bash
openssl rand -base64 32      # daily password for the Drive repository
openssl rand -base64 32      # recovery key for the Drive repository
```

1. Write both on paper and put them in your password manager **now**. Not in Google Drive, not in the
   repository, not in a note on the laptop.
2. Store the daily one in the desktop keyring so that backups can run without typing it:

```bash
secret-tool store --label="ARVI backup (drive)" service arvi-backup target drive
export RESTIC_PASSWORD_COMMAND='secret-tool lookup service arvi-backup target drive'
```

**If every copy of both passwords is lost, the backups can never be read again. Nobody can reset them.**

## 3. Google Drive remote **[you decide: grants access to your Google account]**

```bash
rclone config          # new remote, name: gdrive, type: drive, scope: drive.file
```

- Scope `drive.file`: rclone can only see the files it creates. It cannot read the rest of your Drive.
- When asked, set a configuration password: the Drive token is otherwise stored in plain text in
  `~/.config/rclone/rclone.conf`.
- rclone's documentation recommends creating your own Google API client ID to avoid shared rate limits; that page
  could not be read from the session that wrote this runbook, so check it.
- Check your free space: `rclone about gdrive:`

## 4. Create the repository and add the recovery key **[you decide: first upload]**

```bash
export RESTIC_REPOSITORY=rclone:gdrive:ARVI-backups/restic
restic init
restic key add               # type the recovery key from step 2 when asked for the new password
restic key list              # two keys
```

Prove the recovery key works, from a new terminal, typing it by hand: `restic -r rclone:gdrive:ARVI-backups/restic snapshots`.

## 5. First backup, from a copy

Quit MemoBrOS first, so no file changes while it is copied.

```bash
mkdir -p ~/arvi-backup-staging && cd ~/arvi-backup-staging
cp -a ~/.config/MemoBrOS/settings.json ~/.config/MemoBrOS/memory.json ~/.config/MemoBrOS/routines.json . 2>/dev/null
cp -a ~/.config/MemoBrOS/skills . 2>/dev/null
ls -la                       # look at what is about to be uploaded. No keys, no logs, no models, no caches
restic backup . --host arvi --tag set:profile
restic check --read-data     # reads everything back from Drive
```

The secrets file of the profile and `actions.log` are deliberately not in that list: stored keys are bound to
this computer's keyring and are never uploaded, and logs are never uploaded.

## 6. Restore drill (do it once now, and again every few months)

```bash
mkdir ~/arvi-restore-drill
restic restore latest --tag set:profile --target ~/arvi-restore-drill --verify
diff -r ~/arvi-backup-staging ~/arvi-restore-drill && echo "identical"
rm -r ~/arvi-restore-drill
```

A backup that has never been restored is a hope, not a backup.

## 7. Real restore (new laptop, or a damaged profile)

1. Install the tools (step 1). Recreate the rclone remote (step 3). Use the **recovery key** if the keyring is gone.
2. Restore into an **empty** folder, never over an existing profile:
   `restic -r rclone:gdrive:ARVI-backups/restic restore latest --tag set:profile --target ~/arvi-restored --verify`
3. Quit MemoBrOS. Keep the old profile: `mv ~/.config/MemoBrOS ~/.config/MemoBrOS.before-restore` (if it exists).
4. `mkdir -p ~/.config/MemoBrOS && cp -a ~/arvi-restored/. ~/.config/MemoBrOS/`
5. Start MemoBrOS. Then, before running anything:
   - enter your API keys again and sign in to connectors again (credentials are not in backups);
   - open Settings and review the "always allow" rules and permissions: they came back as they were;
   - tasks come back in their recorded state. Nothing restarts by itself; an unfinished one shows as interrupted.
6. Rollback: quit, `rm -r ~/.config/MemoBrOS && mv ~/.config/MemoBrOS.before-restore ~/.config/MemoBrOS`.
7. Because the old laptop may be in someone else's hands: revoke rclone's access in your Google account, revoke
   GitHub and provider tokens, and create a **new** repository with new passwords.

## 8. Retention **[you decide: this deletes old backups]**

```bash
restic forget --tag set:profile --keep-within 30d --keep-monthly 12 --dry-run     # shows what would go
restic forget --tag set:profile --keep-within 30d --keep-monthly 12               # removes those snapshots
restic prune                                                                      # frees the space on Drive
restic check --read-data
```

Always run the dry run first and read it. Never run `forget` right after a failed backup or a failed check.

## 9. Routine checks

| When | What |
| --- | --- |
| After every backup | `restic check --read-data` (the orchestrator does this itself) |
| Monthly | `rclone about gdrive:`; `restic snapshots`; the restore drill of step 6 |
| After any suspicion that a password leaked | A new repository with new passwords; delete the old one after the new one is verified |
| After losing a device | Step 7.7 |

## 10. Optional: an independent copy **[you decide: a new account, possibly a payment method]**

Only after steps 1–6 work. Create a bucket with the provider you choose (see the ADR; confirm prices on the
provider's own page), create a key limited to that bucket, and repeat steps 2, 4, 5 and 6 with a **different**
password and `RESTIC_REPOSITORY=s3:<endpoint>/<bucket>/restic`. Keep its keys apart from the Drive ones.
Do not copy one repository into the other automatically: back up to each from the laptop.

## 11. Freeing local space **[you decide; nothing here is automatic]**

Only things that can be re-created, and only in folders you are not working in:

```bash
du -sh ~/MemoBrOS*/node_modules ~/MemoBrOS*/dist ~/.npm ~/.cache/electron ~/.cache/electron-builder 2>/dev/null
npm cache clean --force                      # the npm download cache
rm -r ~/.cache/electron-builder              # downloaded again on the next installer build
rm -r <an idle worktree>/dist                # build output
rm -r <an idle worktree>/node_modules        # back with: npm ci   (needs the network)
```

Do not remove anything from a worktree that has uncommitted work until that work is committed and pushed. Do not
remove `~/Respaldos-MemoBrOS`. Unused speech models are removed from MemoBrOS's own Settings.

## 12. What to do when something fails

| Message | Meaning | Do |
| --- | --- | --- |
| wrong password or no key found | The password does not open this repository | Check which repository; try the recovery key |
| repository cannot be reached | Offline, token expired, remote renamed | `rclone about gdrive:`; `rclone config reconnect gdrive:` |
| no space / quota exceeded | Drive or the local disk is full | `rclone about gdrive:`; `df -h`; free space; run the backup again |
| repository is already locked | Another backup is running, or one died | Wait; if nothing is running, `restic unlock` |
| check found errors / data does not match | The repository is damaged | Do not `forget` or `prune`. Restore from the other copy if you have one; make a new repository; back up again |
