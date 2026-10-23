(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DesignSync = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const ordered = value => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === 'object'
      ? Object.keys(value).sort().reduce((result, key) => {
        result[key] = ordered(value[key]);
        return result;
      }, Object.create(null)) : value;
  const equal = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));

  class DesignSync {
    constructor(options) {
      this.options = options;
      this._active = false;
      this._epoch = 0;
      this._editVersion = 0;
      this._pending = null;
      this._baseRevision = null;
      this._baseContent = null;
      this._updatedAt = null;
      this._unconfirmed = null;
      this._conflict = undefined;
      this._status = { kind: 'connecting' };
      this._timer = null;
      this._running = null;
      this._resolving = null;
      this._applying = false;
      this._loaded = false;
      this._preloadEdited = false;
      this._again = false;
    }

    getStatus() { return copy(this._status); }

    _live(epoch) { return this._active && epoch === this._epoch; }

    _statusAs(kind, message) {
      this._status = { kind, revision: this._baseRevision, updatedAt: this._updatedAt };
      if (message) this._status.message = message;
      if (kind === 'conflict') this._status.remote = copy(this._conflict);
      if (this.options.onStatus) this.options.onStatus(this.getStatus());
      return this.getStatus();
    }

    _validContent(content) {
      if (content == null || typeof content !== 'object') throw new Error('Invalid design');
      const input = copy(content);
      const validated = this.options.validate(input);
      if (validated === false) throw new Error('Invalid design');
      return copy(validated && typeof validated === 'object' ? validated : input);
    }

    _local() { return this._validContent(this.options.readLocal()); }

    _row(row) {
      if (row === null) return null;
      if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1) {
        throw new Error('Invalid revision');
      }
      return { ...row, content: this._validContent(row.content) };
    }

    _persist() {
      try {
        this.options.storage.setItem(this.options.storageKey, JSON.stringify({
          version: 1, pending: this._pending, baseRevision: this._baseRevision,
          baseContent: this._baseContent, unconfirmed: this._unconfirmed
        }));
        return true;
      } catch (_) {
        this._statusAs('error', '浏览器无法保存待同步草稿，请先导出方案并释放存储空间。');
        return false;
      }
    }

    _apply(content) {
      this._applying = true;
      try { this.options.applyRemote(copy(content)); }
      finally { this._applying = false; }
    }

    _initialize() {
      try {
        const local = this._local();
        const raw = this.options.storage.getItem(this.options.storageKey);
        const saved = raw == null ? null : JSON.parse(raw);
        this._pristine = typeof this.options.pristine === 'function'
          ? this.options.pristine() : Boolean(this.options.pristine);
        if (this._preloadEdited) this._pristine = false;
        this._pending = null;
        this._baseRevision = null;
        this._baseContent = null;
        this._conflict = undefined;
        this._updatedAt = null;
        this._unconfirmed = null;
        if (saved) {
          if (saved.version !== 1 || !Object.prototype.hasOwnProperty.call(saved, 'pending')) {
            throw new Error('Invalid draft');
          }
          if (saved.baseRevision != null) {
            if (!Number.isSafeInteger(saved.baseRevision) || saved.baseRevision < 1) throw new Error('Invalid base');
            this._baseRevision = saved.baseRevision;
            this._baseContent = this._validContent(saved.baseContent);
          }
          if (saved.pending != null) {
            this._pending = this._validContent(saved.pending);
            this._pristine = false;
          }
          if (saved.unconfirmed != null) {
            if (!Number.isSafeInteger(saved.unconfirmed.expectedRevision)
              || saved.unconfirmed.expectedRevision < 0) throw new Error('Invalid attempted revision');
            this._unconfirmed = {
              expectedRevision: saved.unconfirmed.expectedRevision,
              content: this._validContent(saved.unconfirmed.content)
            };
          }
          if (this._pending !== null && !equal(local, this._pending)) {
            if (!equal(local, this._baseContent)) {
              this._statusAs('error', '当前方案与待同步草稿不同。请先导出两份方案，再导入要继续的版本。');
              return false;
            }
            if (this.options.isEditing()) {
              this._statusAs('pending', '结束当前编辑后恢复待同步草稿。');
              return false;
            }
            this._apply(this._pending);
          }
        }
        if (this._pending === null && (this._baseContent !== null
          ? !equal(local, this._baseContent) : !this._pristine)) {
          this._pending = local;
        }
        this._loaded = true;
        return this._persist();
      } catch (_) {
        this._statusAs('error', '本机待同步草稿无法读取，请先导出备份后再处理。');
        return false;
      }
    }

    start() {
      if (this._active) return this.sync();
      this._active = true;
      this._epoch += 1;
      this._loaded = false;
      this._preloadEdited = false;
      this._statusAs('connecting', '正在连接云端…');
      return this.sync();
    }

    changed() {
      if (!this._active || this._applying) return;
      if (!this._loaded) {
        this._preloadEdited = true;
        this._editVersion += 1;
        this._statusAs('error', '待同步草稿尚未读取完成，请先导出当前方案备份。');
        return;
      }
      try {
        this._pending = this._local();
        this._pristine = false;
        this._editVersion += 1;
        if (!this._persist()) return;
        if (this._conflict !== undefined) this._statusAs('conflict', '本机和云端都有修改，请选择保留的版本。');
        else this._statusAs('pending', '修改已保存在本机，等待同步。');
        clearTimeout(this._timer);
        this._timer = setTimeout(() => { this._timer = null; this.sync(); }, 800);
      } catch (_) {
        this._statusAs('error', '当前方案未通过校验，已暂停云端同步。');
      }
    }

    sync() {
      if (!this._active) return Promise.resolve(this.getStatus());
      if (this._resolving) return this._resolving;
      if (this._running) { this._again = true; return this._running; }
      const epoch = this._epoch;
      // Defer one microtask so _running exists even when initialization fails synchronously.
      const work = Promise.resolve().then(async () => {
        do {
          this._again = false;
          if (!this._live(epoch)) break;
          if (!this._loaded && !this._initialize()) break;
          await this._syncOnce(epoch);
        } while (this._again && this._live(epoch));
        return this.getStatus();
      }).catch(() => {
        if (this._live(epoch)) this._statusAs('error', '同步遇到异常，本机方案已保留。');
        return this.getStatus();
      }).finally(() => { if (this._running === work) this._running = null; });
      this._running = work;
      return work;
    }

    _showConflict(remote, message) {
      this._conflict = copy(remote);
      return this._statusAs('conflict', message || '本机和云端都有修改，请选择保留的版本。');
    }

    _acknowledge(row) {
      this._baseRevision = row.revision;
      this._baseContent = copy(row.content);
      this._updatedAt = row.updated_at || null;
      this._unconfirmed = null;
      if (equal(this._pending, row.content)) this._pending = null;
      this._conflict = undefined;
      this._pristine = false;
      if (!this._persist()) return;
      this._statusAs(this._pending === null ? 'synced' : 'pending',
        this._pending === null ? '已与云端同步。' : '还有新的修改等待同步。');
    }

    _acceptRemote(row) {
      if (this.options.isEditing()) {
        this._statusAs('pending', '正在编辑，结束后继续同步。');
        return false;
      }
      this._apply(row.content);
      this._pending = null;
      this._acknowledge(row);
      return true;
    }

    async _syncOnce(epoch) {
      if (!this._persist()) return;
      if (this._conflict !== undefined) {
        this._statusAs('conflict', '本机和云端都有修改，请选择保留的版本。');
        return;
      }
      if (this.options.isEditing()) {
        this._statusAs('pending', '正在编辑，结束后继续同步。');
        return;
      }
      let remote;
      try { remote = await this.options.readRemote(); }
      catch (_) {
        if (this._live(epoch)) this._statusAs('offline', '暂时无法连接云端，修改仍保存在本机。');
        return;
      }
      if (!this._live(epoch)) return;
      try { remote = this._row(remote); }
      catch (_) {
        this._statusAs('error', '云端方案未通过校验，已保留本机方案。');
        return;
      }
      if (this.options.isEditing()) {
        this._statusAs('pending', '正在编辑，结束后继续同步。');
        return;
      }
      const local = this._local();
      if (remote === null) {
        if (this._baseRevision !== null) { this._showConflict(null, '云端方案已不存在，请确认是否重新上传本机方案。'); return; }
        this._pending = local;
        if (this._persist()) await this._write(local, 0, epoch);
        return;
      }
      if (equal(local, remote.content)) { this._acknowledge(remote); return; }
      // A timed-out request may have committed. Recognize that exact write even
      // when further local edits arrived, and keep those newer edits pending.
      if (this._unconfirmed && remote.revision > this._unconfirmed.expectedRevision
        && equal(remote.content, this._unconfirmed.content)) {
        this._pending = local;
        this._acknowledge(remote);
        if (this._status.kind !== 'error') await this._write(local, remote.revision, epoch);
        return;
      }
      if (this._baseRevision === null) {
        if (this._pristine && this._pending === null) this._acceptRemote(remote);
        else this._showConflict(remote);
        return;
      }
      if (equal(local, this._baseContent)) this._pending = null;
      else this._pending = local;
      if (!equal(remote.content, this._baseContent)) {
        if (this._pending === null) this._acceptRemote(remote);
        else if (this._persist()) this._showConflict(remote);
        return;
      }
      this._baseRevision = remote.revision;
      this._updatedAt = remote.updated_at || null;
      if (!this._persist()) return;
      if (this._pending !== null) await this._write(this._pending, remote.revision, epoch);
      else this._statusAs('synced', '已与云端同步。');
    }

    async _write(content, expectedRevision, epoch) {
      if (!this._live(epoch) || this.options.isEditing()) {
        if (this._live(epoch)) this._statusAs(this._conflict === undefined ? 'pending' : 'conflict', '正在编辑，结束后继续同步。');
        return;
      }
      const sent = copy(content);
      this._unconfirmed = { expectedRevision, content: sent };
      if (!this._persist()) return;
      let result;
      try { result = await this.options.writeRemote({ expectedRevision, content: sent }); }
      catch (_) {
        if (this._live(epoch)) this._statusAs('offline', '尚未确认云端保存结果，重连后会先核对版本。');
        return;
      }
      if (!this._live(epoch)) return;
      let remote;
      try {
        if (!result || typeof result.applied !== 'boolean') throw new Error('Invalid result');
        remote = this._row(result.design);
        if (result.applied && (remote === null || remote.revision <= expectedRevision
          || !equal(remote.content, sent))) throw new Error('Invalid saved result');
      } catch (_) {
        this._statusAs('error', '云端保存结果未通过校验，本机草稿已保留。');
        return;
      }
      if (!result.applied) {
        this._unconfirmed = null;
        if (remote && equal(remote.content, sent)) this._acknowledge(remote);
        else if (this._persist()) this._showConflict(remote, '云端出现新修改，请重新确认要保留的版本。');
        return;
      }
      this._acknowledge(remote);
    }

    resolve(choice) {
      if (choice !== 'local' && choice !== 'remote') return Promise.reject(new Error('Unknown conflict choice'));
      if (!this._active) return Promise.resolve(this.getStatus());
      if (this._resolving) return this._resolving;
      const epoch = this._epoch;
      const running = this._running;
      const work = Promise.resolve().then(async () => {
        if (running) await running;
        if (!this._live(epoch) || this._conflict === undefined) return this.getStatus();
        const remote = copy(this._conflict);
        const local = this._local();
        const editVersion = this._editVersion;
        if (this.options.isEditing()) return this._statusAs('conflict', '请结束当前编辑后再选择版本。');
        if (choice === 'remote' && remote === null) {
          return this._statusAs('conflict', '云端没有可下载的方案，请保留本机方案。');
        }
        const discarded = choice === 'local' ? remote && remote.content : local;
        if (discarded !== null) {
          try {
            if (await this.options.backup(copy(discarded), choice === 'local' ? 'cloud-before-local' : 'local-before-cloud') !== true) {
              throw new Error('Backup refused');
            }
          } catch (_) {
            return this._statusAs('conflict', '备份未成功，尚未覆盖任何版本。请先导出备份。');
          }
        }
        if (!this._live(epoch)) return this.getStatus();
        if (choice === 'remote') {
          if (editVersion !== this._editVersion || !equal(local, this._local()) || this.options.isEditing()) {
            return this._statusAs('conflict', '本机又有新的编辑，请结束编辑后重新选择版本。');
          }
          this._acceptRemote(remote);
        } else {
          this._pending = this._local();
          if (this._persist()) await this._write(this._pending, remote === null ? 0 : remote.revision, epoch);
        }
        return this.getStatus();
      }).catch(() => {
        if (this._live(epoch)) this._statusAs('error', '处理冲突时遇到异常，本机方案已保留。');
        return this.getStatus();
      }).finally(() => { if (this._resolving === work) this._resolving = null; });
      this._resolving = work;
      return work;
    }

    stop() {
      this._active = false;
      this._epoch += 1;
      clearTimeout(this._timer);
      this._timer = null;
      this._running = null;
      this._resolving = null;
      this._again = false;
    }
  }
  return DesignSync;
});
