// ARVI Storage Orchestrator, first slice: encrypted backups of named sets of local files to one or more targets,
// with honest states. It coordinates; restic stores and encrypts; policy.js says what is allowed. No Electron.
//
// What it guarantees:
//  - local first: nothing here is needed for the app to keep working, and a target being offline changes only the
//    backup state, never the local data;
//  - "verified" means the snapshot was read back from the target and every file matched the hash taken before
//    the upload. A finished upload alone is "uploaded";
//  - it never deletes local files, never restores over existing files, and removes old snapshots only through
//    applyRetention(), which needs the user's approval and never removes the newest verified snapshot;
//  - one backup run per state folder at a time.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const policy = require('./policy');
const defaultRestic = require('./restic');

class StorageError extends Error { constructor(kind, message) { super(message); this.kind = kind; } }

// Every file under dir with its SHA-256. Links are never followed. Anything that is neither a plain file nor a
// folder (a link, a device, a socket) is listed in `unsafe`: a link in a backup would be recreated by a restore
// and could point anywhere.
// → { files: { 'a/b.txt': { sha256, bytes } }, unsafe: ['x'], hash, bytes, count }
function manifest(dir) {
  const files = {}, unsafe = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) unsafe.push(r);
      else if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) { const data = fs.readFileSync(full); files[r] = { sha256: crypto.createHash('sha256').update(data).digest('hex'), bytes: data.length }; }
      else unsafe.push(r);
    }
  };
  if (fs.lstatSync(dir).isSymbolicLink()) throw new StorageError('not_allowed', `${dir} is a link. A backup set or a restore folder must be a real folder.`);
  walk(dir, '');
  const hash = crypto.createHash('sha256').update(Object.entries(files).map(([f, v]) => `${f}\0${v.sha256}\n`).join('')).digest('hex');
  return { files, unsafe, hash, bytes: Object.values(files).reduce((n, v) => n + v.bytes, 0), count: Object.keys(files).length };
}

const STATE_VERSION = 1;

