const app = window.FloorplanApp;
const config = window.FLOORPLAN_CLOUD || {};
const button = document.querySelector('#cloudSyncButton');
const text = (zh, en) => app.text(zh, en);
const dialog = document.createElement('dialog');
dialog.className = 'cloud-dialog';
dialog.setAttribute('aria-labelledby', 'cloudTitle');
dialog.innerHTML = `
  <div class="cloud-dialog-head"><h2 id="cloudTitle"></h2><button class="btn" id="cloudClose" type="button">×</button></div>
  <div class="cloud-dialog-body">
    <p id="cloudIntro" class="cloud-note"></p>
    <p id="cloudUnavailable" hidden></p>
    <form id="cloudLogin" hidden>
      <label for="cloudEmail" id="cloudEmailLabel"></label>
      <input id="cloudEmail" type="email" autocomplete="email" inputmode="email" required maxlength="254">
      <button class="btn primary cloud-wide" id="cloudSendLink" type="submit"></button>
      <p class="cloud-note" id="cloudLoginHelp"></p>
    </form>
    <section id="cloudAccount" hidden>
      <span class="cloud-account" id="cloudAccountEmail"></span>
      <div id="cloudAccountChoice" hidden><p id="cloudAccountChoiceHelp" class="cloud-note"></p><button class="btn primary cloud-wide" id="cloudAccountConnect" type="button"></button></div>
      <div class="cloud-state-card"><strong id="cloudState"></strong><small id="cloudTime"></small></div>
      <div class="cloud-conflict" id="cloudConflict" hidden>
        <h3 id="cloudConflictTitle"></h3><p id="cloudConflictHelp"></p>
        <p class="cloud-note" id="cloudComparison"></p>
        <button class="btn cloud-wide" id="cloudExportLocal" type="button"></button>
        <div class="cloud-actions"><button class="btn primary" id="cloudUseRemote" type="button"></button><button class="btn" id="cloudUseLocal" type="button"></button></div>
      </div>
      <div class="cloud-actions"><button class="btn" id="cloudRetry" type="button"></button><button class="btn" id="cloudLogout" type="button"></button></div>
      <button class="btn cloud-wide" id="cloudRecheck" type="button" hidden></button>
    </section>
    <p id="cloudMessage" class="cloud-message" role="status" aria-live="polite"></p>
    <details class="cloud-recovery"><summary id="cloudRecoveryLabel"></summary><div class="cloud-recovery-list" id="cloudRecoveryList"></div></details>
  </div>`;
document.body.append(dialog);
const el = id => dialog.querySelector('#' + id);
let client, user, engine, timer, generation = 0, authEvent = 0, authBusy = false, initError = false, pendingSession;
let status = {kind:'local'};
let tabId, releaseTabLock = () => {};
// Duplicating a tab copies sessionStorage. A live lock prevents both pages from
// sharing a draft key, while an ordinary reload can reclaim its original draft.
async function claimTabId(){
  let candidate;
  try { candidate = sessionStorage.getItem('floorplan-sync-tab'); } catch {}
  candidate ||= crypto.randomUUID();
  const remember = id => {
    tabId = id;
    try { sessionStorage.setItem('floorplan-sync-tab', id); } catch {}
  };
  if (!navigator.locks) { remember(candidate); return; }
  await new Promise(resolve => {
    const claim = id => navigator.locks.request('floorplan-sync-tab-' + id, {ifAvailable:true}, lock => {
      if (!lock) { claim(crypto.randomUUID()); return; }
      remember(id); resolve();
      return new Promise(release => { releaseTabLock = release; });
    }).catch(() => { remember(crypto.randomUUID()); resolve(); });
    claim(candidate);
  });
}
const backupKey = app.storageKey + '-sync-backups';
const ownerKey = app.storageKey + '-cloud-owner';
const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(config.url || '') &&
  typeof config.publishableKey === 'string' && config.publishableKey.startsWith('sb_publishable_');

