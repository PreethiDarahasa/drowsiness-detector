// ── CONFIG ──
const BROKER = 'wss://broker.hivemq.com:8884/mqtt';
const TOPIC = 'vehicle/data';
const THRESHOLD = 400;
const MAX_HISTORY = 20;
const MAX_ALERTS = 40;
const PATH_COLORS = { SAFE:'#10b981', WARNING:'#f59e0b', DANGER:'#ef4444' };

// ── STATE ──
let client = null, connected = false, skipFirst = false;
let vehicles = {};
let selectedId = null, activeFilter = 'ALL';
let alerts = [], globalHistory = [];
let audioCtx = null, tsInterval = null;
const $ = id => document.getElementById(id);

// ══════════════════════════════════════════
//  LEAFLET MAP
// ══════════════════════════════════════════
const map = L.map('map', { center:[20.59,78.96], zoom:5, zoomControl:true, attributionControl:false });
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom:19 }).addTo(map);
setTimeout(() => map.invalidateSize(), 300);
window.addEventListener('resize', () => map.invalidateSize());

function markerIcon(status) {
  const c = status==='DANGER'?'cm-danger':status==='WARNING'?'cm-warn':'cm-safe';
  const s = status==='DANGER'?'!':status==='WARNING'?'⚠':'✓';
  return L.divIcon({ className:'', html:`<div class="custom-marker ${c}">${s}</div>`, iconSize:[26,26], iconAnchor:[13,13], popupAnchor:[0,-16] });
}

function popupHtml(v) {
  const dc = v.status==='DANGER'?'danger':v.status==='WARNING'?'warn':'safe';
  const dr = v.drowsy?'<span style="color:var(--danger);font-weight:700">DROWSY</span>':'<span style="color:var(--safe)">Awake</span>';
  return `<div class="popup-title">${v.vehicle_id}</div>
    <div class="popup-row"><span class="popup-label">Status</span><span class="popup-val" style="color:var(--${dc})">${v.status}</span></div>
    <div class="popup-row"><span class="popup-label">Alcohol</span><span class="popup-val">${v.alcohol}</span></div>
    <div class="popup-row"><span class="popup-label">Driver</span>${dr}</div>
    <div class="popup-row"><span class="popup-label">Time</span><span class="popup-val">${formatTime(v.time)}</span></div>`;
}

// ══════════════════════════════════════════
//  MQTT
// ══════════════════════════════════════════
function toggleConnection() { connected ? disconnect() : connect(); }

function connect() {
  const id = 'drowsyguard_' + Math.random().toString(16).substr(2,6);
  log('Connecting to broker...','warn');
  try {
    client = mqtt.connect(BROKER, { clientId:id, clean:true, connectTimeout:10000, reconnectPeriod:5000 });
    client.on('connect', () => {
      connected = true; skipFirst = true; updateConnUI(true);
      client.publish(TOPIC, '', { retain:true });
      client.subscribe(TOPIC, {qos:0}, err => {
        if(!err) { log('✓ Subscribed to "'+TOPIC+'"','info'); log('Waiting for ESP32 data...','data'); }
      });
      log('✓ Connected to broker','info');
    });
    client.on('message', (t,msg) => {
      if(!$('chk-live').checked) return;
      if(skipFirst){skipFirst=false;log('Cleared retained message','warn');return;}
      handleMessage(msg.toString());
    });
    client.on('error', e => log('Error: '+e.message,'alert'));
    client.on('close', () => { if(connected){connected=false;updateConnUI(false);log('Connection closed','warn');} });
    client.on('reconnect', () => log('Reconnecting...','warn'));
  } catch(e) { log('Connection failed: '+e.message,'alert'); }
}

function disconnect() {
  if(client){client.end(true);client=null;}
  connected=false; updateConnUI(false); log('Disconnected','warn');
}

function updateConnUI(on) {
  $('conn-dot').classList.toggle('online',on);
  $('conn-label').textContent = on?'Connected':'Disconnected';
  $('btn-connect').textContent = on?'Disconnect':'Connect';
  $('btn-connect').classList.toggle('active',on);
}

