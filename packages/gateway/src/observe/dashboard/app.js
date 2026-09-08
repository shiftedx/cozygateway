/* Observe reads only the paired gateway's metadata routes. No transcript or command surface. */
(() => {
  'use strict';
  const TOKEN_KEY = 'cozygateway.observe.token';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : 'Not reported';
  const duration = value => typeof value !== 'number' || !Number.isFinite(value) ? 'Not reported' : value < 1000 ? `${Math.round(value)} ms` : value < 60000 ? `${(value / 1000).toFixed(1)} s` : value < 3600000 ? `${Math.round(value / 60000)} min` : `${(value / 3600000).toFixed(1)} h`;
  const age = at => typeof at === 'number' ? `${duration(Math.max(0, Date.now() - at))} ago` : 'Not reported';
  const clock = at => typeof at === 'number' ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Not reported';
  const money = value => typeof value === 'number' ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: value < 10000 && value > 0 ? 4 : 2 }).format(value / 1000000) : 'tokens only';
  const sum = values => values.reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
  const empty = text => `<p class="empty">${esc(text)}</p>`;
  const chip = (text, state = '') => `<span class="chip ${esc(state)}">${esc(text)}</span>`;
  const metric = (value, unit = duration) => !value || value.samples === 0 ? 'No samples' : value.belowSampleFloor ? `${number(value.samples)} samples · need 20` : `${unit(value.p50)} · p95 ${unit(value.p95)} · n ${number(value.samples)}`;
  const kv = rows => `<dl class="kv">${rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`;
  const table = (headers, rows) => rows.length ? `<div class="tablewrap" role="region" tabindex="0" aria-label="${esc(headers.join(', '))}"><table><thead><tr>${headers.map(x => `<th scope="col">${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(x => `<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty('No records in this window.');
  const state = { window: '24h', bot: null, kind: '', data: {}, errors: new Set(), pending: false, again: false, generation: 0, connected: false, lastUpdate: null, authExpired: false, reconnect: 0, liveBots: new Map() };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let token;
  try { token = localStorage.getItem(TOKEN_KEY); } catch {}
  if (!token) { location.replace('/observe/pair'); return; }
  function select(tab, focus = false) {
    document.querySelectorAll('[role="tab"]').forEach(t => {
      const selected = t === tab;
      t.setAttribute('aria-selected', String(selected)); t.tabIndex = selected ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !selected;
    });
    if (focus) tab.focus();
    history.replaceState(null, '', `#${tab.getAttribute('aria-controls')}`);
  }
  document.querySelectorAll('[role="tab"]').forEach(tab => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll('[role="tab"]')].filter(t => !t.hidden);
      const current = tabs.indexOf(tab), next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      select(tabs[next], true);
    });
  });
  function applyFilter(bot) {
    state.bot = bot; state.generation++;
    $('filtername').textContent = bot || ''; $('filterchip').classList.toggle('on', !!bot);
    refresh();
  }
  $('clearfilter').addEventListener('click', () => applyFilter(null));
  document.querySelectorAll('[data-window]').forEach(button => button.addEventListener('click', () => {
    state.window = button.dataset.window; state.generation++;
    document.querySelectorAll('[data-window]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    document.querySelectorAll('[data-win]').forEach(el => { el.textContent = state.window; }); refresh();
  }));
  $('event-kind').addEventListener('change', event => { state.kind = event.target.value; renderEvents(); });
  function expired() {
    state.authExpired = true;
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
    $('page-error').hidden = false;
    $('page-error').innerHTML = 'This observer pairing has expired or was revoked. <a href="/observe/pair">Pair this browser again</a>.';
    connection('Pairing required', 'bad');
  }
  function connection(text, status = '') {
    $('connection-status').className = `obs ${status}`;
    $('connection-status').textContent = `${text} · read only`;
  }
  async function read(path, generation) {
    const query = new URLSearchParams({ window: state.window });
    if (state.bot) query.set('bot', state.bot);
    const [endpoint, extra] = path.split('?');
    if (extra) for (const [key, value] of new URLSearchParams(extra)) query.set(key, value);
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`/observe/api/${endpoint}?${query}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal });
      if (response.status === 401 || response.status === 403) { expired(); throw new Error('auth'); }
      if (!response.ok) throw new Error('request');
      const data = await response.json();
      if (generation !== state.generation) return;
      state.data[path] = data; state.errors.delete(path);
    } catch {
      if (generation === state.generation) state.errors.add(path);
    } finally { clearTimeout(timeout); }
  }
  const endpoints = ['overview','bots','turns','roundtrip','attach','approvals','deliveries','devices','events','cozyagents','cozyagents/spend','cozyagents/tools','series?series=tunnel_rtt_ms','series?series=ttft_ms'];
  async function refresh() {
    if (state.authExpired) return;
    if (state.pending) { state.again = true; return; }
    state.pending = true;
    const generation = state.generation;
    await Promise.all(endpoints.map(path => read(path, generation)));
    state.pending = false;
    if (generation === state.generation) {
      if (state.errors.size < endpoints.length) state.lastUpdate = Date.now();
      render();
      if (state.connected && !state.errors.size) connection('Live');
    }
    if (state.again) { state.again = false; refresh(); }
  }
  const panelPaths = { overview:['glance','header-strip'], bots:['bots'], turns:['turns'], roundtrip:['roundtrip','felt','network-path'], attach:['attach'], approvals:['approvals'], deliveries:['deliveries'], devices:['devices'], events:['events'], cozyagents:['internals','model','agent-glance'], 'cozyagents/spend':['spend'], 'cozyagents/tools':['tool-costs'], 'series?series=tunnel_rtt_ms':['tunnel-chart'], 'series?series=ttft_ms':['first-token-chart'] };
  function render() {
    renderOverview(); renderBots(); renderLatency(); renderTurns(); renderAttach(); renderApprovals(); renderDeliveries(); renderDevices(); renderEvents(); renderAgents(); renderFlow();
    chart('tunnel-chart', state.data['series?series=tunnel_rtt_ms']?.points, 'Derived tunnel round trip', state.data['series?series=tunnel_rtt_ms']);
    chart('first-token-chart', state.data['series?series=ttft_ms']?.points, 'First token', state.data['series?series=ttft_ms']);
    for (const [path, ids] of Object.entries(panelPaths)) for (const id of ids) {
      const el = $(id); el.classList.toggle('panel-stale', state.errors.has(path));
      el.querySelectorAll('.panel-error').forEach(x => x.remove());
      if (state.errors.has(path)) el.insertAdjacentHTML('afterbegin', '<p class="panel-error" role="status">Could not refresh this panel. Any values shown are from the last successful read.</p>');
    }
    if (!state.authExpired) {
      $('page-error').hidden = state.errors.size === 0;
      $('page-error').textContent = state.errors.size ? 'Some measurements could not refresh. The dashboard will retry automatically.' : '';
    }
    $('updated-at').textContent = state.lastUpdate ? `Last read ${clock(state.lastUpdate)} · ${state.window} window` : 'Waiting for first update.';
    motion();
  }
  function renderOverview() {
    const data = state.data.overview; if (!data) return;
    $('gateway-name').textContent = data.gateway.name;
    const a = data.attach;
    $('header-strip').innerHTML = [chip(`v${data.gateway.version}`), chip(`up ${duration(data.gateway.uptimeMs)}`), chip(`bridge ${data.gateway.bridge}`, data.gateway.bridge === 'online' ? 'ok' : 'stale'), chip(`attach ${a?.online ?? 'unknown'} online`, a?.online ? 'ok' : ''), chip(`queue ${a?.queueDepth ?? 'not reported'}`), chip(`dead letters ${a?.deadLetters ?? 'not reported'}`, a?.deadLetters ? 'bad' : ''), chip(`tunnel ${data.tunnel.state}`, data.tunnel.state === 'offline' ? 'bad' : data.tunnel.state === 'online' ? 'ok' : 'stale')].join('');
    const spend = data.tiles.spend?.rows;
    const priced = spend?.length && spend.every(row => row.costMicros !== null);
    const tiles = [ ['Needs a person',number(data.needsAPerson.total),`${number(data.needsAPerson.approvals)} approvals · ${number(data.needsAPerson.repairs)} repairs`,'wait'], ['Round trip',data.tiles.roundTrip?.samples ? duration(data.tiles.roundTrip.p50) : 'No samples',`socket round trip · n ${number(data.tiles.roundTrip?.samples)}`,''], ['First token',data.tiles.firstToken?.samples ? duration(data.tiles.firstToken.p50) : 'No samples',`p50 · n ${number(data.tiles.firstToken?.samples)}`,''], ['Turns',number(data.tiles.turns),`terminal records · ${state.window}`,''], ['Spend',priced ? money(sum(spend.map(x=>x.costMicros))) : 'tokens only',`reported token categories · ${state.window}`,''] ];
    $('glance').innerHTML = tiles.map(([label,value,description,status]) => `<div class="tile ${status}" role="listitem"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div><div class="d">${esc(description)}</div></div>`).join('');
    const approvals = state.data.approvals?.pending ?? [];
    const repairs = (state.data.cozyagents?.internals ?? []).flatMap(bot => (bot.toolServers ?? []).filter(server => server.state === 'repair_pending').map(server => ({ bot: bot.bot, server: server.server })));
    $('attention').classList.toggle('calm', !approvals.length && !repairs.length);
    $('attention-items').innerHTML = [...approvals.map(row=>`<li>${chip('Approval','wait')}<span>${esc(row.bot)} has a pending approval. Answer in CozyChat.</span><span class="since">${esc(age(row.createdAt))}</span></li>`), ...repairs.map(row=>`<li>${chip('Repair','wait')}<span>${esc(row.bot)} · ${esc(row.server)} needs a decision in CozyChat.</span></li>`)].join('') || '<li class="empty">No pending decisions reported.</li>';
  }
  function historyNote(data, count, total, label, oldest = false) {
    if (data?.view !== 'bounded_history') return '';
    return `<p class="note">${data.truncated ? `Showing the ${oldest ? 'oldest' : 'newest'} ${number(count)} of ${number(total)} ${label} in this window. This view is truncated.` : `${number(count)} ${label} shown in this window.`}</p>`;
  }
  function chart(id, points, label, data) {
    const valid = (points ?? []).filter(p => typeof p.value === 'number' && typeof p.at === 'number');
    if (!valid.length) { $(id).innerHTML = '<div class="chart-empty">No samples in this window.</div>'; return; }
    const width = 580, height = 118, lo = Math.min(...valid.map(p=>p.at)), hi = Math.max(...valid.map(p=>p.at)), max = Math.max(1,...valid.map(p=>p.value));
    const coords = valid.map(p=>`${40+(p.at-lo)/Math.max(1,hi-lo)*width},${140-p.value/max*height}`).join(' ');
    $(id).innerHTML = `<svg class="chart" viewBox="0 0 640 160" role="img" aria-label="${esc(label)}, ${valid.length} samples"><line class="grid" x1="40" y1="140" x2="620" y2="140"/><polyline class="ctx" fill="none" stroke="var(--primary)" stroke-width="2" points="${coords}"/><text x="40" y="155">${esc(clock(lo))}</text><text x="620" y="155" text-anchor="end">${esc(clock(hi))}</text><text x="40" y="16">${esc(duration(max))} max · n ${valid.length}</text></svg>` + historyNote(data, valid.length, data?.totalPoints, 'samples', true);
  }
  function renderBots() {
    const bots = state.data.bots?.bots; if (!bots) return;
    $('bots').innerHTML = bots.length ? '<div class="bhead"><span></span><span>Bot · harness</span><span class="ft">First token p50</span><span class="r">Turns</span><span class="r">Failed</span><span>Approvals</span></div>' + bots.map(bot=>`<div class="brow rowbtn" role="button" tabindex="0" aria-pressed="${state.bot===bot.name}" data-bot="${esc(bot.name)}" aria-label="Filter to ${esc(bot.name)}"><svg class="big" aria-hidden="true"><use href="#g-${bot.online?'ok':'off'}"/></svg><div class="bname">${esc(bot.name)}<small>${esc(bot.harness)} · ${esc(age(bot.lastTurnAt))}</small></div><div class="bft"><span>${esc(metric(bot.firstToken))}</span></div><div class="bn"><b>${number(bot.turns)}</b><small>turns</small></div><div class="bn ${bot.failures?'bad':''}"><b>${number(bot.failures)}</b><small>failed</small></div>${chip(`${number(bot.openApprovals)} pending`,bot.openApprovals?'wait':'')}</div>`).join('') : empty('No bots match this selection.');
    $('bots').querySelectorAll('[data-bot]').forEach(row=>{ row.addEventListener('click',()=>applyFilter(row.dataset.bot)); row.addEventListener('keydown',event=>{ if(event.key==='Enter'||event.key===' '){event.preventDefault();applyFilter(row.dataset.bot);} }); });
  }
  function hopRows(hops) {
    const labels = { device:'Phone to gateway', tunnel:'Tunnel leg · derived', gateway:'Gateway handling', peer:'Gateway to bot', model:'Model step', turn:'Whole turn' };
    return `<div class="hops">${hops.map(hop=>`<div class="hop-row"><span>${esc(labels[hop.hop] ?? hop.networkPath ?? hop.label)}</span><svg class="hop-track" viewBox="0 0 240 20" aria-hidden="true"><rect class="base" width="240" height="12" y="4" rx="3"/>${hop.p50===null||hop.p50===undefined?'':`<rect class="value" width="${Math.min(240,Math.log10(1+Math.max(0,hop.p50))/5*240)}" height="12" y="4" rx="3"/>`}${hop.p95==null?'':`<line class="tick" x1="${Math.min(240,Math.log10(1+Math.max(0,hop.p95))/5*240)}" x2="${Math.min(240,Math.log10(1+Math.max(0,hop.p95))/5*240)}" y1="1" y2="19"/>`}</svg><span class="n">${esc(hop.samples?duration(hop.p50):'No samples')}<small>p95 ${esc(duration(hop.p95))} · n ${number(hop.samples)}</small></span></div>`).join('')}</div>`;
  }
  function renderLatency() {
    const data=state.data.roundtrip; if(!data)return;
    $('roundtrip').innerHTML = `<div>${hopRows(data.hops ?? [])}</div><div><h3>How to read these hops</h3><p class="note">Each row is a round trip measured on one clock. The tunnel leg is the public self-probe minus loopback. Separate medians do not add up to a measured turn, so they are not stacked as a total.</p><details class="numbers"><summary>Numbers</summary>${table(['Hop','p50','p95','Samples'],(data.hops??[]).map(h=>[esc(h.hop),esc(duration(h.p50)),esc(duration(h.p95)),number(h.samples)]))}</details></div>`;
    $('felt').innerHTML=hopRows([{...data.felt,label:'Send tapped to rendered delta'}]);
    $('network-path').innerHTML=hopRows(data.byNetworkPath??[])+(data.byDevice??[]).map(row=>`<details class="numbers"><summary>Device ${esc(row.device)} · ${esc(row.radio)}</summary>${table(['Measurement','VPN on','VPN off','VPN cost'],[['Felt',row.felt],['Edge RTT',row.edge]].map(([label,value])=>[label,esc(metric(value?.vpnOn)),esc(metric(value?.vpnOff)),value?.belowComparisonFloor?`Need ${number(data.vpnComparisonSampleFloor??30)} samples per side`:esc(duration(value?.vpnCostMs))]))}<p class="note">Edge locations: ${esc(row.edgeColos?.join(', ')||'Not reported')}</p></details>`).join('')+empty('VPN cost compares medians for the same device and radio, with at least 30 samples on each side. Unknown VPN state stays out of that comparison. Edge-to-gateway backbone timing is not reported.');
  }
  function renderTurns() {
    const data=state.data.turns;if(!data)return;
    $('turns').innerHTML=table(['Time','Bot','Turn reference','Outcome','Reason'],(data.terminals??[]).map(row=>[esc(clock(row.at)),esc(row.botName??'former bot'),esc(row.ref??'Not reported'),chip(row.detail?.status??'unknown',row.detail?.status==='failed'?'bad':'ok'),esc(row.detail?.reason??'Not reported')]))+historyNote(data,data.terminals?.length??0,data.totalTerminals,'terminal records');
  }
  function renderAttach() {
    const data=state.data.attach;if(!data)return;
    $('attach').innerHTML=`<div class="peers-grid">${(data.peers??[]).map(peer=>`<div class="peer"><div class="ph">${esc(peer.bot)}${chip(peer.online?'online':'absent',peer.online?'ok':'stale')}</div><p class="note">${esc(metric(peer.roundTrip))}</p>${kv([['Queue',number(peer.queueDepth)],['Dead letters',number(peer.deadLetters)],['Outbox',number(peer.pluginOutboxDepth)],['Oldest outbox event',duration(peer.pluginOldestEventAgeMs)],['Inbox',number(peer.pluginCommandInboxDepth)],['Last contact',age(peer.lastContactAt)]])}</div>`).join('')||empty('No attach peers reported.')}</div><details class="numbers"><summary>Dead letters · ${number(data.deadLetters?.length??0)}</summary>${table(['Bot reference','Sequence','Attempts','Time'],(data.deadLetters??[]).map(row=>[esc(row.bot),number(row.sequence),number(row.attempts),esc(clock(row.at))]))}</details>`;
  }
  function renderApprovals() {
    const data=state.data.approvals;if(!data)return;
    $('approvals').innerHTML=table(['Bot','Pending since'],(data.pending??[]).map(row=>[esc(row.bot),esc(age(row.createdAt))]))+`<h3>Live grants</h3>`+table(['Bot','Category','Scope','Expires'],(data.grants??[]).map(row=>[esc(row.bot),esc(row.category??'Not reported'),esc(typeof row.scope==='string'?row.scope:'scoped'),esc(row.expiresAt===null?'No expiry':age(row.expiresAt))]))+empty('Approval deadlines and always-require categories are not reported on this read surface.');
  }
  function renderDeliveries() {
    const data=state.data.deliveries;if(!data)return;
    $('deliveries').innerHTML=table(['Bot','State','Bytes','Created'],(data.artifacts??[]).map(row=>[esc(row.bot),chip(row.state,row.state==='failed'?'bad':''),number(row.sizeBytes),esc(clock(row.createdAt))]))+kv([['Push result samples',number(data.push?.samples)],['Push event markers',number(data.events?.length??0)]]);
  }
  function renderDevices() {
    const data=state.data.devices;if(!data)return;
    $('devices').innerHTML=`<div><h3>Devices</h3>${table(['Name','Kind','Scope','Last seen'],(data.devices??[]).map(row=>[esc(row.name),esc(row.kind),chip(row.scope),esc(age(row.lastSeenAt))]))}</div><div><h3>Runners</h3>${table(['Name','State','Last contact'],(data.runners??[]).map(row=>[esc(row.name),chip(row.online?'online':'offline',row.online?'ok':'stale'),esc(age(row.lastContactAt))]))}</div>`;
  }
  function renderEvents() {
    const all=state.data.events?.events;if(!all)return;
    const select=$('event-kind'); const kinds=[...new Set(all.map(row=>row.kind))].sort();
    select.innerHTML='<option value="">All kinds</option>'+kinds.map(kind=>`<option value="${esc(kind)}">${esc(kind)}</option>`).join(''); select.value=state.kind;
    $('events').innerHTML=table(['Time','Kind','Bot','Details'],all.filter(row=>!state.kind||row.kind===state.kind).map(row=>[esc(clock(row.at)),chip(row.kind),esc(row.botName??'gateway'),esc(Object.entries(row.detail??{}).map(([k,v])=>`${k}: ${v}`).join(' · ')||'No detail')]))+historyNote(state.data.events,all.length,state.data.events.totalEvents,'events')+(state.kind?empty('Kind filter applies to the received event feed.'): '');
  }
  function renderAgents() {
    const data=state.data.cozyagents;if(!data)return;
    $('tab-ca').hidden=!data.available;
    if(!data.available){if($('tab-ca').getAttribute('aria-selected')==='true')select($('tab-gw'));return;}
    const bots=data.internals??[];
    if((location.hash==='#view-ca' || document.getElementById(location.hash.slice(1))?.closest('#view-ca')) && $('tab-gw').getAttribute('aria-selected')==='true')select($('tab-ca'));
    const ages=bots.map(row=>row.snapshotAgeMs).filter(value=>typeof value==='number');
    $('agent-glance').innerHTML=[['Peers',number(bots.length),'stored snapshot subjects'],['Snapshot',ages.length?duration(Math.max(...ages)):'Not reported','oldest snapshot age'],['Steps',number(data.model?.stepLatency?.samples),'latency samples in window'],['Checkpoints',bots.some(row=>Number.isFinite(row.checkpoints?.count))?number(sum(bots.map(row=>row.checkpoints?.count))):'Not reported','reported counters'],['Repairs',number(sum(bots.map(row=>(row.toolServers??[]).filter(s=>s.state==='repair_pending').length))),'waiting on a person']].map(([label,value,detail])=>`<div class="tile" role="listitem"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div><div class="d">${esc(detail)}</div></div>`).join('');
    $('model').innerHTML=kv([['Model step latency',metric(data.model?.stepLatency)],['HTTP status distribution','Not reported'],['Provider usage','See throughput per model below']]);
    $('internals').innerHTML=bots.map(bot=>`<article class="agent-block"><h3>${esc(bot.bot)} ${chip(bot.runtimeStage,bot.runtimeStage==='ready'?'ok':'wait')} ${chip(`snapshot ${duration(bot.snapshotAgeMs)}`,bot.snapshotAgeMs>90000?'stale':'')}</h3><div class="internals"><section><h3>Runtime</h3>${kv([['Generation wanted',number(bot.generationsWanted)],['Generation observed',number(bot.generationsObserved)],['Bundle',bot.bundleVersion??'Not reported'],['Runner',bot.runnerName??'Not reported'],['Runner contact',age(bot.runnerLastContactAt)]])}</section><section><h3>Tools by family</h3>${table(['Family','Calls'],(bot.toolFamilies??[]).map(row=>[esc(row.family),number(row.calls)]))}${kv([['Cache telemetry',bot.cache?.availability==='reported'?`${number(bot.cache.hits)} hits · ${number(bot.cache.misses)} misses · process lifetime`:'Not reported']])}</section><section><h3>Tool servers</h3>${table(['Server','Health layers','State'],(bot.toolServers??[]).map(server=>[`${esc(server.server)}<small class="mono">${esc(server.fingerprint??'Fingerprint not reported')}</small>`,`<span class="segbar" aria-label="${number(server.healthy)} of ${number(server.layers)} layers healthy">${Array.from({length:Math.min(32,server.layers??0)},(_,i)=>`<i class="${i<(server.healthy??0)?'':'off'}"></i>`).join('')}</span>`,chip(server.state,server.state==='healthy'?'ok':server.state==='repair_pending'?'wait':'stale')]))}</section><section><h3>Policy</h3>${kv([['Permitted',number(bot.policy?.permitted)],['Asked',number(bot.policy?.asked)],['Denied',number(bot.policy?.denied)],['Expired',number(bot.policy?.expired)],['Egress refused',number(bot.policy?.egressRefused)],['Level',bot.policy?.level??'Not reported']])}</section><section><h3>Context</h3>${kv([['In use tokens',number(bot.context?.inUseTokens)],['Window tokens',number(bot.context?.windowTokens)],['Rollovers',number(bot.context?.rollovers)],['Last rollover',age(bot.context?.lastRolloverAt)],['Cards attached',number(bot.context?.cardsAttached)],['Cards total',number(bot.context?.cardsTotal)],['Lease headroom','Not reported']])}</section><section><h3>Memory and checkpoints</h3>${kv([['Recall documents',number(bot.memory?.recallDocs)],['Recall bytes',number(bot.memory?.recallBytes)],['Last consolidation',age(bot.memory?.lastConsolidationAt)],['Evicted',number(bot.memory?.evicted)],['Tombstoned',number(bot.memory?.tombstoned)],['Checkpoints',number(bot.checkpoints?.count)],['Restores',number(bot.checkpoints?.restores)],['Last restore',bot.checkpoints?.lastRestoreResult??'Not reported']])}</section></div></article>`).join('')||empty('No snapshots match this bot.');
    const spend=state.data['cozyagents/spend'];
    if(spend?.available)$('spend').innerHTML=(spend.rows??[]).map(row=>`<div class="r" role="listitem"><div class="bname name">${esc(row.bot)}<small>${esc(row.model)}</small></div><div class="m"><span class="n">${(row.speedsByPrefix??[{prefix:'reported',prefill:row.prefill}]).map(speed=>`${esc(metric(speed.prefill,number))}<small>${esc(speed.prefix)} prefill tok/s</small>`).join('')}</span></div><div class="m"><span class="n">${(row.speedsByPrefix??[{prefix:'reported',decode:row.decode}]).map(speed=>`${esc(metric(speed.decode,number))}<small>${esc(speed.prefix)} decode tok/s</small>`).join('')}</span></div><div class="bn">${number(sum(Object.values(row.tokens??{})))} tok<small>lifetime ${number(sum([row.lifetime?.prompt,row.lifetime?.completion,row.lifetime?.cached]))}</small></div><div class="bn">${esc(money(row.costMicros))}<small>lifetime ${esc(money(row.lifetime?.costMicros))}</small><small>per turn ${esc(metric(row.costPerTurn,money))}</small></div></div>`).join('')||empty('No reported model usage in this window.');
    const tools=state.data['cozyagents/tools'];
    if(tools?.available)$('tool-costs').innerHTML=table(['Tool · family','Calls','Errors','Median result tokens','Induced tokens','Cost','Duration','Flags'],(tools.rows??[]).map(row=>[`${esc(row.tool)}<small class="mono">${esc(row.family)}</small>`,number(row.calls),number(row.errors),row.resultSize?esc(metric(row.resultSize,number)):number(row.medianResultTokens),number(row.inducedTokens),esc(money(row.costMicros)),esc(metric(row.duration)),[...(row.flags??[]),...(row.attributed?['attributed']:[])].map(flag=>chip(flag,flag==='errors'?'bad':'wait')).join(' ')||'none']))+(tools.rows??[]).filter(row=>row.drivingTurns?.length).map(row=>`<details class="numbers"><summary>${esc(row.tool)} · driving turns</summary>${table(['Bot','Turn reference','Calls','Induced tokens'],row.drivingTurns.map(turn=>[esc(turn.bot),esc(turn.turn),number(turn.calls),number(turn.inducedTokens)]))}</details>`).join('')+(tools.heavyDetectionAvailable===false?empty('Heavy-call detection is unavailable for grouped calls without an individual-call distribution.'):'')+empty('Retry detection by matching arguments is unavailable because this lane does not carry arguments hashes.');
    const steps=data.steps??bots.flatMap(bot=>(bot.steps??[]).map(record=>({bot:bot.bot,record}))), calls=data.toolCalls??bots.flatMap(bot=>(bot.toolCalls??[]).map(record=>({bot:bot.bot,record})));
    if(data.turn?.spans?.length && data.turn.spans.every(span=>Number.isFinite(span.start)&&Number.isFinite(span.end)&&span.end>=span.start)){
      $('turnsvg').hidden=false;renderAnatomy(data.turn);$('turn-steps').innerHTML='';
    }else{
      $('turnsvg').hidden=true;
      $('turn-narrow').textContent='Timing positions are not reported. Durations are shown without inventing a timeline.';
      $('turn-steps').innerHTML=table(['Bot','Turn reference','Step','Model','Prompt','Completion','Cached','First token','Generation'],steps.map(value=>{const row=value.record??value;return[esc(value.bot??''),esc(row.turn??'Not reported'),number(row.step),esc(row.model??'Not reported'),number(row.promptTokens),number(row.completionTokens),number(row.cachedTokens),esc(duration(row.timeToFirstTokenMs)),esc(duration(row.generationMs))];}));
      $('turn-inspect').innerHTML=table(['Tool','Step','Calls','Induced tokens','Duration'],calls.map(value=>{const row=value.record??value;return[esc(row.tool),number(row.step),number(row.calls),number(row.inducedTokens),esc(duration(row.durationMs))];}));
      $('turn-summary').textContent=steps.length?`${number(steps.length)} step records and ${number(calls.length)} grouped tool records in the latest snapshots. Wait chronology, context limits and output-frame timing are not reported.`:'No step records reported in the latest snapshots. Snapshot presence alone does not imply measured turn timing.';
    }
  }
  const svgNS='http://www.w3.org/2000/svg';
  function svgElement(tag,attrs,parent,text){const el=document.createElementNS(svgNS,tag);for(const [key,value]of Object.entries(attrs))el.setAttribute(key,String(value));if(text!==undefined)el.textContent=text;parent.appendChild(el);return el;}
  function renderFlow(){
    const overview=state.data.overview,bots=state.data.bots?.bots;if(!overview||!bots)return;
    const svg=$('flowmap');svg.replaceChildren();
    const rows=bots.slice(0,8), height=Math.max(262,rows.length*48+30);svg.setAttribute('viewBox',`0 0 1200 ${height}`);
    const cy=height/2,defs=svgElement('defs',{},svg),packets=svgElement('g',{id:'packets'},svg);
    const down=overview.tunnel.state==='offline';
    svg.classList.toggle('down',down);
    function node(x,y,w,label,sub,status='ok',id){const g=svgElement('g',{class:'col'},svg);svgElement('rect',{class:`node ${status}`,x,y:y-30,width:w,height:60,rx:12,...(id?{id}: {})},g);svgElement('text',{x:x+w/2,y:y-4,'text-anchor':'middle'},g,label);svgElement('text',{x:x+w/2,y:y+15,'text-anchor':'middle',class:'detail'},g,sub);return g;}
    function path(id,d,live=false){svgElement('path',{id,d},defs);svgElement('use',{href:`#${id}`,class:`wire ${live?'':'idle'}`},svg);}
    const devices=state.data.devices?.devices??[];
    node(30,cy,130,'Devices',`${devices.length} paired`,devices.length?'ok':'off','dev-rect');
    node(220,cy,170,'Tunnel',overview.tunnel.state,down?'bad':overview.tunnel.state==='online'?'ok':'off','tunnel-rect');
    node(465,cy,175,'CozyGateway',`v${overview.gateway.version}`,'ok','gw-rect');
    path('p-phone-tunnel',`M160,${cy} L220,${cy}`);path('p-tunnel-gw',`M390,${cy} L465,${cy}`);
    rows.forEach((bot,index)=>{const y=36+index*48,live=state.connected&&Date.now()-(state.liveBots.get(bot.id)??0)<10000;
      path(`p-gw-${index}`,`M640,${cy} C680,${cy} 680,${y} 720,${y}`,live);
      node(720,y,180,bot.name,live?'recent activity':bot.online?'online':'absent',live?'live':bot.online?'ok':'off');
      if(live&&!reduce.matches){const packet=svgElement('use',{href:'#pk-in',class:'pkt in'},packets);const motion=svgElement('animateMotion',{dur:'2.2s',repeatCount:'indefinite',rotate:'auto'},packet);svgElement('mpath',{href:`#p-gw-${index}`},motion);}
    });
    svgElement('text',{x:1010,y:cy-6,class:'lbl'},svg,'Model boundary');svgElement('text',{x:1010,y:cy+14,class:'detail'},svg,'Topology not reported');
    if(!rows.length)svgElement('text',{x:720,y:cy,class:'detail'},svg,'No peers reported');
    const description=`${devices.length} paired devices; tunnel ${overview.tunnel.state}; ${bots.filter(bot=>bot.online).length} of ${bots.length} bots online${bots.length>8?'; first eight shown':''}. Model-server topology is not reported.`;
    svg.setAttribute('aria-label',description);$('flow-narrow').textContent=description;motion();
  }
  function motion(){document.querySelectorAll('svg.flow').forEach(el=>{try{if(reduce.matches||!state.connected)el.pauseAnimations();else el.unpauseAnimations();}catch{}});}
  reduce.addEventListener('change',()=>{renderFlow();motion();});
  let socket,refreshTimer,reconnectTimer;
  function scheduleRefresh(){if(refreshTimer)return;refreshTimer=setTimeout(()=>{refreshTimer=undefined;refresh();},750);}
  function connect(){
    if(state.authExpired||!navigator.onLine||socket?.readyState===WebSocket.OPEN||socket?.readyState===WebSocket.CONNECTING)return;
    const ws=socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws`);
    ws.addEventListener('open',()=>ws.send(JSON.stringify({type:'auth',token})));
    ws.addEventListener('message',event=>{if(ws!==socket)return;let frame;try{frame=JSON.parse(event.data);}catch{return;}
      if(frame.type==='ready'){
        state.connected=true;state.reconnect=0;connection('Live');
        ws.send(JSON.stringify({type:'observe_subscribe',kinds:['observe_sample','observe_event','observe_chat_delta','bot_task_updated','bot_presence','bot_roster','bot_approval_pending','bot_approval_resolved']}));scheduleRefresh();
      }else if(frame.type==='error'&&frame.code==='unauthorized'){expired();ws.close();}
      else if(frame.type==='observe_gap'){connection('Live · missed updates, refreshing','wait');scheduleRefresh();}
      else if(['observe_sample','observe_event','observe_update','observe_chat_delta'].includes(frame.type)){
        if(frame.bot)state.liveBots.set(frame.bot,Date.now());scheduleRefresh();
      }
    });
    ws.addEventListener('close',()=>{if(ws!==socket)return;state.connected=false;motion();if(state.authExpired)return;connection(navigator.onLine?'Disconnected · reconnecting':'Offline','stale');clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connect,Math.min(30000,1000*2**Math.min(state.reconnect++,5)));});
    ws.addEventListener('error',()=>{if(ws===socket)connection('Connection interrupted','stale');});
  }
  addEventListener('online',()=>{connection('Reconnecting');clearTimeout(reconnectTimer);connect();refresh();});
  addEventListener('offline',()=>{socket?.close();state.connected=false;connection('Offline · last received values','stale');motion();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){refresh();if(!socket||socket.readyState===WebSocket.CLOSED)connect();}});
  setInterval(()=>{if(!document.hidden)refresh();},30000);
  setInterval(()=>{if(state.lastUpdate&&Date.now()-state.lastUpdate>90000&&!state.authExpired)connection('Stale · waiting for gateway','stale');},10000);
  addEventListener('pagehide',()=>{clearTimeout(reconnectTimer);socket?.close();});
  refresh();connect();

  function renderAnatomy(turn) {
    function ms(v) { return v < 1000 ? Math.round(v) + ' ms' : v < 60000 ? (v / 1000).toFixed(1) + ' s' : Math.floor(v / 60000) + ' m ' + Math.round((v % 60000) / 1000) + ' s'; }
    function tok(v) { return v < 1000 ? String(v) : v < 100000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v / 1000) + 'k'; }
    function num(v) { return number(v); }
    function spanName(sp) { return sp.kind === 'model_step' ? 'model step ' + sp.n : sp.kind === 'tool_call' ? sp.name + (sp.calls > 1 ? ' ×' + sp.calls : '') : sp.kind === 'approval_wait' ? 'approval wait' : sp.kind === 'checkpoint' ? 'checkpoint ' + sp.id : sp.kind; }
    function facts(sp) {
      var d = sp.end - sp.start, f = [];
      if (sp.kind === 'prompt') f = [['Tokens', num(sp.tokens) + ' tok'], ['Assembled at', ms(sp.start)]];
      else if (sp.kind === 'model_step') f = [['Duration', ms(d)], ['First token at', ms(sp.firstTokenAt)], ['Prompt tokens', num(sp.promptTokens) + (sp.cachedTokens ? ' · ' + num(sp.cachedTokens) + ' cached' : ' · none cached')], ['Completion tokens', num(sp.completionTokens)], ['HTTP', String(sp.status)]];
      else if (sp.kind === 'tool_call') f = [['Duration', ms(d) + (sp.calls > 1 ? ' for ' + sp.calls + ' calls' : '')], ['Family · role', sp.family + ' · ' + sp.role], ['Result tokens', num(sp.resultTokens) + (sp.resultTokens > 10000 ? ' · heavy' : '')], ['Cache hits', sp.cacheHits + ' of ' + sp.calls], ['Outcome', sp.outcome]];
      else if (sp.kind === 'approval_wait') f = [['Waited', ms(d) + ', not counted as work'], ['Category', sp.category], ['Answered by', sp.answeredBy + ' · ' + sp.outcome]];
      else if (sp.kind === 'stream') f = [['Duration', ms(d)], ['Delta frames', String(sp.frames)], ['Frame gap, mean', ms(d / sp.frames)]];
      else if (sp.kind === 'checkpoint') f = [['Sealed at', ms(sp.start - waitDur) + ' of work'], ['Id', sp.id]];
      return f;
    }
    var waitSpan = turn.spans.filter(function (x) { return x.kind === 'approval_wait'; })[0];
    var waitDur = waitSpan ? waitSpan.end - waitSpan.start : 0;
    var tsvg = document.getElementById('turnsvg'), inspect = document.getElementById('turn-inspect');
    var selected = turn.spans.indexOf(turn.spans.filter(function (x) { return x.kind === 'tool_call'; }).sort(function (a, b) { return b.resultTokens - a.resultTokens; })[0]);
    if (selected < 0) selected = 0;
    function showSpan(i) {
      var sp = turn.spans[i], kindClass = { prompt: 'live', model_step: '', tool_call: sp.role === 'Mutation' ? 'wait' : 'live', approval_wait: 'wait', stream: 'live', checkpoint: 'ok' }[sp.kind];
      inspect.innerHTML = '<div class="ih"><span class="chip ' + kindClass + '">' + esc(sp.kind.replace('_',' ')) + '</span><b>' + esc(spanName(sp)) + '</b></div>' + kv(facts(sp));
      tsvg.querySelectorAll('.span').forEach(function (g) { g.classList.toggle('sel', +g.dataset.i === selected); });
    }
    function renderTurn() {
      var NS = svgNS, L = 84, R = 784, G = 56, total = turn.spans[turn.spans.length - 1].end, work = total - waitDur, k = (R - L - G) / work;
      function X(t) { return waitSpan && t >= waitSpan.end ? L + G + (t - waitDur) * k : waitSpan && t > waitSpan.start ? L + (waitSpan.start * k) : L + t * k; }
      function el(tag, attrs, parent) { var e = document.createElementNS(NS, tag); for (var a in attrs) e.setAttribute(a, attrs[a]); (parent || tsvg).appendChild(e); return e; }
      function txt(x, y, str, attrs, parent) { var t = el('text', Object.assign({ x: x, y: y }, attrs || {}), parent); t.textContent = str; return t; }
      Array.prototype.slice.call(tsvg.childNodes).forEach(function (n) { if (n.nodeName !== 'defs') tsvg.removeChild(n); });
      // context growth: prompt tokens the model reads, rising as tool results are appended
      var cy0 = 18, cy1 = 78, cmax = Math.max(1, ...turn.spans.map(s => (s.promptTokens || s.tokens || 0) + (s.completionTokens || 0))), cyOf = function (v) { return cy1 - (v / cmax) * (cy1 - cy0); };
      var ctxPts = [[0, turn.spans[0].tokens]], running = turn.spans[0].tokens;
      turn.spans.forEach(function (sp) { if (sp.kind === 'model_step') { running = sp.promptTokens; ctxPts.push([sp.start, running]); running += sp.completionTokens; ctxPts.push([sp.end, running]); } });
      var pts = ctxPts.map(function (p) { return X(p[0]).toFixed(1) + ',' + cyOf(p[1]).toFixed(1); }).join(' ');
      el('line', { x1: L, y1: cy1, x2: R, y2: cy1, 'class': 'grid' });
      el('polygon', { points: pts + ' ' + X(total).toFixed(1) + ',' + cy1 + ' ' + L + ',' + cy1, 'class': 'ctxarea late' });
      if (Number.isFinite(turn.rollover)) el('line', { x1: L, y1: cyOf(turn.rollover), x2: R, y2: cyOf(turn.rollover), 'class': 'threshold' });
      if (Number.isFinite(turn.rollover)) txt(R, cyOf(turn.rollover) - 4, 'rollover ' + tok(turn.rollover), { 'text-anchor': 'end', 'class': 'mono' });
      el('polyline', { points: pts, 'class': 'ctx draw', pathLength: 1 });
      txt(L - 6, cyOf(ctxPts[0][1]) + 4, tok(ctxPts[0][1]), { 'text-anchor': 'end', 'class': 'mono' });
      txt(X(total) + 6, cyOf(running) + 4, tok(running) + ' read', { 'class': 'mono' });
      txt(4, cy0 + 8, 'context', { 'class': 'lbl' });
      // lanes
      var lanes = { model: [96, 118], tools: [126, 156], person: [166, 182], output: [192, 214] };
      Object.keys(lanes).forEach(function (n) { txt(4, lanes[n][1] - 4, n, { 'class': 'lbl' }); el('line', { x1: L, y1: lanes[n][1] + 4, x2: R, y2: lanes[n][1] + 4, 'class': 'grid' }); });
      var hOf = function (t) { return 6 + 24 * Math.log10(Math.max(t, 10)) / Math.log10(50000); };
      turn.spans.forEach(function (sp, i) {
        var g = el('g', { 'class': 'span', tabindex: 0, role: 'button', 'data-i': i, 'aria-label': spanName(sp) + ', ' + facts(sp).map(function (f) { return f[0] + ' ' + f[1]; }).join(', ') });
        var x0 = X(sp.start), x1 = sp.kind === 'approval_wait' ? x0 + G : Math.max(X(sp.end), x0 + 3), t = document.createElementNS(NS, 'title'); t.textContent = spanName(sp) + ' · ' + facts(sp).map(function (f) { return f[1]; }).join(' · '); g.appendChild(t);
        if (sp.kind === 'prompt') { el('path', { d: 'M' + (x0 - 5) + ',' + lanes.model[0] + ' l5,-6 5,6z', 'class': 'prompt' }, g); txt(x0 + 8, lanes.model[0] - 6, 'prompt ' + tok(sp.tokens) + ' tok', { 'class': 'mono' }, g); }
        else if (sp.kind === 'model_step') {
          var y = lanes.model[0], h = lanes.model[1] - y;
          el('rect', { x: x0, y: y, width: x1 - x0, height: h, rx: 4, 'class': 'bar model' }, g);
          if (sp.cachedTokens) el('rect', { x: x0, y: y, width: (x1 - x0) * sp.cachedTokens / sp.promptTokens, height: h, rx: 4, 'class': 'cached' }, g);
          el('line', { x1: X(sp.start + sp.firstTokenAt), y1: y - 3, x2: X(sp.start + sp.firstTokenAt), y2: y + h + 3, 'class': 'tick' }, g);
          txt(x0, y - 5, 'in ' + tok(sp.promptTokens) + ' · out ' + tok(sp.completionTokens), { 'class': 'mono' }, g);
          if (sp.n === 1) txt(X(sp.start + sp.firstTokenAt) + 3, y + h + 14, 'first token ' + ms(sp.firstTokenAt), { 'class': 'mono sub' }, g);
        } else if (sp.kind === 'tool_call') {
          var h2 = hOf(sp.resultTokens), y2 = lanes.tools[1] - h2, heavy = sp.resultTokens > 10000;
          el('rect', { x: x0, y: y2, width: x1 - x0, height: h2, rx: 3, 'class': 'bar ' + (sp.role === 'Mutation' ? 'mut' : 'inv') + (heavy ? ' heavy' : '') }, g);
          if (x1 - x0 >= 30 || sp.calls > 1) {
            var lx = x1 + 5, ly = y2 + 12;
            var u = el('use', { href: sp.role === 'Mutation' ? '#g-mut' : '#g-inv', x: lx, y: ly - 10, width: 12, height: 12, 'class': 'role' }, g); u.setAttribute('color', sp.role === 'Mutation' ? 'var(--cork-ink)' : 'var(--sky-ink)');
            txt(lx + 15, ly, sp.name + (sp.calls > 1 ? ' ×' + sp.calls : ''), {}, g);
            txt(lx + 15, ly + 14, tok(sp.resultTokens) + ' tok · ' + ms(sp.end - sp.start), { 'class': 'mono sub' }, g);
          }
        } else if (sp.kind === 'approval_wait') {
          var y3 = lanes.person[0], h3 = lanes.person[1] - y3;
          el('rect', { x: x0, y: y3, width: G, height: h3, rx: 3, 'class': 'bar wait' }, g);
          el('path', { d: 'M' + (x0 + G / 2 - 5) + ',' + (y3 - 2) + ' l4,' + (h3 + 4) + ' m4,-' + (h3 + 4) + ' l4,' + (h3 + 4), 'class': 'break' }, g);
          txt(x0 + G + 6, y3 + 12, ms(sp.end - sp.start) + ' waiting · ' + sp.category + ' · answered by ' + sp.answeredBy, {}, g);
          txt(x0 + G / 2, 236, 'compressed', { 'text-anchor': 'middle', 'class': 'mono sub' }, g);
        } else if (sp.kind === 'stream') {
          var y4 = lanes.output[0], h4 = lanes.output[1] - y4;
          el('rect', { x: x0, y: y4, width: x1 - x0, height: h4, rx: 3, fill: 'transparent', 'class': 'bar' }, g);
          for (var f = 0; f < sp.frames; f++) { var fx = x0 + (x1 - x0) * (f + 0.5) / sp.frames; el('line', { x1: fx, y1: y4 + 3, x2: fx, y2: y4 + h4 - 3, 'class': 'frame' }, g); }
          txt(x0, y4 - 5, sp.frames + ' frames · ' + ms(sp.end - sp.start), { 'class': 'mono sub' }, g);
        } else if (sp.kind === 'checkpoint') {
          el('use', { href: '#g-ok', x: x0 - 7, y: lanes.output[0] + 4, width: 14, height: 14 }, g);
          txt(x0 + 10, lanes.output[0] + 15, sp.id + ' sealed', { 'class': 'mono' }, g);
        }
        g.addEventListener('mouseenter', function () { showSpan(i); });
        g.addEventListener('mouseleave', function () { showSpan(selected); });
        g.addEventListener('focus', function () { showSpan(i); });
        g.addEventListener('blur', function () { showSpan(selected); });
        g.addEventListener('click', function () { selected = i; showSpan(i); });
        g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selected = i; showSpan(i); } });
      });
      // axis in work time, every second
      for (var tt = 0; tt <= work; tt += Math.max(1000, Math.ceil(work / 10000) * 1000)) { var ax = X(tt < (waitSpan ? waitSpan.start : Infinity) ? tt : tt + waitDur); el('line', { x1: ax, y1: 218, x2: ax, y2: 223, 'class': 'grid' }); txt(ax, 236, tt === 0 ? '0' : (tt / 1000) + ' s', { 'text-anchor': 'middle', 'class': 'mono sub' }); }
      txt(R, 236, 'work time', { 'text-anchor': 'end', 'class': 'mono sub' });
      // playhead: one sweep on load, then rests at the end; reduced motion places it at the end
      var ph = el('line', { x1: reduce.matches ? R : L, y1: 12, x2: reduce.matches ? R : L, y2: 218, 'class': 'playhead' });
      if (!reduce.matches) ['x1', 'x2'].forEach(function (a) { el('animate', { attributeName: a, from: L, to: R, dur: '6s', begin: '0.5s', fill: 'freeze', calcMode: 'spline', keyTimes: '0;1', keySplines: '0.2 0 0.8 1' }, ph); });
      // words
      var model = 0, tools = 0, read = 0, heavyTok = 0, frames = 0, calls = 0;
      turn.spans.forEach(function (sp) { if (sp.kind === 'model_step') { model += sp.end - sp.start; read += sp.promptTokens; } if (sp.kind === 'tool_call') { tools += sp.end - sp.start; calls += sp.calls; heavyTok = Math.max(heavyTok, sp.resultTokens); } if (sp.kind === 'stream') frames += sp.frames; });
      var sentence = turn.bot + ' turn ' + turn.id + ' on ' + turn.model + ', started ' + turn.startedAt + ': ' + ms(model + tools) + ' of work, of which model ' + ms(model) + ' and tools ' + ms(tools) + ' across ' + calls + ' calls; ' + ms(waitDur) + ' waiting on a person, not counted; ' + tok(read) + ' tokens read by the model, ' + tok(heavyTok) + ' of them from one tool batch; ' + frames + ' frames streamed; ' + ms(work) + ' wall without the wait.';
      document.getElementById('turn-summary').innerHTML = '<b>' + ms(model + tools) + '</b> of work, of which model <b>' + ms(model) + '</b> and tools <b>' + ms(tools) + '</b> across <b>' + calls + '</b> calls. <b>' + ms(waitDur) + '</b> waiting on a person, not counted. <b>' + tok(read) + '</b> tokens read by the model, <b>' + tok(heavyTok) + '</b> of them from one tool batch. <b>' + frames + '</b> frames streamed. Wall without the wait <b>' + ms(work) + '</b>.';
      tsvg.setAttribute('aria-label', 'Anatomy of the last turn. ' + sentence + ' Each span is focusable and reads its own facts.');
      document.getElementById('turn-narrow').textContent = 'Turn anatomy needs a wider screen. ' + sentence;
      document.getElementById('turn-sub').textContent = turn.bot + ' · ' + turn.id + ' · started ' + turn.startedAt + ' · replays once on load · hover, focus or click a span';
      showSpan(selected);
    }

    renderTurn();
  }
})();