// opts: { stateDir, targets: [{ id, role: 'primary'|'recovery', repo, env }], getPassword(target) → text,
//         approve({ kind, title, detail }) → true|false, restic }
function createOrchestrator({ stateDir, targets, getPassword, approve = async () => false, restic = defaultRestic }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'storage.json'), lockFile = path.join(stateDir, 'backup.lock');
  // The record of what was backed up where. Four cases, and only two of them may be used:
  //   no file          a new installation: start empty
  //   a valid file     use it
  //   a damaged file   stop. Treating it as empty would forget which snapshots were verified, and retention or
  //                    eviction decided on that would be wrong. The file is left exactly as it is for the user.
  //   another version  stop: written by a newer (or unknown) MemoBrOS
  function load() {
    let text;
    try { text = fs.readFileSync(stateFile, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return { version: STATE_VERSION, sets: {} }; throw new StorageError('state_unreadable', `The backup record cannot be read (${e.code || e.message}). Nothing was changed.`); }
    let s;
    try { s = JSON.parse(text); } catch { throw new StorageError('state_corrupt', `The backup record (${stateFile}) is damaged. Nothing was changed. Move it aside to start a new record; existing backups stay where they are and can still be restored.`); }
    const shape = s && typeof s === 'object' && !Array.isArray(s) && s.sets && typeof s.sets === 'object' && !Array.isArray(s.sets)
      && Object.values(s.sets).every((r) => r && typeof r === 'object' && r.targets && typeof r.targets === 'object' && Object.values(r.targets).every((t) => t && typeof t.state === 'string' && policy.MOVES[t.state]));
    if (!shape) throw new StorageError('state_corrupt', `The backup record (${stateFile}) is damaged. Nothing was changed. Move it aside to start a new record; existing backups stay where they are and can still be restored.`);
    if (s.version !== STATE_VERSION) throw new StorageError('state_unsupported', `The backup record was written by another version of MemoBrOS (format ${String(s.version)}; this one reads ${STATE_VERSION}). Nothing was changed.`);
    return s;
  }
  const save = (s) => { const tmp = `${stateFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ ...s, version: STATE_VERSION }, null, 1)); fs.renameSync(tmp, stateFile); };
  // Scratch folders left by a run that died. Only called while holding the lock, so none of them is in use.
  const sweep = () => { for (const e of fs.readdirSync(stateDir)) if (/^verify-/.test(e) || /\.tmp$/.test(e)) fs.rmSync(path.join(stateDir, e), { recursive: true, force: true }); };
  const target = (id) => { const t = targets.find((x) => x.id === id); if (!t) throw new StorageError('unknown_target', `There is no backup target "${id}".`); return t; };
  const access = async (t, extra = {}) => ({ repo: t.repo, env: t.env || {}, password: await getPassword(t), ...extra });

  // One run at a time. A lock left by a process that no longer exists is taken over.
  function lock() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const fd = fs.openSync(lockFile, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); sweep(); return () => fs.rmSync(lockFile, { force: true }); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let alive = true;
        try { process.kill(Number(fs.readFileSync(lockFile, 'utf8')), 0); } catch (k) { alive = k.code === 'EPERM'; }
        if (alive) throw new StorageError('busy', 'Another backup is running.');
        fs.rmSync(lockFile, { force: true });
      }
    }
    throw new StorageError('busy', 'Another backup is running.');
  }

  function setState(s, name, id, to, patch = {}) {
    const rec = s.sets[name].targets[id] || (s.sets[name].targets[id] = { state: 'local_committed' });
    if (rec.state !== to && !policy.canMove(rec.state, to)) throw new StorageError('internal', `A backup cannot go from ${rec.state} to ${to}.`);
    Object.assign(rec, { state: to, at: new Date().toISOString(), error: '' }, patch);
    save(s);
    return rec;
  }

  // Reads a snapshot back from the target into a scratch folder and compares every file with the expected hashes.
  async function verify(t, snapshot, expectedHash, signal) {
    const scratch = fs.mkdtempSync(path.join(stateDir, 'verify-'));
    try {
      // Reading everything back needs the repository to itself; another computer may still be uploading.
      for (let attempt = 0; ; attempt++) {
        try { await restic.check(await access(t, { signal })); break; }
        catch (e) { if (e.kind !== 'locked' || attempt >= 8) throw e; await new Promise((r) => setTimeout(r, 2000)); }
      }
      await restic.restore(snapshot, scratch, await access(t, { signal }));
      if (manifest(scratch).hash !== expectedHash) throw new StorageError('corrupt', 'What came back from the backup is not what was sent.');
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }

  // Backs up the contents of `dir` as the set `name` to every target (or the ones listed).
  // → { set, manifest: { hash, count, bytes }, targets: { id: { state, snapshot, error } } }
  async function backup({ set: name, dir, category, approved = false, key = '', only, signal, limitKiB }) {
    const allowed = policy.mayUpload(category, { approved });
    if (!allowed.ok) throw new StorageError('not_allowed', allowed.reason);
    if (!policy.safeName(name) || (key && !policy.safeName(key))) throw new StorageError('not_allowed', 'A set name or key may only contain letters, digits and . _ @ : + -');
    const unlock = lock();
    try {
      const s = load(); // first: an untrustworthy record stops everything before a single file is read
      const m = manifest(dir);
      // The category is the caller's claim. These checks look at the files themselves, and refuse the whole set.
      if (m.unsafe.length) throw new StorageError('not_allowed', `This folder contains links or special files, which are never backed up: ${m.unsafe.slice(0, 5).join(', ')}.`);
      const banned = Object.keys(m.files).map((f) => [f, policy.forbiddenFile(f)]).filter(([, why]) => why);
      if (banned.length) throw new StorageError('not_allowed', `Nothing was sent. This folder contains files that are never backed up: ${banned.slice(0, 5).map(([f, why]) => `${f} (${why})`).join(', ')}${banned.length > 5 ? ` and ${banned.length - 5} more` : ''}.`);
      if (!m.count) throw new StorageError('not_allowed', 'There is nothing in this folder to back up.');
      const rec = s.sets[name] || (s.sets[name] = { category, targets: {} });
      const same = rec.manifest === m.hash;
      Object.assign(rec, { category, manifest: m.hash, count: m.count, bytes: m.bytes, key });
      save(s);
      for (const t of targets.filter((x) => !only || only.includes(x.id))) {
        const cur = rec.targets[t.id];
        // Asked twice for the same content (same key, or simply nothing changed): the verified copy stands.
        if (same && cur?.state === 'verified') continue;
        setState(s, name, t.id, 'backup_pending', { snapshot: '' });
        try {
          const done = await restic.backup(dir, await access(t, { signal, limitKiB, tags: [`set:${name}`, `manifest:${m.hash}`, ...(key ? [`key:${key}`] : [])] }));
          setState(s, name, t.id, 'uploaded', { snapshot: done.snapshot });
          try { await verify(t, done.snapshot, m.hash, signal); setState(s, name, t.id, 'verified'); }
          catch (e) { if (['corrupt', 'wrong_password'].includes(e.kind)) setState(s, name, t.id, 'recovery_failed', { error: e.message }); else { rec.targets[t.id].error = e.message; rec.targets[t.id].errorKind = e.kind || 'failed'; save(s); } }
        } catch (e) {
          // Offline, interrupted, out of space, no password: the local data is untouched and the backup is still owed.
          rec.targets[t.id].error = e.message; rec.targets[t.id].errorKind = e.kind || 'failed'; save(s);
        }
      }
      return status(name);
    } finally { unlock(); }
  }

  // Reads back a snapshot that was uploaded but not yet verified (the check was interrupted, or the target was busy).
  async function verifyUploaded({ set: name, on, signal }) {
    const t = target(on), s = load(), rec = s.sets[name]?.targets[t.id];
    if (!rec || rec.state !== 'uploaded') return status(name);
    const unlock = lock();
    try {
      try { await verify(t, rec.snapshot, s.sets[name].manifest, signal); setState(s, name, t.id, 'verified'); }
      catch (e) { if (['corrupt', 'wrong_password'].includes(e.kind)) setState(s, name, t.id, 'recovery_failed', { error: e.message }); else { rec.error = e.message; rec.errorKind = e.kind || 'failed'; save(s); } }
      return status(name);
    } finally { unlock(); }
  }

  // Restores the newest snapshot of a set (or the one named) from one target into an empty folder, then checks it.
  // It works without any local state: the expected hashes travel with the snapshot.
  async function restore({ set: name, from, into, snapshot, signal }) {
    const t = target(from);
    if (!policy.safeName(name)) throw new StorageError('not_allowed', 'That is not a valid set name.');
    // The destination must be a real, empty folder (or not exist yet). A link is refused: it could lead a restore
    // into a folder that is not empty, or not the user's.
    let existed = false;
    try { const st = fs.lstatSync(into); existed = true; if (st.isSymbolicLink() || !st.isDirectory()) throw new StorageError('not_empty', `${into} is a link or a file. A restore needs a real, empty folder.`); }
    catch (e) { if (e instanceof StorageError) throw e; if (e.code !== 'ENOENT') throw new StorageError('not_empty', `${into} cannot be used (${e.code}).`); }
    if (existed && fs.readdirSync(into).length) throw new StorageError('not_empty', `${into} is not empty. A restore never writes over existing files; choose an empty folder.`);
    if (snapshot !== undefined && !/^[0-9a-f]{8,64}$/.test(String(snapshot))) throw new StorageError('not_found', 'A snapshot is named by at least 8 characters of its id.');
    const all = (await restic.snapshots(await access(t, { signal, tags: [`set:${name}`] }))).sort((a, b) => (a.time < b.time ? -1 : 1));
    const matches = snapshot ? all.filter((x) => x.id.startsWith(snapshot)) : all.slice(-1);
    if (matches.length > 1) throw new StorageError('not_found', 'More than one backup starts with those characters; give more of the id.');
    const snap = matches[0];
    if (!snap) throw new StorageError('not_found', `There is no backup of "${name}" on ${t.id}.`);
    const expected = (snap.tags.find((x) => x.startsWith('manifest:')) || '').slice(9);
    fs.mkdirSync(into, { recursive: true });
    // The local record is only updated when it can be trusted. A restore itself does not depend on it: this is
    // the operation that must still work when the record is damaged or gone.
    let s = null;
    try { s = load(); } catch { /* restore anyway; the record is left alone */ }
    const known = Boolean(s?.sets[name]?.targets[t.id]);
    try {
      await restic.restore(snap.id, into, await access(t, { signal }));
      const got = manifest(into);
      if (got.unsafe.length) throw new StorageError('corrupt', `The backup contains links or special files (${got.unsafe.slice(0, 3).join(', ')}), which ARVI never writes. It was not restored.`);
      if (!expected || got.hash !== expected) throw new StorageError('corrupt', 'The restored files do not match the hashes recorded when they were backed up.');
      return { snapshot: snap.id, time: snap.time, files: got.count, bytes: got.bytes, verified: true };
    } catch (e) {
      // A restore that did not finish, or did not verify, leaves nothing behind that could be mistaken for a good
      // one. The folder was empty (or did not exist) before, so everything in it is ours to remove.
      try { if (existed) { for (const x of fs.readdirSync(into)) fs.rmSync(path.join(into, x), { recursive: true, force: true }); } else fs.rmSync(into, { recursive: true, force: true }); } catch { /* reported below anyway */ }
      if (known && ['corrupt', 'wrong_password'].includes(e.kind)) { s.sets[name].targets[t.id] = { ...s.sets[name].targets[t.id], state: 'recovery_failed', error: e.message, at: new Date().toISOString() }; save(s); }
      throw e;
    }
  }

  // Which old snapshots a rule would remove. Never the newest verified one. Removes nothing.
  async function retentionPlan({ set: name, on, keepLast, keepWithin }) {
    const t = target(on);
    const plan = await restic.forgetPlan(await access(t, { tags: [`set:${name}`], keepLast, keepWithin }));
    const rec = load().sets[name]?.targets[t.id];
    const protectedId = rec?.state === 'verified' ? rec.snapshot : '';
    const remove = plan.remove.filter((id) => id !== protectedId).sort();
    // The digest names exactly this deletion: which set, where, which snapshots go and which one is protected.
    const digest = crypto.createHash('sha256').update(JSON.stringify([name, t.id, remove, protectedId])).digest('hex');
    return { keep: [...plan.keep, ...plan.remove.filter((id) => id === protectedId)], remove, hasVerified: Boolean(protectedId), protected: protectedId, digest };
  }
  // Removes old snapshots, only with the user's approval and only when a verified snapshot remains.
  async function applyRetention(opts) {
    const plan = await retentionPlan(opts);
    if (!plan.hasVerified) throw new StorageError('not_allowed', 'No verified backup of this set exists on that target, so nothing is removed.');
    if (!plan.remove.length) return { removed: [] };
    const yes = await approve({ kind: 'delete_backups', title: `Remove ${plan.remove.length} old backup${plan.remove.length > 1 ? 's' : ''} of "${opts.set}"?`, detail: `From ${opts.on}. ${plan.keep.length} will be kept. This cannot be undone.`, snapshots: plan.remove, digest: plan.digest });
    if (yes !== true) throw new StorageError('declined', 'Nothing was removed.');
    // The answer may have taken minutes. It was given for one exact deletion; if anything about it changed in the
    // meantime (a new backup, a different verified snapshot, another device's snapshots), it no longer applies.
    // No local backup can start between this check and the removal: both hold the same lock.
    const unlock = lock();
    try {
      const now = await retentionPlan(opts);
      if (now.digest !== plan.digest || !now.hasVerified) throw new StorageError('plan_changed', 'The backups changed while you were deciding, so nothing was removed. Look at the new plan and decide again.');
      const still = (await restic.snapshots(await access(target(opts.on), { tags: [`set:${opts.set}`] }))).map((x) => x.id);
      if (!still.includes(now.protected)) throw new StorageError('plan_changed', 'The verified backup is no longer on that target, so nothing was removed.');
      await restic.forget(now.remove, await access(target(opts.on)));
      return { removed: now.remove };
    } finally { unlock(); }
  }

  function status(name) {
    const s = load();
    const one = (n) => { const r = s.sets[n]; const list = targets.map((t) => ({ id: t.id, role: t.role, ...(r.targets[t.id] || { state: 'local_committed' }) })); return { set: n, category: r.category, manifest: { hash: r.manifest, count: r.count, bytes: r.bytes }, targets: Object.fromEntries(list.map((x) => [x.id, x])), ...policy.durability(list) }; };
    return name ? (s.sets[name] ? one(name) : null) : Object.keys(s.sets).map(one);
  }
  // The local data of a set is gone or damaged: say so, so that nothing treats the old "verified" as current.
  function markRestoreRequired(name) { const s = load(); for (const id of Object.keys(s.sets[name]?.targets || {})) setState(s, name, id, 'restore_required'); return status(name); }

  return { backup, verifyUploaded, restore, retentionPlan, applyRetention, status, markRestoreRequired };
}

module.exports = { createOrchestrator, manifest, StorageError };