// ══════════════════════════════════════════
//  MESSAGE HANDLER
// ══════════════════════════════════════════
function handleMessage(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { log('⚠ Invalid JSON','alert'); return; }

  const vid = data.vehicle_id || 'UNKNOWN';
  const alc = parseInt(data.alcohol)||0;
  const drowsy = data.drowsy===true||data.drowsy==='true'||data.drowsy==='True';
  const lat = data.lat&&data.lat!=='0'?parseFloat(data.lat):null;
  const lon = data.lon&&data.lon!=='0'?parseFloat(data.lon):null;
  const time = data.time||new Date().toLocaleString();

  let status;
  if(alc>=THRESHOLD&&drowsy) status='DANGER';
  else if(alc>=THRESHOLD||drowsy) status='WARNING';
  else status='SAFE';
  const cls = status==='DANGER'?'danger':status==='WARNING'?'warn':'safe';
  const entry = {vehicle_id:vid,alcohol:alc,drowsy,lat,lon,time,status,cls};

  log(`[${vid}] alc=${alc} drowsy=${drowsy} status=${status}`,'data');

  // ── Store vehicle ──
  if(!vehicles[vid]) vehicles[vid] = {...entry, history:[entry], marker:null, path:null};
  else { Object.assign(vehicles[vid],entry); vehicles[vid].history.unshift(entry); if(vehicles[vid].history.length>MAX_HISTORY) vehicles[vid].history.pop(); }

  // ── Map marker ──
  if(lat!==null&&lon!==null) {
    const v=vehicles[vid], ll=[lat,lon];
    if(v.marker){ v.marker.setLatLng(ll); v.marker.setIcon(markerIcon(status)); v.marker.getPopup().setContent(popupHtml(v)); }
    else { v.marker=L.marker(ll,{icon:markerIcon(status)}).bindPopup(popupHtml(v),{maxWidth:240}).addTo(map); v.marker.on('click',()=>selectVehicle(vid)); }
    // Path line
    const pts=v.history.filter(h=>h.lat&&h.lon).map(h=>[parseFloat(h.lat),parseFloat(h.lon)]);
    if(pts.length>1){ if(v.path) map.removeLayer(v.path); v.path=L.polyline(pts,{color:PATH_COLORS[status]||'#06b6d4',weight:2,opacity:.5,dashArray:'6,4'}).addTo(map); }
  }

  // ── Cards (show latest message) ──
  $('val-alcohol').textContent=alc;
  $('sub-alcohol').textContent=alc>=THRESHOLD?'⚠ Above threshold ('+THRESHOLD+')':'Within safe range';
  setCardState('card-alcohol',alc>=THRESHOLD?(drowsy?'danger':'warn'):'safe');
  $('val-drowsy').textContent=drowsy?'DROWSY':'AWAKE';
  $('sub-drowsy').textContent=drowsy?'⚠ Driver appears drowsy':'✓ Driver is alert';
  setCardState('card-drowsy',drowsy?'danger':'safe');
  $('val-safety').textContent=status;
  $('sub-safety').textContent=status==='SAFE'?'✓ All parameters normal':status==='WARNING'?'⚠ Attention required':'🚨 Immediate action needed';
  setCardState('card-safety',cls);
  $('val-time').textContent=formatTime(time);
  $('sub-time').textContent='Vehicle: '+vid;
  setCardState('card-time',cls);
  $('val-vehicles').textContent=Object.keys(vehicles).length;
  $('sub-vehicles').textContent=Object.values(vehicles).filter(v=>v.status==='DANGER').length+' in danger';
  setCardState('card-vehicles',Object.values(vehicles).some(v=>v.status==='DANGER')?'danger':'safe');

  // ── GPS ──
  if(lat!==null&&lon!==null){
    $('gps-value').textContent=lat.toFixed(6)+', '+lon.toFixed(6);
    $('btn-location').disabled=false;
    $('btn-location').onclick=()=>window.open('https://maps.google.com/?q='+lat+','+lon,'_blank');
  }

  // ── Alert banner ──
  if(status!=='SAFE'){
    $('alert-banner').className='alert-banner active '+(status==='DANGER'?'danger-bg':'warn-bg');
    $('alert-icon').textContent=status==='DANGER'?'🚨':'⚠️';
    $('alert-text').textContent=`[${vid}] `+(status==='DANGER'?'DANGER — High alcohol + Drowsy!':drowsy?'WARNING — Drowsiness detected!':'WARNING — High alcohol!');
    const reasons=[]; if(alc>=THRESHOLD) reasons.push('Alcohol: '+alc); if(drowsy) reasons.push('Drowsy');
    addAlert(vid,status,reasons.join(' + '),time);
    playAlert();
  } else { $('alert-banner').className='alert-banner'; }

  // ── History ──
  globalHistory.unshift(entry); if(globalHistory.length>60) globalHistory.length=60;
  renderHistory();
  renderVehicleList();
  updateStats();
  if(selectedId===vid) showDetail(vid);
}

