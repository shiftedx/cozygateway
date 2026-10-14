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
  const endpoints = ['overview','bots','turns','roundtrip','attach','approvals','deliveries','devices','events','series?series=tunnel_rtt_ms','series?series=ttft_ms'];
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
  const panelPaths = { overview:['glance','header-strip'], bots:['bots'], turns:['turns'], roundtrip:['roundtrip','felt','network-path'], attach:['attach'], approvals:['approvals'], deliveries:['deliveries'], devices:['devices'], events:['events'], 'series?series=tunnel_rtt_ms':['tunnel-chart'], 'series?series=ttft_ms':['first-token-chart'] };
  function render() {
    renderOverview(); renderBots(); renderLatency(); renderTurns(); renderAttach(); renderApprovals(); renderDeliveries(); renderDevices(); renderEvents(); renderFlow();
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
    const tiles = [ ['Needs a person',number(data.needsAPerson.total),`${number(data.needsAPerson.approvals)} approvals · ${number(data.needsAPerson.repairs)} repairs`,'wait'], ['Round trip',data.tiles.roundTrip?.samples ? duration(data.tiles.roundTrip.p50) : 'No samples',`socket round trip · n ${number(data.tiles.roundTrip?.samples)}`,''], ['First token',data.tiles.firstToken?.samples ? duration(data.tiles.firstToken.p50) : 'No samples',`p50 · n ${number(data.tiles.firstToken?.samples)}`,''], ['Turns',number(data.tiles.turns),`terminal records · ${state.window}`,''] ];
    $('glance').innerHTML = tiles.map(([label,value,description,status]) => `<div class="tile ${status}" role="listitem"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div><div class="d">${esc(description)}</div></div>`).join('');
    const approvals = state.data.approvals?.pending ?? [];
    const repairs = [];
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
    $('devices').innerHTML=`<div><h3>Devices</h3>${table(['Name','Kind','Scope','Last seen'],(data.devices??[]).map(row=>[esc(row.name),esc(row.kind),chip(row.scope),esc(age(row.lastSeenAt))]))}</div>`;
  }
  function renderEvents() {
    const all=state.data.events?.events;if(!all)return;
    const select=$('event-kind'); const kinds=[...new Set(all.map(row=>row.kind))].sort();
    select.innerHTML='<option value="">All kinds</option>'+kinds.map(kind=>`<option value="${esc(kind)}">${esc(kind)}</option>`).join(''); select.value=state.kind;
    $('events').innerHTML=table(['Time','Kind','Bot','Details'],all.filter(row=>!state.kind||row.kind===state.kind).map(row=>[esc(clock(row.at)),chip(row.kind),esc(row.botName??'gateway'),esc(Object.entries(row.detail??{}).map(([k,v])=>`${k}: ${v}`).join(' · ')||'No detail')]))+historyNote(state.data.events,all.length,state.data.events.totalEvents,'events')+(state.kind?empty('Kind filter applies to the received event feed.'): '');
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

})();
