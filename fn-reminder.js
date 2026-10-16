/* FocusNest — pengingat latar belakang (tambahan service worker)
   Pasang: taruh file ini sefolder dengan service-worker.js, lalu tambahkan di BARIS PERTAMA service-worker.js:
   importScripts('fn-reminder.js'); */
const FNC='fn-sched-v1',FNK='/__fn_sched__';
let fnT=[];
const fnLoad=async()=>{try{const c=await caches.open(FNC),r=await c.match(FNK);return r?await r.json():[]}catch(e){return[]}};
const fnSave=async l=>{try{const c=await caches.open(FNC);await c.put(FNK,new Response(JSON.stringify(l)))}catch(e){}};
async function fnShow(i){await self.registration.showNotification(i.title,{body:i.body,tag:i.tag,renotify:true,requireInteraction:true,vibrate:[200,100,200,100,200],data:{fn:1}})}
async function fnDue(){const l=await fnLoad(),now=Date.now();let ch=0;for(const i of l){if(!i.done&&i.at<=now&&i.at>now-45*6e4){i.done=1;ch=1;await fnShow(i)}}if(ch)await fnSave(l)}
function fnArm(l){fnT.forEach(clearTimeout);fnT=[];const now=Date.now();l.forEach(i=>{const d=i.at-now;if(!i.done&&d>0&&d<6*36e5)fnT.push(setTimeout(()=>{fnDue()},d))})}
self.addEventListener('message',e=>{const d=e.data||{};if(d.type!=='fn-sched')return;e.waitUntil((async()=>{const old=await fnLoad(),dn=new Set(old.filter(x=>x.done).map(x=>x.tag+'|'+x.at));const l=(d.items||[]).map(i=>({...i,done:dn.has(i.tag+'|'+i.at)?1:0}));await fnSave(l);fnArm(l);await fnDue()})())});
self.addEventListener('periodicsync',e=>{if(e.tag==='fn-remind')e.waitUntil(fnDue())});
self.addEventListener('push',e=>{e.waitUntil(fnDue())});
self.addEventListener('notificationclick',e=>{if(!(e.notification.data&&(e.notification.data.fn||e.notification.data.fnt)))return;e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>l[0]?l[0].focus():clients.openWindow('./')))});