// ══════════════════════════════════════════
//  VEHICLE LIST
// ══════════════════════════════════════════
function renderVehicleList() {
  const el=$('vehicle-list'), search=($('search-input').value||'').toUpperCase();
  const ids=Object.keys(vehicles).filter(v=>{
    if(activeFilter!=='ALL'&&vehicles[v].status!==activeFilter) return false;
    if(search&&!v.toUpperCase().includes(search)) return false;
    return true;
  });
  const order={DANGER:0,WARNING:1,SAFE:2};
  ids.sort((a,b)=>(order[vehicles[a].status]||2)-(order[vehicles[b].status]||2));
  if(!ids.length){ el.innerHTML='<div class="vp-empty">No vehicles match</div>'; return; }
  el.innerHTML=ids.map(id=>{
    const v=vehicles[id],c=v.cls,sel=selectedId===id?'selected':'';
    return `<div class="v-item ${sel}" onclick="selectVehicle('${id}')"><div class="v-dot ${c}"></div><div class="v-info"><div class="v-id">${id}</div><div class="v-meta">${timeAgo(v.time)}</div></div><span class="v-status ${c}">${v.status}</span></div>`;
  }).join('');
}

function setFilter(f,el){ activeFilter=f; document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active')); el.classList.add('active'); renderVehicleList(); }

function selectVehicle(vid){
  selectedId=vid; renderVehicleList(); showDetail(vid);
  const v=vehicles[vid];
  if(v&&v.lat&&v.lon){ map.flyTo([parseFloat(v.lat),parseFloat(v.lon)],14,{duration:1}); if(v.marker) v.marker.openPopup(); }
}

function showDetail(vid){
  const v=vehicles[vid]; if(!v) return;
  const si=$('selected-info'); si.classList.add('active');
  const coords=(v.lat&&v.lon)?parseFloat(v.lat).toFixed(5)+', '+parseFloat(v.lon).toFixed(5):'N/A';
  const dr=v.drowsy?'<span style="color:var(--danger)">⚠ DROWSY</span>':'<span style="color:var(--safe)">✓ Awake</span>';
  const alcC=v.alcohol>=THRESHOLD?'color:var(--danger)':'color:var(--safe)';
  si.innerHTML=`<div class="si-header"><div class="si-vid">🚗 ${vid}</div><span class="si-status ${v.cls}">${v.status}</span></div>
    <div class="si-grid">
      <div class="si-item"><div class="si-label">Alcohol</div><div class="si-val" style="${alcC}">${v.alcohol}</div></div>
      <div class="si-item"><div class="si-label">Driver</div><div class="si-val">${dr}</div></div>
      <div class="si-item"><div class="si-label">Location</div><div class="si-val" style="font-family:monospace;font-size:.72rem">${coords}</div></div>
      <div class="si-item"><div class="si-label">Last Update</div><div class="si-val" style="font-size:.72rem">${formatTime(v.time)}</div></div>
      <div class="si-item"><div class="si-label">Records</div><div class="si-val">${v.history.length}</div></div>
    </div>`;
}

// ══════════════════════════════════════════
//  ALERTS
// ══════════════════════════════════════════
function addAlert(vid,status,reason,time){
  alerts.unshift({vid,status,reason,time}); if(alerts.length>MAX_ALERTS) alerts.pop();
  const el=$('alerts-list');
  el.innerHTML=alerts.slice(0,25).map(a=>{
    const c=a.status==='DANGER'?'a-danger':'a-warn', ic=a.status==='DANGER'?'🚨':'⚠️';
    return `<div class="a-item ${c}" onclick="selectVehicle('${a.vid}')"><div class="a-icon">${ic}</div><div class="a-body"><div class="a-vid">${a.vid}</div><div class="a-msg">${a.reason}</div><div class="a-time">${formatTime(a.time)}</div></div></div>`;
  }).join('');
}

// ══════════════════════════════════════════
//  HISTORY & STATS
// ══════════════════════════════════════════
function renderHistory(){
  const tbody=$('history-body');
  tbody.innerHTML=globalHistory.slice(0,MAX_HISTORY).map(h=>`<tr>
    <td style="font-weight:600;letter-spacing:.5px">${h.vehicle_id}</td><td>${h.alcohol}</td>
    <td>${h.drowsy?'😴 Yes':'✓ No'}</td><td><span class="status-pill ${h.cls}">${h.status}</span></td>
    <td style="font-size:.65rem;color:var(--muted)">${formatTime(h.time)}</td></tr>`).join('');
  $('history-count').textContent=globalHistory.length+' entries';
}

function updateStats(){
  const all=Object.values(vehicles);
  $('stat-total').textContent=all.length;
  $('stat-danger').textContent=all.filter(v=>v.status==='DANGER').length;
  $('map-safe').textContent=all.filter(v=>v.status==='SAFE').length;
  $('map-warn').textContent=all.filter(v=>v.status==='WARNING').length;
  $('map-danger').textContent=all.filter(v=>v.status==='DANGER').length;
}

// ══════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════
function setCardState(id,state){ const e=$(id);e.classList.remove('safe','warn','danger');e.classList.add(state); }

function formatTime(t){ try{const d=new Date(t);if(isNaN(d))return t;return d.toLocaleDateString('en-IN')+', '+d.toLocaleTimeString('en-IN',{hour12:false});}catch{return t;} }

function timeAgo(t){ try{const s=Math.floor((Date.now()-new Date(t).getTime())/1000);if(isNaN(s)||s<0)return 'now';if(s<60)return s+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';return Math.floor(s/3600)+'h ago';}catch{return '—';} }

function openMap(){ const v=vehicles[selectedId]; if(v&&v.lat&&v.lon) window.open('https://maps.google.com/?q='+v.lat+','+v.lon,'_blank'); }

function playAlert(){
  if(window._lastBeep&&Date.now()-window._lastBeep<3000)return;window._lastBeep=Date.now();
  try{if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.connect(g);g.connect(audioCtx.destination);o.type='square';o.frequency.value=800;g.gain.setValueAtTime(.08,audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+.4);o.start();o.stop(audioCtx.currentTime+.4);}catch{}
}

// ══════════════════════════════════════════
//  THINGSPEAK (preserved)
// ══════════════════════════════════════════
function fetchThingSpeak(){
  const ch=$('ts-channel').value.trim(),key=$('ts-apikey').value.trim();
  if(!ch){log('Enter ThingSpeak Channel ID','alert');return;}
  const url=`https://api.thingspeak.com/channels/${ch}/feeds.json?api_key=${key}&results=50`;
  log('Fetching ThingSpeak data...','warn');
  fetch(url).then(r=>r.json()).then(d=>{
    if(!d.feeds||!d.feeds.length){log('No ThingSpeak data found','alert');return;}
    log('✓ Fetched '+d.feeds.length+' ThingSpeak entries','info'); drawChart(d.feeds);
    if(tsInterval)clearInterval(tsInterval); tsInterval=setInterval(()=>fetchThingSpeak(),20000);
  }).catch(e=>log('ThingSpeak error: '+e.message,'alert'));
}

function drawChart(feeds){
  const canvas=$('ts-chart'),ctx=canvas.getContext('2d'),rect=canvas.parentElement.getBoundingClientRect();
  canvas.width=rect.width;canvas.height=rect.height;
  const W=canvas.width,H=canvas.height,pad={t:20,r:15,b:30,l:45},plotW=W-pad.l-pad.r,plotH=H-pad.t-pad.b;
  const points=feeds.map(f=>({time:new Date(f.created_at),val:parseFloat(f.field1)||0})).filter(p=>!isNaN(p.val));
  if(!points.length)return;
  const maxVal=Math.max(...points.map(p=>p.val),THRESHOLD+200),minTime=points[0].time.getTime(),maxTime=points[points.length-1].time.getTime(),timeRange=maxTime-minTime||1;
  ctx.clearRect(0,0,W,H);ctx.fillStyle='#0f172a';ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='#ffffff08';ctx.lineWidth=1;
  for(let i=0;i<=4;i++){const y=pad.t+(plotH/4)*i;ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(W-pad.r,y);ctx.stroke();ctx.fillStyle='#64748b';ctx.font='10px Inter';ctx.textAlign='right';ctx.fillText(Math.round(maxVal-(maxVal/4)*i),pad.l-6,y+3);}
  const threshY=pad.t+plotH*(1-THRESHOLD/maxVal);ctx.strokeStyle='#ef444466';ctx.lineWidth=1;ctx.setLineDash([6,4]);ctx.beginPath();ctx.moveTo(pad.l,threshY);ctx.lineTo(W-pad.r,threshY);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#ef4444';ctx.font='9px Inter';ctx.textAlign='left';ctx.fillText('Threshold',pad.l+4,threshY-4);
  ctx.strokeStyle='#06b6d4';ctx.lineWidth=2;ctx.beginPath();
  points.forEach((p,i)=>{const x=pad.l+((p.time.getTime()-minTime)/timeRange)*plotW,y=pad.t+plotH*(1-p.val/maxVal);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});ctx.stroke();
  const grad=ctx.createLinearGradient(0,pad.t,0,H-pad.b);grad.addColorStop(0,'#06b6d433');grad.addColorStop(1,'#06b6d400');ctx.lineTo(pad.l+plotW,H-pad.b);ctx.lineTo(pad.l,H-pad.b);ctx.closePath();ctx.fillStyle=grad;ctx.fill();
  ctx.fillStyle='#06b6d4';points.forEach(p=>{const x=pad.l+((p.time.getTime()-minTime)/timeRange)*plotW,y=pad.t+plotH*(1-p.val/maxVal);ctx.beginPath();ctx.arc(x,y,2.5,0,Math.PI*2);ctx.fill();});
  ctx.fillStyle='#64748b';ctx.font='9px Inter';ctx.textAlign='center';const step=Math.max(1,Math.floor(points.length/5));
  for(let i=0;i<points.length;i+=step){const x=pad.l+((points[i].time.getTime()-minTime)/timeRange)*plotW;ctx.fillText(points[i].time.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}),x,H-8);}
}

// ── LOGGING ──
function log(msg,cls=''){
  const box=$('log-box'),t=new Date().toLocaleTimeString('en-US',{hour12:false}),d=document.createElement('div');
  if(cls)d.className=cls; d.textContent=`[${t}] ${msg}`; box.appendChild(d); box.scrollTop=box.scrollHeight;
  while(box.children.length>80) box.removeChild(box.firstChild);
}

// ── DEMO (type injectDemo() in console) ──
window.injectDemo = function(){
  [
    {vehicle_id:'AP09AB1234',alcohol:2200,drowsy:true,lat:'17.385',lon:'78.486',time:new Date().toISOString().replace('T',' ').slice(0,19),status:'DANGER'},
    {vehicle_id:'TS07CD5678',alcohol:800,drowsy:false,lat:'17.440',lon:'78.350',time:new Date().toISOString().replace('T',' ').slice(0,19),status:'SAFE'},
    {vehicle_id:'KA01EF9012',alcohol:2100,drowsy:false,lat:'12.971',lon:'77.594',time:new Date().toISOString().replace('T',' ').slice(0,19),status:'WARNING'},
    {vehicle_id:'MH12GH3456',alcohol:500,drowsy:false,lat:'19.076',lon:'72.877',time:new Date().toISOString().replace('T',' ').slice(0,19),status:'SAFE'},
    {vehicle_id:'DL04IJ7890',alcohol:3000,drowsy:true,lat:'28.613',lon:'77.209',time:new Date().toISOString().replace('T',' ').slice(0,19),status:'DANGER'},
  ].forEach(d=>handleMessage(JSON.stringify(d)));
  const g=Object.values(vehicles).filter(v=>v.marker).map(v=>v.marker.getLatLng());
  if(g.length) map.fitBounds(L.latLngBounds(g).pad(0.3));
};

// ── INIT ──
log('DrowsyGuard Dashboard initialized','info');
log('Click "Connect" to subscribe to MQTT topic: '+TOPIC,'info');
