(function (root) {
  "use strict";
  const M = root.SilverInkModel || (typeof require === "function" ? require("./model.js") : null);
  const PREFIX = "silverink:v1:";
  const sessionPath = id => `SilverInk/Sessions/${id}.json`;
  const scopePrefix = scope => `${PREFIX}${encodeURIComponent(scope)}:`;
  const docKey = (id, scope = "") => `${scopePrefix(scope)}session:${id}`;
  const pageKey = (page, scope = "") => `${scopePrefix(scope)}page:${page}`;
  const ackKey = (id, scope = "") => `${scopePrefix(scope)}ack:${id}`;

  function decode(bytes) {
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  class Store {
    constructor(local, remote, scope = "") {
      this.local = local;
      this.remote = remote;
      this.scope = scope;
      this.queue = Promise.resolve();
      this.error = null;
      this.localTimer = null;
      this.pendingLocal = null;
      this.remoteTimer = null;
      this.pendingRemote = null;
      this.pendingRemotePromise = null;
    }

    saveLocal(doc) {
      M.validate(doc);
      const body = JSON.stringify(doc);
      this.local.setItem(docKey(doc.id, this.scope), body);
      this.local.setItem(pageKey(doc.page, this.scope), doc.id);
    }

    bufferLocal(doc, onError, delay = 100) {
      this.pendingLocal = { doc, onError };
      // Keep a bounded recovery interval during a long stroke. A new point
      // updates the snapshot without restarting the timer.
      if (this.localTimer !== null) return;
      this.localTimer = setTimeout(() => {
        this.localTimer = null;
        try { this.flushLocal(); }
        catch (e) { onError(e); }
      }, delay);
    }

    flushLocal() {
      if (this.localTimer !== null) clearTimeout(this.localTimer);
      this.localTimer = null;
      const pending = this.pendingLocal;
      this.pendingLocal = null;
      if (pending) this.saveLocal(pending.doc);
    }

    readLocal(id) {
      const body = this.local.getItem(docKey(id, this.scope));
      return body ? M.validate(JSON.parse(body)) : null;
    }

    forget(id, page) {
      this.local.removeItem(docKey(id, this.scope));
      this.local.removeItem(ackKey(id, this.scope));
      if (this.local.getItem(pageKey(page, this.scope)) === id) {
        this.local.removeItem(pageKey(page, this.scope));
      }
    }

    async readRemote(id) {
      try {
        return M.validate(decode(await this.remote.readFile(sessionPath(id))));
      } catch (e) {
        if (e && /not found|404|does not exist|no such file/i.test(String(e.message || e))) return null;
        throw e;
      }
    }

    async open(page) {
      const localId = this.local.getItem(pageKey(page, this.scope));
      const candidates = new Set(localId ? [localId] : []);
      // Recover a completed local write even if the page index write failed.
      const sessionPrefix = `${scopePrefix(this.scope)}session:`;
      for (let i = 0; i < this.local.length; i++) {
        const key = this.local.key(i);
        if (key && key.startsWith(sessionPrefix)) candidates.add(key.slice(sessionPrefix.length));
      }
      let listingError = null;
      try {
        const files = await this.remote.listFiles();
        for (const file of files) {
          const match = /^SilverInk\/Sessions\/([\w-]{8,80})\.json$/.exec(file.name);
          if (match) candidates.add(match[1]);
        }
      } catch (e) {
        listingError = e;
      }
      const docs = [];
      const unsynced = new Set();
      for (const id of candidates) {
        const local = this.readLocal(id);
        if (local && local.page !== page) continue;
        if (local?.blockEditOf) continue;
        let remote = null;
        try { remote = await this.readRemote(id); }
        catch (e) {
          if (!local) { listingError = e; continue; }
          if (/Invalid or unsupported|exceeds limits/i.test(String(e.message || e))) {
            e.recovery = local;
            throw e;
          }
          listingError = e;
        }
        // Edit block resolves its own private draft and conflict state.
        if (remote?.blockEditOf) continue;
        if (local && remote && local.page !== remote.page) {
          const error = new Error(`Session ${id} has conflicting page ownership; download the local recovery JSON`);
          error.recovery = local;
          throw error;
        }
        if (local && remote && local.page === page && remote.page === page) {
          const localBase = local.inProgress ? { ...local, inProgress: null } : local;
          const acknowledged = Number(this.local.getItem(ackKey(id, this.scope)) ?? -1);
          if ((local.inProgress && remote.revision > local.revision) ||
              (remote.revision > local.revision && local.revision > acknowledged) ||
              (local.revision === remote.revision && JSON.stringify(localBase) !== JSON.stringify(remote))) {
            const error = new Error(`Session ${id} has divergent copies; download the local recovery JSON before proceeding`);
            error.recovery = local;
            throw error;
          }
        }
        const selected = local && (!remote || local.revision > remote.revision ||
          (local.revision === remote.revision && local.inProgress)) ? local : remote;
        if (selected && selected.page === page) {
          docs.push(selected);
          if (selected === local && (!remote || local.revision > remote.revision || local.inProgress)) unsynced.add(id);
        }
      }
      // Surface unsynced work first, then the last selected session.
      docs.sort((a, b) => Number(unsynced.has(b.id)) - Number(unsynced.has(a.id)) ||
        Number(b.id === localId) - Number(a.id === localId) || b.updatedAt - a.updatedAt);
      const doc = docs[0] || M.create(page);
      this.saveLocal(doc);
      if (docs.length && !unsynced.has(doc.id)) {
        try { this.local.setItem(ackKey(doc.id, this.scope), String(doc.revision)); } catch { /* safe false conflict later */ }
      }
      if (!docs.length || unsynced.has(doc.id)) this.schedule(doc).catch(() => {});
      return { doc, sessions: docs.length ? docs : [doc], warning: listingError ? `Space unavailable: ${listingError.message || listingError}` : null };
    }

    newSession(page) {
      const doc = M.create(page);
      this.saveLocal(doc);
      return doc;
    }

    schedule(doc) {
      if (this.remoteTimer !== null) clearTimeout(this.remoteTimer);
      this.remoteTimer = null;
      const pending = this.pendingRemote;
      this.pendingRemote = null;
      const snapshot = JSON.stringify(M.validate(doc));
      const path = sessionPath(doc.id);
      const id = doc.id, revision = doc.revision;
      this.queue = this.queue.catch(() => {}).then(async () => {
        try {
          await this.remote.writeFile(path, new TextEncoder().encode(snapshot));
          try { this.local.setItem(ackKey(id, this.scope), String(revision)); } catch { /* retained in Space */ }
          this.error = null;
        } catch (e) {
          this.error = e;
          throw e;
        }
      });
      if (pending) this.queue.then(pending.resolve, pending.reject);
      this.pendingRemotePromise = null;
      return this.queue;
    }

    bufferRemote(doc, delay = 300) {
      this.pendingRemote ??= {};
      this.pendingRemote.doc = doc;
      if (!this.pendingRemotePromise) {
        this.pendingRemotePromise = new Promise((resolve, reject) => {
          this.pendingRemote.resolve = resolve;
          this.pendingRemote.reject = reject;
        });
      }
      if (this.remoteTimer !== null) clearTimeout(this.remoteTimer);
      this.remoteTimer = setTimeout(() => {
        this.remoteTimer = null;
        const pending = this.pendingRemote;
        if (pending) this.schedule(pending.doc.inProgress
          ? { ...pending.doc, inProgress: null } : pending.doc).catch(() => {});
      }, delay);
      return this.pendingRemotePromise;
    }

    async flush() {
      try {
        this.flushLocal();
        if (this.pendingRemote) await this.schedule(this.pendingRemote.doc.inProgress
          ? { ...this.pendingRemote.doc, inProgress: null } : this.pendingRemote.doc);
        else await this.queue;
        return true;
      }
      catch { return false; }
    }
  }

  const api = { Store, sessionPath, docKey, pageKey };
  root.SilverInkStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
