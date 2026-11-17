# ARVI hybrid storage — architecture, placement, security, disk budget

Branch `claude/arvi-storage-v0.7`, started from `14b9bda` (the head of PR #2). Companion files:
`adr-0001-hybrid-storage.md` (the decision and the provider comparison) and `storage-runbook.md` (set-up, backup,
restore, retention). No secrets here.

Evidence labels: **real process** (restic and rclone really ran, in the cloud container, on synthetic data in
temporary folders), **mock**, **designed** (not built), **laptop** (must be checked on the Ubuntu machine),
**needs approval** (not done without the owner).

## 0. What was and was not accessible

- The repository as published on GitHub: `main`, `claude/festive-wozniak-5h9t6d` (PR #1) and
  `claude/memobros-v0.6.1-cloud-hardening` (PR #2, head `14b9bda`).
- **Not on GitHub:** the branch `integration/arvi-v0.7-baseline` and commit `439b459`; the four laptop worktrees
  (`MemoBrOS`, `MemoBrOS-Codex`, `MemoBrOS-Harness-Codex`, `MemoBrOS-Harness-Kiro`) and their uncommitted work.
  None of it was read, assumed or reproduced. This branch therefore starts from PR #2's head and adds only new
  files, plus one script line and one CI job placed away from the lines the Codex and Kiro prompts edit.
- Google Drive, Backblaze and Cloudflare: no account was touched, created or configured. Nothing was uploaded.
- The laptop's disk: not measurable from here. Section 6 gives measurements from the cloud checkout and the
  read-only commands to take the real ones.
- Official pricing and documentation pages could not be opened directly from this session (the network blocks
  them); figures in the ADR come from search results restricted to the vendors' own domains on 2026-11-17 and
  each is marked for confirmation on the live page.

## 1. The five roles

A place that holds data has exactly one of these roles for a given kind of data. Mixing them is how backups
become a second, diverging copy of the truth.

| Role | Meaning | Where |
| --- | --- | --- |
| **Source of truth** | Approved code and documents, with their history | The Git repository on GitHub (private) |
| **Operational local persistence** | What the running app reads and writes; the truth for private runtime data | The profile folder on the Ubuntu disk |
| **Remote encrypted archive** | Encrypted, versioned backups of the local truth | Google Drive, through restic and rclone |
| **Independent recovery copy** | A second encrypted archive with a different company and different credentials | Optional: an S3-compatible bucket |
| **Reconstructable cache** | Anything that can be downloaded or built again | Local only; never uploaded |

There is no synchronisation. Data flows one way: local truth → encrypted snapshot → remote. A restore is an
explicit act by the user into an empty folder. Two computers never merge state; each has its own sets (section 5).

## 2. ARVI Storage Orchestrator

Three small modules under `src/main/storage/`, none of which imports Electron or is called by the app yet.

| Module | Responsibility |
| --- | --- |
| `policy.js` | The placement table (section 3) as data; `mayUpload`; the durability states and their allowed moves; `evictionPlan` (proposes, cannot delete); `budgetReport`. Pure. |
| `restic.js` | A typed wrapper around the restic command line: `init`, `backup`, `snapshots`, `check`, `restore`, `forgetPlan`, `forget`. Names errors by what the user can do (`wrong_password`, `unreachable`, `no_space`, `corrupt`, `locked`, `missing_credentials`, `cancelled`). The password goes to restic through that one process's environment, never on a command line or into a file. |
| `orchestrator.js` | `backup`, `verifyUploaded`, `restore`, `retentionPlan`, `applyRetention`, `status`, `markRestoreRequired`, for named *sets* of local files against a list of *targets*. |

Interfaces (JSDoc style, as in the harness document):

```js
/** @typedef {Object} Target            // one place backups go
 * @property {string} id                // 'drive', 'independent'
 * @property {'primary'|'recovery'} role
 * @property {string} repo              // a restic repository: 'rclone:<remote>:<path>', 's3:<endpoint>/<bucket>', or a folder
 * @property {Object?} env              // non-secret settings for the tool (which rclone config file, region)
 */
/** @typedef {Object} Capabilities      // designed; declared per target when more than restic exists
 * @property {boolean} encryptsClientSide  @property {boolean} versioned  @property {boolean} appendOnly
 * @property {boolean} quotaReadable       @property {'restic'} format
 */
/** @typedef {'local_committed'|'backup_pending'|'uploaded'|'verified'|'restore_required'|'recovery_failed'} BackupState */
/** @typedef {Object} SetStatus
 * @property {string} set  @property {string} category
 * @property {{hash:string, count:number, bytes:number}} manifest      // SHA-256 over every file, taken before upload
 * @property {Object<string,{state:BackupState, snapshot:string, at:string, error:string, errorKind:string}>} targets
 * @property {boolean} durable          // verified on the primary target
 * @property {boolean} independent      // verified on the primary AND on a recovery target
 */
createOrchestrator({ stateDir, targets, getPassword(target) -> text, approve(request) -> true|false })
  backup({ set, dir, category, approved, key, only, signal })   -> SetStatus    // never throws for offline/no space: records it
  verifyUploaded({ set, on })                                    -> SetStatus
  restore({ set, from, into, snapshot })                         -> { snapshot, files, bytes, verified }   // `into` must be empty
  retentionPlan({ set, on, keepLast | keepWithin })              -> { keep, remove, hasVerified }           // removes nothing
  applyRetention({ ... })                                        -> { removed }                             // asks `approve` first
  status(set?)                                                   -> SetStatus | SetStatus[]
```

Designed, not built: scheduling (a routine that calls `backup`), quota monitoring (`rclone about` for Drive),
provider health history, a usage report in the panel, and `prune` (freeing space on the remote after `forget`).

### What the states mean

| State | Meaning | Reached when |
| --- | --- | --- |
| `local_committed` | The data is on this computer. Nothing was sent. | Default |
| `backup_pending` | A backup is owed: in progress, interrupted, offline, out of space, or no password | A run starts; a run fails for a reason that is not about the data |
| `uploaded` | restic reported a finished snapshot | The upload ended. **Not durability** |
| `verified` | The whole repository was read back and checked (`restic check --read-data`), then the snapshot was restored to a scratch folder and every file's SHA-256 matched the manifest taken before the upload | Only after both checks |
| `restore_required` | The local data is known to be gone or damaged | Set explicitly |
| `recovery_failed` | A read-back or a restore failed because of the data or the key | Corruption, wrong password |

`durable` is true only with `verified` on the primary target; `independent` only with `verified` on both. A set
whose content has not changed and is already verified is not sent again, with or without an idempotency key.

### Fit with the Agent Harness decisions

| Harness decision | How storage respects it |
| --- | --- |
| Never auto-resume interrupted tasks | A restore brings back `task.json` files as they were. Recovery at start-up still turns active states into `interrupted`; a restored task is never started |
| Never duplicate uncertain external operations | Restored traces keep their `side_effect` intent/done records; nothing is replayed from a backup |
| Never replay an approval | `approval_history` is history. No code reads a restored approval as a decision |
| Standing permissions are read at execution time | Settings are restored as files; rules are still read live. After a restore the app should ask the user to review standing rules before the first task (integration step 4) |
| Never silently switch agents or cloud environments | The orchestrator never chooses a target the user did not configure and never moves data between providers |
| Task state does not depend on a provider | No task transition calls the orchestrator. Backups read the task folder after the fact |

## 3. Placement matrix

"Auto" means: included in encrypted backups once the user has switched backups on. "Ask" means: only when the
user approves that set. The table is `policy.CATEGORIES` in code; tests keep the two in step.

| Category | Authority | Must be local | Remote copy | Encrypted | Upload | Retention | Local ceiling | Recovery | When offline |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Source code | GitHub | Active worktrees | GitHub | No (private repository; no secrets inside) | Git only | Git history | One checkout plus the worktrees in use | `git clone` | Work continues; push later |
| Git history | GitHub | `.git` | GitHub | No | Git only | For ever | A few MB today | `git clone`. **Unpushed commits exist only locally** | Commit locally |
| Architecture documents, ADRs, contracts, config templates | GitHub | — | GitHub | No | Git only | Git history | Negligible | `git clone` | Unaffected |
| Application settings | Local profile | Yes | Drive (+ recovery) | Yes | Auto | 30 daily, 12 monthly snapshots | < 1 MB | Restore, then review standing rules | Unaffected; backup pending |
| OAuth credentials, API keys | Local keyring / profile | Yes | **None** | At rest by the OS keyring | **Never** | Until revoked | < 1 MB | Sign in again; revoke the old grants | Unaffected |
| Recovery passwords | The user (password manager and paper) | In the keyring for unattended backups | **None, and never with a provider that holds the backups** | — | **Never** | Until rotated | — | From the user's own copy. Lost = backups unreadable | Unaffected |
| Task records | Local profile | Active and resting tasks | Drive (+ recovery) | Yes | Auto | Remote: as settings. Local: until the user cleans up | 200 MB | Restore; tasks come back in their recorded state | Unaffected; backup pending |
| Approval history | Local profile | Yes | Drive (+ recovery) | Yes | Auto | As task records | With task records | Restore as history only | Unaffected |
| Redacted traces | Local profile | Recent | Drive (+ recovery) | Yes | Auto | As task records | With task records | Restore | Unaffected |
| Conversation history | Local profile | Yes | Drive, only if approved | Yes | Ask | User's choice | 100 MB | Restore | Unaffected |
| Memory notes, routines | Local profile | Yes | Drive (+ recovery) | Yes | Auto | As settings | < 5 MB | Restore | Unaffected |
| User-owned files | Wherever the user keeps them | Yes | Only what the user selects | Yes | Ask | User's choice | Not ARVI's to limit | Restore to an empty folder | Unaffected |
| Generated artifacts, deliverables | Local until archived | While in use | Drive, if approved | Yes | Ask | User's choice | 1 GB, then propose archiving | Restore | Unaffected |
| Screenshots, audio | Nowhere | In memory only | **None** | — | **Never** | Not kept | 0 | None | Unaffected |
| Agent tool output | Nowhere (sizes only) | Shown, not stored | **None** | — | **Never** | Not kept | 0 | None | Unaffected |
| Logs (`actions.log`) | Local profile | Recent | **None** | — | **Never** | 30 days, then removable | 50 MB | None needed | Unaffected |
| Local AI models | The publisher | The ones in use | **None** | No | **Never** | Until unused | Tiny + one main model | Download again | Cannot download |
| Dependencies (`node_modules`) | The npm registry + lockfile | In worktrees in use | **None** | No | **Never** | Removable when a worktree is idle | ~0.5 GB per worktree in use | `npm ci` | Cannot reinstall |
| Build outputs (`dist/`) | The source | No | **None** (releases belong to GitHub Releases) | No | **Never** | Removable any time | 0 between builds | Build again | Unaffected |
| npm, Electron, builder caches | The registries | No | **None** | No | **Never** | Removable any time | 1 GB | Downloaded again | Cannot refill |
| Temporary files | Nowhere | No | **None** | No | **Never** | Removable | Small | None | Unaffected |
| Backups themselves | The remote repositories | **No local copy** | Drive (+ recovery) | Yes | — | Section 4 | 0, plus a restic cache | From the other target | Pending |

Never uploaded automatically, in one line: credentials and keys, recovery passwords, screenshots and audio, raw
tool output, logs, models, dependencies, build outputs, caches, temporary files. Conversation history, the user's
own files and generated artifacts only with approval. Source code only through Git.

## 4. Security and encryption

**One encryption layer: restic's.** restic encrypts and authenticates everything in a repository before it leaves
the computer; according to its documentation the data is encrypted with AES-256 in counter mode and authenticated
with Poly1305-AES, with keys derived from the password with scrypt, and file names and directory structure are
inside the encrypted data. The tests confirm the observable part: no content, no file name and no setting value
is readable in any file of the repository (**real process**). Adding rclone crypt on top would mean a second
password to lose and no additional protection for restic repositories. rclone crypt is only for a different,
later need: storing plain files (a deliverable to open from another device) encrypted on Drive. Not in the MVP.

**Keys.**

- Each target has its own repository and its own password. One provider's compromise never opens the other.
- The password is generated on the laptop (`openssl rand -base64 32`), shown once, and kept in two places the
  owner controls: a password manager and a printed sheet. It is also stored in the desktop keyring
  (`secret-tool`, or the app's `safeStorage`) so that backups can run unattended.
- A second, independent **recovery key** is added to each repository (`restic key add`) and kept only offline.
  It is the way back in if the daily password is lost or the laptop is gone.
- **Losing every key means the backups are unreadable for ever.** Nobody, including the providers, can recover
  them. The runbook makes writing the recovery key down a step that cannot be skipped.
- Rotation: `restic key add` the new password, then `restic key remove` the old one. This replaces the password;
  it does not re-encrypt. restic's documentation says a leaked key cannot be securely revoked without
  re-encrypting the repository, so **after a suspected leak the answer is a new repository**, not a rotation.
- Provider credentials are separate from encryption keys: the Drive token lives in rclone's configuration
  (use rclone's own configuration password; scope `drive.file`, which per rclone's help gives access only to
  files rclone created); an S3 key lives in the keyring. Revocation is done at the provider.

**Threats.**

| Threat | What protects | What is left |
| --- | --- | --- |
| Laptop lost or stolen | Full-disk encryption (the owner's; not checked here). Remote backups survive. Recovery key offline | Without disk encryption the profile and the keyring are exposed. Revoke Drive, GitHub and provider tokens |
| Google account compromised | The attacker gets ciphertext only | They can delete the repository: the recovery copy and Drive's own trash are the answer |
| GitHub account compromised | No secrets and no private runtime data are in the repository | Code can be changed: review history, rotate tokens |
| Third-party storage compromised | Ciphertext only; separate password | Deletion: the Drive copy remains |
| Compromised agent process | Agents never receive the backup password (the executor's filter removes `*PASSWORD*` variables; `RESTIC_*` and `RCLONE_*` must be added to it at integration). Deleting backups needs an approval card | **No OS sandbox:** a process running as the user can read rclone's configuration file and could call the provider directly. Only a restricted credential (an upload-only key) or a sandbox closes this |
| Accidental deletion (local) | Verified snapshots; restore to an empty folder | Changes since the last verified snapshot |
| Corrupt remote backup | Read-back verification after every upload; a periodic `check --read-data`; the independent copy | Corruption after the last check, until the next one |
| Ransomware on the laptop | Snapshots are immutable to restic; old ones stay until retention removes them | Malware with the Drive token can delete the repository. An upload-only key on the third provider is the real defence (needs verification per provider) |
| Interrupted upload | No snapshot is created; state stays `backup_pending`; the next run completes | — |
| Wrong retention cleanup | Plan first; approval needed; the newest verified snapshot is never removed; nothing is removed when nothing is verified; `prune` is not exposed | A snapshot the user approved removing is gone |
| No network | Local first: the app is unaffected; backups queue as `backup_pending` | No new durability until back online |
| Two devices | Each device has its own sets and its own state; restic allows concurrent backups to one repository | No merging: two devices editing "the same" settings stay two sets |

Rules that hold everywhere: no agent may delete a backup or see a recovery key; a private GitHub repository is not
encryption; nothing sensitive goes into a trace, a log, a prompt or CI output.

## 5. Durability and crash recovery

- **Local first.** The task store writes to the local disk and returns. No state transition waits for a network.
- **Backups are after the fact.** A backup reads a consistent copy. For plain files (today's profile: JSON files
  written atomically) reading them directly is acceptable. **A live SQLite database must never be copied while
  open**: if one is introduced, the set is produced with SQLite's own backup command into a staging folder first.
- **What "safe" means is shown, not implied.** The panel shows per set: last verified time on each target, and
  the state from section 2. "Uploaded" is displayed as "sent, not yet checked".
- **Integrity** is checked three times: restic's authenticated encryption on every read; `check --read-data` of
  the repository after each upload; and an independent comparison of every restored file's SHA-256 with the
  manifest taken before the upload. The manifest hash travels with the snapshot, so a restore on a new computer
  with no local state is verified the same way (**real process**).
- **A crash during a backup** leaves `backup_pending` and possibly a lock file; a lock whose process is gone is
  taken over. Nothing is half-recorded as uploaded.
- **Restore never overwrites.** It goes into an empty folder; switching the app to it is a separate, explicit
  step (runbook), and the previous profile folder is kept until the owner removes it.

## 6. Disk: what takes space, what can be freed, what cannot

Measured in the cloud checkout of this repository (not the laptop):

| Item | Size | Kind | Can it be offloaded to a cloud tier? |
| --- | --- | --- | --- |
| Source files, documents, tests | about 2 MB | Source | Already on GitHub |
| `.git` | 4.7 MB | Source | Already on GitHub |
| `node_modules` for one worktree | 516 MB (Electron alone 278 MB) | Reconstructable | No. Remove when the worktree is idle; `npm ci` brings it back |
| `dist/` after one Linux build | 461 MB | Reconstructable | No. Remove after publishing or testing the build |
| npm cache (`~/.npm`) in this container | 902 MB | Reconstructable | No. `npm cache clean --force` |
| Electron download cache | 119 MB | Reconstructable | No |
| electron-builder cache | 83 MB | Reconstructable | No |
| Speech models (download size, from `speech/models.js`) | Tiny 111 MB, Base 190 MB, Small 610 MB | Reconstructable | No. Remove the ones not in use from Settings |
| The profile's private data (settings, memory, routines, tasks) | Not measured; kilobytes to a few MB in the test profiles | Local truth | Backed up, **not** removed |

What this means, stated plainly:

1. **Cloud storage will not relieve the laptop's disk.** The private data worth backing up is small. What fills
   the disk is dependencies, build outputs, caches and models, and none of that belongs in Drive or anywhere else:
   it is cheaper and safer to delete and re-download.
2. **The saving available is in idle worktrees.** With four worktrees, if each has its own `node_modules`, that is
   about 2 GB (4 × 516 MB; an assumption until measured). Each idle worktree's `node_modules` (about 0.5 GB) and
   `dist/` (about 0.46 GB, where a build was made) can go, at the cost of an `npm ci` (network needed) before it
   is used again. **The four protected worktrees must not be cleaned by any agent**; this is for the owner to do,
   after the uncommitted work in them is committed.
3. **Cannot be offloaded:** running processes, the active worktrees, the Electron runtime, the profile, the models
   in use, the keyring, and a restic cache (it grows with the repository; for a few MB of data it stays small).

Proposed ceilings (`policy.budgetReport` takes them as input; they are proposals, not enforced):
dependencies 0.6 GB per worktree in use; build outputs 0 between builds; package caches 1 GB; models: Tiny plus
one main model; task records 200 MB; logs 50 MB; no local copy of any backup.

Read-only commands to take the real numbers on the laptop (they change nothing):

```bash
df -h /home
du -sh ~/MemoBrOS ~/MemoBrOS-Codex ~/MemoBrOS-Harness-Codex ~/MemoBrOS-Harness-Kiro 2>/dev/null
du -sh ~/MemoBrOS*/node_modules ~/MemoBrOS*/dist 2>/dev/null
du -sh ~/.npm ~/.cache/electron ~/.cache/electron-builder ~/.config/MemoBrOS ~/Respaldos-MemoBrOS 2>/dev/null
du -sh ~/.config/MemoBrOS/* 2>/dev/null | sort -h | tail -15
```

## 7. Integration proposal (not applied)

The smallest changes, in the order they could be reviewed. None is on this branch.

1. **Credential filter.** In `src/main/actions/executor.js`, add `RESTIC_` and `RCLONE_` prefixes to what the
   environment filter removes, with a test. One line; closes the gap named in section 4.
2. **Settings.** In `src/main/store.js` DEFAULTS: `storage: { enabled: false, targets: [], schedule: '',
   retention: { keepWithin: '30d' } }`. Off by default. Passwords go to `safeStorage` under `storage:<target id>`.
3. **Sets from the profile.** A function that lists what the profile contains by category
   (`settings.json` → `app_settings`; `memory.json` → `memory_notes`; `routines.json` → `routines`;
   `tasks/` → `task_records`, once the harness task store exists; `actions.log` → `logs`, never uploaded).
   It needs the harness store's final layout, so it waits for the Codex work to be published.
4. **A manual "Back up now" and "Restore…"** in Settings, both behind approval cards, the second ending with
   "review your standing rules". No schedule yet.
5. **A routine** that calls `backup` with `key = routine id + scheduled time`, after 4 has been used by hand.
6. **Eviction.** `policy.evictionPlan` shown as a list with sizes; deleting stays a button the user presses per
   category. No automatic deletion.

Conflicts with ongoing work: this branch adds new files only, one `test:storage` script line (after the `worker`
line, not on the `test` line that the Codex prompt edits) and one CI job at the end of the workflow file (the
Codex and Kiro prompts add lines in the `unit` job). Steps 1–3 above touch `executor.js` and `store.js`; the Kiro
prompt also adds one default to `store.js`, so step 2 should follow Kiro's merge.

## 8. Migration plan, with rollback

Every step is reversible until step 6, and step 6 is optional.

| Step | Action | Proof it worked | Rollback |
| --- | --- | --- | --- |
| 0 | Publish the laptop's uncommitted work and unpushed commits (the only copies of them) | Branches visible on GitHub | — |
| 1 | Measure the disk (section 6 commands). Decide ceilings | Numbers recorded | — |
| 2 | Install restic and rclone; create the Drive remote with `drive.file` scope; create the repository; write down both keys | `restic snapshots` answers; the recovery key opens the repository from a second terminal | Delete the Drive folder; remove the rclone remote; revoke the grant in the Google account |
| 3 | First manual backup of a **copy** of the profile's small files | `restic check --read-data` passes | Nothing local changed |
| 4 | Restore drill into an empty folder; compare with `diff -r` | No differences | Delete the drill folder |
| 5 | Optional: the independent target, same drill | As 3 and 4 | Delete the bucket; revoke the key |
| 6 | Optional and separate: free reconstructable space in idle worktrees | `df` before and after | `npm ci`, rebuild, re-download |
| 7 | Later, after review: integration steps of section 7 | Tests; a manual backup from the app | Switch `storage.enabled` off; the app is unchanged |

Nothing in this plan deletes a local original because a backup exists. The existing local backup
(`~/Respaldos-MemoBrOS`) is left exactly as it is.

## 9. Status of each claim

| Claim | Evidence |
| --- | --- |
| Placement policy, upload rules, durability states, eviction planning, budget report | **Implemented**, tested without tools (6 checks; runs on Linux and Windows) |
| Encrypted backup; read-back verification; restore with hash comparison; restore with no local state; wrong and missing password; offline target; duplicate requests; interrupted upload; one run at a time; two computers at once; later verification; damaged repository; retention with approval; refusal of never-upload categories; full disk | **Implemented**, **real process** with restic 0.16.4 and rclone 1.60.1 on synthetic data (12 checks) |
| The same path through rclone to a remote | **Real process**, but the rclone remote pointed at a local folder |
| Google Drive as a target; quota behaviour; rate limits; Drive's own trash and versions | **Not tested.** Needs the owner's account and approval |
| Backblaze B2, Cloudflare R2 as targets; upload-only keys | **Not tested.** Designed from documentation |
| Scheduling, quota monitoring, health history, panel views, eviction UI, app integration | **Designed** |
| Windows | The policy suite only. restic on Windows was not run |
| Disk numbers | Cloud checkout only. The laptop's are **unmeasured** |
