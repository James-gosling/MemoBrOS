// Where each kind of ARVI data lives, and what may happen to it. Pure data and pure functions: no Electron, no
// file access, no network. The full reasoning is in docs/engineering/arvi-hybrid-storage-v0.7.md.
//
// Five roles a storage place can have. One place per category is the authority; the others are copies.
//   source     the truth for approved code and documents (the Git repository on GitHub)
//   local      operational state on this computer: what the running app reads and writes
//   archive    encrypted backups on the primary remote (Google Drive)
//   recovery   an encrypted, independent copy with another provider (optional)
//   cache      anything that can be built or downloaded again
//
// upload: 'git'      versioned through Git, never through the backup
//         'backup'   may be included in encrypted backups automatically once backups are switched on
//         'ask'      only after the user approves that set, each time the selection changes
//         'never'    never uploaded by ARVI, encrypted or not
const CATEGORIES = {
  source_code:        { authority: 'source', upload: 'git',    encrypt: false, evict: 'never',     note: 'active worktrees stay local' },
  git_history:        { authority: 'source', upload: 'git',    encrypt: false, evict: 'never',     note: 'unpushed commits exist only locally' },
  architecture_docs:  { authority: 'source', upload: 'git',    encrypt: false, evict: 'never' },
  config_templates:   { authority: 'source', upload: 'git',    encrypt: false, evict: 'never' },
  app_settings:       { authority: 'local',  upload: 'backup', encrypt: true,  evict: 'never' },
  oauth_credentials:  { authority: 'local',  upload: 'never',  encrypt: true,  evict: 'never',     note: 'bound to this computer\'s keyring; sign in again after a restore' },
  recovery_keys:      { authority: 'local',  upload: 'never',  encrypt: true,  evict: 'never',     note: 'kept by the user outside every provider that holds the backups' },
  task_records:       { authority: 'local',  upload: 'backup', encrypt: true,  evict: 'after_verified_backup' },
  approval_history:   { authority: 'local',  upload: 'backup', encrypt: true,  evict: 'never',     note: 'history only: a restored approval is never replayed' },
  redacted_traces:    { authority: 'local',  upload: 'backup', encrypt: true,  evict: 'after_verified_backup' },
  conversation_history:{ authority: 'local', upload: 'ask',    encrypt: true,  evict: 'never' },
  memory_notes:       { authority: 'local',  upload: 'backup', encrypt: true,  evict: 'never' },
  routines:           { authority: 'local',  upload: 'backup', encrypt: true,  evict: 'never' },
  user_files:         { authority: 'local',  upload: 'ask',    encrypt: true,  evict: 'never',     note: 'the user\'s own documents: never removed by ARVI' },
  generated_artifacts:{ authority: 'local',  upload: 'ask',    encrypt: true,  evict: 'after_verified_backup' },
  screenshots_audio:  { authority: 'local',  upload: 'never',  encrypt: true,  evict: 'never',     note: 'not written to disk at all (harness decision)' },
  agent_tool_output:  { authority: 'local',  upload: 'never',  encrypt: true,  evict: 'never',     note: 'only sizes are recorded; full output is not kept' },
  logs:               { authority: 'local',  upload: 'never',  encrypt: true,  evict: 'by_age' },
  local_models:       { authority: 'cache',  upload: 'never',  encrypt: false, evict: 'reconstructable', note: 'downloaded again from the publisher' },
  dependencies:       { authority: 'cache',  upload: 'never',  encrypt: false, evict: 'reconstructable', note: 'npm ci' },
  build_outputs:      { authority: 'cache',  upload: 'never',  encrypt: false, evict: 'reconstructable' },
  package_caches:     { authority: 'cache',  upload: 'never',  encrypt: false, evict: 'reconstructable' },
  temporary_files:    { authority: 'cache',  upload: 'never',  encrypt: false, evict: 'reconstructable' },
  backups:            { authority: 'archive', upload: 'backup', encrypt: true, evict: 'never',    note: 'no second copy of the repository is kept on this computer' },
};