function label(id, zh, en){ el(id).textContent = text(zh, en); }
function message(zh = '', en = '', error = false){
  el('cloudMessage').textContent = text(zh, en || zh);
  el('cloudMessage').dataset.error = String(error);
}
function statusText(){
  const labels = {
    local:['云端同步','Cloud sync'], connecting:['正在连接云端','Connecting'],
    synced:['云端已同步','Cloud synced'], pending:['等待同步','Sync pending'],
    offline:['离线 · 等待同步','Offline · sync pending'], conflict:['需要选择版本','Choose a version'],
    error:['同步需要处理','Sync needs attention'], account:['确认连接账号','Confirm account']
  };
  return text(...(labels[status.kind] || labels.error));
}
const statusMessages = {
  'draft-storage-failed':['浏览器无法保存待同步草稿，请先导出方案并释放存储空间。','The browser cannot save the pending draft. Export your design and free storage space.'],
  'draft-mismatch':['当前方案与待同步草稿不同。请先导出两份方案，再导入要继续的版本。','The current design differs from the pending draft. Export both designs, then import the version you want to continue.'],
  'restore-after-edit':['结束当前编辑后恢复待同步草稿。','Finish editing to restore the pending draft.'],
  'draft-unreadable':['本机待同步草稿无法读取，请先导出备份后再处理。','The pending draft cannot be read. Export a backup, then back up and recheck versions.'],
  connecting:['正在连接云端…','Connecting to cloud storage…'],
  'draft-not-loaded':['待同步草稿尚未读取完成，请先导出当前方案备份。','The pending draft has not loaded. Export a backup of the current design first.'],
  conflict:['本机和云端都有修改，请选择保留的版本。','Both this device and the cloud have changes. Choose the version to keep.'],
  pending:['修改已保存在本机，等待同步。','Changes are saved on this device and waiting to sync.'],
  'local-invalid':['当前方案未通过校验，已暂停云端同步。','The current design failed validation. Cloud sync is paused.'],
  'sync-failed':['同步遇到异常，本机方案已保留。','Sync encountered a problem. Your local design is retained.'],
  synced:['已与云端同步。','The design is synced with cloud storage.'],
  'more-pending':['还有新的修改等待同步。','Newer changes are still waiting to sync.'],
  editing:['正在编辑，结束后继续同步。','Finish editing to continue syncing.'],
  offline:['暂时无法连接云端，修改仍保存在本机。','Cannot connect to cloud storage right now. Changes are retained on this device.'],
  'remote-invalid':['云端方案未通过校验，已保留本机方案。','The cloud design failed validation. Your local design is retained.'],
  'remote-missing':['云端方案已不存在，请确认是否重新上传本机方案。','The cloud design no longer exists. Confirm whether to upload the local design again.'],
  'save-unconfirmed':['尚未确认云端保存结果，重连后会先核对版本。','The cloud save is unconfirmed. Versions will be checked before retrying after reconnection.'],
  'save-result-invalid':['云端保存结果未通过校验，本机草稿已保留。','The cloud save response failed validation. Your local draft is retained.'],
  'conflict-updated':['云端出现新修改，请重新确认要保留的版本。','The cloud design changed again. Choose the version to keep again.'],
  'choose-after-edit':['请结束当前编辑后再选择版本。','Finish editing before choosing a version.'],
  'remote-unavailable':['云端没有可下载的方案，请保留本机方案。','There is no cloud design to download. Keep the local design.'],
  'backup-failed':['备份未成功，尚未覆盖任何版本。请先导出备份。','The backup failed, so no version was replaced. Export a backup first.'],
  'edited-during-choice':['本机又有新的编辑，请结束编辑后重新选择版本。','New local edits were made. Finish editing, then choose a version again.'],
  'resolve-failed':['处理冲突时遇到异常，本机方案已保留。','Could not resolve the conflict. Your local design is retained.'],
  'save-rejected':['云端拒绝保存此方案。请先导出备份，缩减方案大小或检查账号权限后，保留备份并重新核对版本。','Cloud storage rejected this design. Export a backup, reduce the design size or check account access, then back up and recheck versions.']
};
function statusMessage(){
  return status.messageCode ? text(...(statusMessages[status.messageCode] || statusMessages['sync-failed'])) : '';
}
function dateLabel(value){
  return value ? new Date(value).toLocaleString(document.documentElement.lang, {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
}
function render(){
  button.textContent = statusText(); button.dataset.state = status.kind;
  label('cloudTitle','云端同步','Cloud sync');
  el('cloudClose').setAttribute('aria-label',text('关闭','Close'));
  label('cloudIntro','电脑和手机使用同一邮箱登录，打开网页后自动同步同一份方案。本机保存与 JSON 导出仍然可用。','Use the same email on your computer and phone to sync one design while the page is open. Local saving and JSON export remain available.');
  el('cloudUnavailable').hidden = configured && !initError;
  label('cloudUnavailable',configured ? '暂时无法连接登录服务，请检查网络后刷新。当前修改仍保存在本机。' : '云端服务尚未启用。当前修改仍自动保存在本机。',configured ? 'Cannot load sign-in. Check your connection and reload. Local saving is still available.' : 'Cloud storage is not enabled yet. Changes are still saved on this device.');
  el('cloudLogin').hidden = !client || !!user;
  el('cloudAccount').hidden = !user;
  label('cloudEmailLabel','登录邮箱','Email address');
  label('cloudSendLink','发送登录链接','Send sign-in link');
  label('cloudLoginHelp','在这台设备上打开邮件中的链接即可登录，无需设置密码。首次登录会创建你的云端账号。','Open the emailed link on this device to sign in without a password. Your first sign-in creates your cloud account.');
  el('cloudSendLink').disabled = authBusy;
  el('cloudAccountEmail').textContent = user?.email || '';
  el('cloudAccountChoice').hidden = status.kind !== 'account';
  label('cloudAccountChoiceHelp','本机保留着另一个账号的方案。继续后会先核对云端；如果这个账号的云端为空，会保存当前本机方案。','This device retains another account’s design. Continuing checks this account’s cloud first; if it is empty, the current local design will be saved there.');
  label('cloudAccountConnect','用此账号连接当前方案','Connect this account to this design');
  el('cloudState').textContent = statusText();
  el('cloudTime').textContent = status.updatedAt ? text('上次云端保存：','Last cloud save: ') + dateLabel(status.updatedAt) : text('本机方案始终保留，联网后自动重试。','Your local design is retained. Sync retries when connected.');
  if (status.messageCode && status.kind !== 'synced') el('cloudTime').textContent = statusMessage();
  if (status.kind === 'error' && status.messageCode) {
    el('cloudMessage').textContent = statusMessage();
    el('cloudMessage').dataset.error = 'true';
  }
  el('cloudConflict').hidden = status.kind !== 'conflict';
  label('cloudConflictTitle','两边都有不同的方案','Different versions on both sides');
  label('cloudConflictHelp','请选择要继续使用的版本。替换前会保留备份，不会自动合并家具位置。','Choose the version to keep using. A backup is retained before replacement; furniture positions are not automatically merged.');
  const remote = status.remote;
  el('cloudUseRemote').disabled = !remote;
  el('cloudComparison').textContent = remote ? text(`本机 ${app.read().furniture.length} 件家具 · 云端 ${remote.content.furniture.length} 件家具（${dateLabel(remote.updated_at)}）`,`This device: ${app.read().furniture.length} items · Cloud: ${remote.content.furniture.length} items (${dateLabel(remote.updated_at)})`) : '';
  label('cloudExportLocal','先下载本机方案备份','Download local design first');
  label('cloudUseRemote','使用云端版本','Use cloud version');
  label('cloudUseLocal','用本机版本更新云端','Update cloud with this version');
  label('cloudRetry','立即同步','Sync now');
  el('cloudRetry').disabled = !engine;
  el('cloudRecheck').hidden = status.kind !== 'error';
  label('cloudRecheck','保留备份并重新核对版本','Back up and recheck versions');
  label('cloudLogout','退出本机登录','Sign out on this device');
  label('cloudRecoveryLabel','备份与待同步草稿','Backups and pending drafts');
  if (dialog.open) renderRecovery();
}
function downloadRaw(raw, name){
  const blob = new Blob([raw],{type:'application/json'});
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadPlan(content, name){
  downloadRaw(JSON.stringify(app.validate(content), null, 2), name);
}
function keepBackup(record){
  const records = JSON.parse(localStorage.getItem(backupKey) || '[]');
  records.push({...record,at:new Date().toISOString()});
  localStorage.setItem(backupKey, JSON.stringify(records.slice(-5)));
  return true;
}
function backup(content, reason){
  return keepBackup({content:app.validate(content),reason});
}
function renderRecovery(){
  const list = el('cloudRecoveryList'); list.replaceChildren();
  try {
    const entries = JSON.parse(localStorage.getItem(backupKey) || '[]').map(r => ({...r,label:text(r.rawDraft == null ? '替换前备份 · ' : '重置前草稿原始记录 · ',r.rawDraft == null ? 'Before replacement · ' : 'Raw draft before reset · ') + dateLabel(r.at)}));
    if (user) {
      const prefix = app.storageKey + '-cloud-' + user.id + '-';
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key.startsWith(prefix)) continue;
        const raw = localStorage.getItem(key);
        let record;
        try { record = JSON.parse(raw); if (record?.pending) app.validate(record.pending); }
        catch {
          entries.push({rawDraft:raw,label:text('无法读取的草稿原始记录 · ','Unreadable raw draft · ') + (key.endsWith(tabId) ? text('本窗口','this tab') : text('其他窗口','another tab'))});
          continue;
        }
        if (record?.pending) entries.push({content:record.pending,label:text('待同步草稿 · ','Pending draft · ') + (key.endsWith(tabId) ? text('本窗口','this tab') : text('其他窗口','another tab'))});
      }
    }
    for (const entry of entries.reverse()) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn'; b.textContent = entry.label;
      if (entry.rawDraft != null) b.onclick = () => downloadRaw(entry.rawDraft, 'sync-draft-record-' + new Date().toISOString().slice(0,10));
      else {
        const content = app.validate(entry.content);
        b.onclick = () => downloadPlan(content, '方案备份-' + new Date().toISOString().slice(0,10));
      }
      list.append(b);
    }
    if (!entries.length) list.textContent = text('暂无备份。发生版本替换时会自动保留最近 5 份。','No backups yet. The last 5 replaced versions are retained automatically.');
  } catch { list.textContent = text('无法读取本机备份，请先导出当前方案。','Cannot read backups. Export the current design first.'); }
}
async function request(query){
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const {data,error} = await query.abortSignal(controller.signal);
    if (error) throw error;
    return data;
  } finally { clearTimeout(timeout); }
}
async function setSession(session){
  const next = session?.user;
  if ((next?.id || null) === (user?.id || null) && (engine || !next || status.kind === 'account')) return;
  const current = ++generation;
  engine?.stop(); engine = null; clearInterval(timer);
  user = next || null; status = {kind:user ? 'connecting' : 'local'}; message(); render();
  if (!user) return;
  const account = user;
  try {
    const previousOwner = localStorage.getItem(ownerKey);
    if (previousOwner && previousOwner !== account.id && !app.isPristine()) {
      pendingSession = session; status = {kind:'account'}; render(); return;
    }
    localStorage.setItem(ownerKey, account.id);
  } catch {
    status = {kind:'error'}; render();
    message('浏览器无法保存同步设置，请先导出本机方案并释放存储空间。','The browser cannot save sync settings. Export your local design and free storage space.',true);
    return;
  }
  pendingSession = null;
  engine = new window.DesignSync({
    readLocal:app.read, applyRemote:app.applyRemote, validate:app.validate, isEditing:app.isEditing,
    pristine:app.isPristine(), storage:localStorage,
    storageKey:app.storageKey + '-cloud-' + account.id + '-' + tabId,
    backup,
    readRemote:() => request(client.from('floorplan_designs').select('plan_id,revision,content,updated_at').eq('owner_id',account.id).eq('plan_id',app.planId).maybeSingle()),
    writeRemote:({expectedRevision,content}) => request(client.rpc('save_floorplan',{p_owner_id:account.id,p_plan_id:app.planId,p_expected_revision:expectedRevision,p_content:content})),
    onStatus(nextStatus){
      if (current !== generation) return;
      status = nextStatus; message(); render();
      if (nextStatus.kind === 'error' && !nextStatus.messageCode) message('同步遇到问题，本机方案仍保留。','Sync encountered a problem. Your local design is retained.',true);
      else if (nextStatus.kind === 'synced') message();
    }
  });
  await engine.start();
  if (current === generation) timer = setInterval(() => { if (!document.hidden) engine?.sync(); }, 5000);
}
button.onclick = () => {
  document.exitPointerLock?.();
  render(); dialog.showModal(); renderRecovery();
};
el('cloudClose').onclick = () => dialog.close();
el('cloudExportLocal').onclick = app.exportPlan;
el('cloudRetry').onclick = () => engine?.sync();
el('cloudAccountConnect').onclick = async () => {
  if (!pendingSession) return;
  try {
    const session = pendingSession;
    localStorage.setItem(ownerKey, session.user.id);
    user = null; await setSession(session);
  } catch { message('无法保存连接设置，请先导出本机方案。','Could not save account settings. Export your local design first.',true); }
};
el('cloudRecheck').onclick = async () => {
  if (!user) return;
  try {
    const account = user, key = app.storageKey + '-cloud-' + account.id + '-' + tabId;
    const raw = localStorage.getItem(key);
    backup(app.read(), 'before-recheck');
    // Preserve the exact record, including unreadable JSON or invalid pending
    // content, before removing the key that prevents initialization.
    if (raw != null) keepBackup({rawDraft:raw,sourceKey:key,reason:'draft-before-recheck'});
    engine?.stop(); clearInterval(timer);
    localStorage.removeItem(key);
    user = null; await setSession({user:account});
  } catch { message('无法完成备份，请先导出本机方案后重试。','Could not create a backup. Export your local design first.',true); }
};
for (const [id,choice] of [['cloudUseLocal','local'],['cloudUseRemote','remote']]) {
  el(id).onclick = async () => {
    el(id).disabled = true;
    try { await engine?.resolve(choice); }
    catch { message('暂时无法处理版本，请导出本机方案后重试。','Could not resolve versions. Export your local design and retry.',true); }
    finally { el(id).disabled = false; }
  };
}
el('cloudLogin').onsubmit = async event => {
  event.preventDefault(); if (authBusy || !client) return;
  authBusy = true; message(); render();
  try {
    const {error} = await client.auth.signInWithOtp({email:el('cloudEmail').value.trim(),options:{emailRedirectTo:location.origin + location.pathname}});
    if (error) throw error;
    message('登录链接已请求发送，请在这台设备上查看邮箱并打开链接。','Sign-in email requested. Check your inbox and open the link on this device.');
  } catch {
    message('登录邮件未能发送。请检查邮箱，稍后重试；若持续失败，需要检查云端邮件服务。','Could not send the sign-in email. Check your address and retry later; persistent failures require checking the email service.',true);
  } finally { authBusy = false; render(); }
};
el('cloudLogout').onclick = async () => {
  if (!client) return;
  const prior = engine; prior?.stop(); ++generation; clearInterval(timer);
  try {
    const {error} = await client.auth.signOut({scope:'local'});
    if (error) throw error;
    await setSession(null);
  } catch {
    message('退出失败，请重试。待同步修改仍保留在本机。','Sign-out failed. Retry; pending changes are retained locally.',true);
    user = null; await setSession((await client.auth.getSession()).data.session);
  }
};
window.addEventListener('designchange', () => engine?.changed());
window.addEventListener('designlanguagechange', render);
window.addEventListener('online', () => engine?.sync());
window.addEventListener('focus', () => engine?.sync());
document.addEventListener('visibilitychange', () => { if (!document.hidden) engine?.sync(); });
window.addEventListener('storage', event => { if (event.key === app.storageKey) engine?.sync(); });
function connectionError(){
  status = {kind:'error'}; render();
  message('无法建立同步连接，本机方案仍保留。请导出备份后重试。','Could not establish sync. Your local design is retained; export a backup and retry.',true);
}
window.addEventListener('pagehide', () => { engine?.stop(); ++generation; clearInterval(timer); releaseTabLock(); });
window.addEventListener('pageshow', async event => {
  if (!event.persisted || !client) return;
  try {
    await claimTabId();
    user = null;
    const {data,error} = await client.auth.getSession();
    if (error) throw error;
    await setSession(data.session);
  } catch { connectionError(); }
});
render();
await claimTabId();
if (configured) {
  try {
    const {createClient} = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm');
    client = createClient(config.url, config.publishableKey, {auth:{storageKey:'floorplan-auth-' + new URL(config.url).hostname,detectSessionInUrl:true,persistSession:true,autoRefreshToken:true}});
    client.auth.onAuthStateChange((_event, session) => {
      const ticket = ++authEvent;
      // Stop synchronously: the shared SDK may already be using another
      // account's token before deferred initialization gets its next turn.
      if ((session?.user?.id || null) !== (user?.id || null)) {
        engine?.stop(); engine = null; pendingSession = null; ++generation; clearInterval(timer);
      }
      setTimeout(() => { if (ticket === authEvent) setSession(session).catch(connectionError); }, 0);
    });
    const ticket = authEvent;
    const {data,error} = await client.auth.getSession();
    if (error) throw error;
    if (ticket === authEvent) await setSession(data.session);
    render();
  } catch { initError = true; render(); }
}
