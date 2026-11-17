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

// Every file under dir with its SHA-256. Links are not followed. → { files: { 'a/b.txt': { sha256, bytes } }, hash, bytes, count }
function manifest(dir) {
  const files = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) { const data = fs.readFileSync(full); files[r] = { sha256: crypto.createHash('sha256').update(data).digest('hex'), bytes: data.length }; }
    }
  };
  walk(dir, '');
  const hash = crypto.createHash('sha256').update(Object.entries(files).map(([f, v]) => `${f}\0${v.sha256}\n`).join('')).digest('hex');
  return { files, hash, bytes: Object.values(files).reduce((n, v) => n + v.bytes, 0), count: Object.keys(files).length };
}

// opts: { stateDir, targets: [{ id, role: 'primary'|'recovery', repo, env }], getPassword(target) → text,
//         approve({ kind, title, detail }) → true|false, restic }
function createOrchestrator({ stateDir, targets, getPassword, approve = async () => false, restic = defaultRestic }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'storage.json'), lockFile = path.join(stateDir, 'backup.lock');
  const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { sets: {} }; } };
  const save = (s) => { const tmp = `${stateFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(s, null, 1)); fs.renameSync(tmp, stateFile); };
  const target = (id) => { const t = targets.find((x) => x.id === id); if (!t) throw new StorageError('unknown_target', `There is no backup target "${id}".`); return t; };
  const access = async (t, extra = {}) => ({ repo: t.repo, env: t.env || {}, password: await getPassword(t), ...extra });

  // One run at a time. A lock left by a process that no longer exists is taken over.
  function lock() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const fd = fs.openSync(lockFile, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return () => fs.rmSync(lockFile, { force: true }); }
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
    const unlock = lock();
    try {
      const m = manifest(dir);
      const s = load();
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
    if (fs.existsSync(into) && fs.readdirSync(into).length) throw new StorageError('not_empty', `${into} is not empty. A restore never writes over existing files; choose an empty folder.`);
    const all = (await restic.snapshots(await access(t, { signal, tags: [`set:${name}`] }))).sort((a, b) => (a.time < b.time ? -1 : 1));
    const snap = snapshot ? all.find((x) => x.id.startsWith(snapshot)) : all.at(-1);
    if (!snap) throw new StorageError('not_found', `There is no backup of "${name}" on ${t.id}.`);
    const expected = (snap.tags.find((x) => x.startsWith('manifest:')) || '').slice(9);
    fs.mkdirSync(into, { recursive: true });
    const s = load();
    const known = Boolean(s.sets[name]?.targets[t.id]);
    try {
      await restic.restore(snap.id, into, await access(t, { signal }));
      const got = manifest(into);
      if (!expected || got.hash !== expected) throw new StorageError('corrupt', 'The restored files do not match the hashes recorded when they were backed up.');
      return { snapshot: snap.id, time: snap.time, files: got.count, bytes: got.bytes, verified: true };
    } catch (e) {
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
    return { keep: [...plan.keep, ...plan.remove.filter((id) => id === protectedId)], remove: plan.remove.filter((id) => id !== protectedId), hasVerified: Boolean(protectedId) };
  }
  // Removes old snapshots, only with the user's approval and only when a verified snapshot remains.
  async function applyRetention(opts) {
    const plan = await retentionPlan(opts);
    if (!plan.hasVerified) throw new StorageError('not_allowed', 'No verified backup of this set exists on that target, so nothing is removed.');
    if (!plan.remove.length) return { removed: [] };
    const yes = await approve({ kind: 'delete_backups', title: `Remove ${plan.remove.length} old backup${plan.remove.length > 1 ? 's' : ''} of "${opts.set}"?`, detail: `From ${opts.on}. ${plan.keep.length} will be kept. This cannot be undone.` });
    if (yes !== true) throw new StorageError('declined', 'Nothing was removed.');
    await restic.forget(plan.remove, await access(target(opts.on)));
    return { removed: plan.remove };
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