const placement = (category) => {
  const c = CATEGORIES[category];
  if (!c) throw new Error(`Unknown data category "${category}".`);
  return { category, ...c };
};

// May this category be put into a backup set? → { ok, reason }
function mayUpload(category, { approved = false } = {}) {
  const c = placement(category);
  if (c.upload === 'never') return { ok: false, reason: `${category} is never uploaded.` };
  if (c.upload === 'git') return { ok: false, reason: `${category} is versioned with Git, not with the backup.` };
  if (c.upload === 'ask' && !approved) return { ok: false, reason: `${category} is only backed up after you approve it.` };
  return { ok: true, reason: '' };
}

// How far a backup of one set has got on one target. A later state is only reached through the ones before it.
//   local_committed  the data is safely on this computer; nothing has been sent
//   backup_pending   a backup was asked for; it has not finished (offline, interrupted, in progress)
//   uploaded         the tool reported a finished snapshot. This is NOT yet proof that it can be restored
//   verified         the snapshot was read back from the target and every file matched its recorded hash
//   restore_required the local data is known to be missing or damaged and must come from a backup
//   recovery_failed  a restore or a verification failed: the copy on that target cannot be relied on
const DURABILITY = ['local_committed', 'backup_pending', 'uploaded', 'verified'];
const MOVES = {
  local_committed: ['backup_pending', 'restore_required'],
  backup_pending: ['uploaded', 'backup_pending', 'local_committed', 'restore_required'],
  uploaded: ['verified', 'recovery_failed', 'backup_pending', 'restore_required'],
  verified: ['backup_pending', 'recovery_failed', 'restore_required'],
  restore_required: ['local_committed', 'recovery_failed'],
  recovery_failed: ['backup_pending', 'restore_required', 'local_committed'],
};
const canMove = (from, to) => (MOVES[from] || []).includes(to);
// "Durable" means verified on the primary target; "independently durable" also on a recovery target.
function durability(targets) {
  const ok = (role) => targets.some((t) => t.role === role && t.state === 'verified');
  return { durable: ok('primary'), independent: ok('primary') && ok('recovery') };
}

// What may be removed from this computer to free space. It only ever proposes; nothing here deletes.
// items: [{ path, category, bytes, ageDays, verifiedRemote }]  →  { free: [...], keep: [...] } with a reason each
function evictionPlan(items, { maxAgeDays = 30, approved = [] } = {}) {
  const free = [], keep = [];
  for (const it of items) {
    const c = placement(it.category);
    const say = (list, reason) => list.push({ ...it, reason });
    if (c.evict === 'never') say(keep, 'never removed automatically');
    else if (c.evict === 'reconstructable') say(free, 'can be downloaded or built again');
    else if (c.evict === 'by_age') (it.ageDays > maxAgeDays ? say(free, `older than ${maxAgeDays} days`) : say(keep, 'recent'));
    else if (!it.verifiedRemote) say(keep, 'no verified backup of it exists yet');
    else if (!approved.includes(it.category)) say(keep, 'has a verified backup, but removing it needs your approval');
    else say(free, 'has a verified backup and you approved removing local copies of this kind');
  }
  return { free, keep, bytes: free.reduce((n, x) => n + (x.bytes || 0), 0) };
}

// A local disk budget: per-category ceilings in bytes. → [{ category, bytes, limit, over }]
function budgetReport(usage, limits) {
  return Object.keys({ ...usage, ...limits }).map((category) => {
    const bytes = usage[category] || 0, limit = limits[category];
    return { category, bytes, limit: limit ?? null, over: limit != null && bytes > limit };
  });
}

module.exports = { CATEGORIES, placement, mayUpload, DURABILITY, MOVES, canMove, durability, evictionPlan, budgetReport };
