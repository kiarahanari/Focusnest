/* FocusNest — firebase-messaging-sw.js (v19)
   Menampilkan push pengingat saat app DITUTUP (dengan bunyi sistem + getar panjang),
   dan membunyikan alarm berulang begitu app dibuka / notifikasi diketuk. */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('push',e=>{
  let p={};try{p=e.data?e.data.json():{}}catch(x){try{p={data:{body:e.data.text()}}}catch(y){}}
  const n=p.notification||{},d=p.data||{},title=n.title||d.title||'⏰ FocusNest',body=n.body||d.body||'',tag=d.tag||n.tag||'focusnest';
  e.waitUntil((async()=>{
    const cl=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    cl.forEach(c=>{try{c.postMessage({type:'fn-ring',title,body})}catch(x){}});
    await self.registration.showNotification(title,{body,tag,renotify:true,requireInteraction:true,silent:false,vibrate:[500,200,500,200,500,200,800],data:{title,body}});
  })());
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const dt=e.notification.data||{},base=new URL('./',self.location).href;
  e.waitUntil((async()=>{
    const cl=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const c of cl){if(c.url.startsWith(base)){try{c.postMessage({type:'fn-ring',title:dt.title,body:dt.body});return await c.focus()}catch(x){}}}
    return self.clients.openWindow(base+'?ring=1&title='+encodeURIComponent(dt.title||'')+'&body='+encodeURIComponent(dt.body||''));
  })());
});
