const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('http');
const root = path.resolve(__dirname, '..');
const resultDir=path.join(root,'.performance-results'); fs.mkdirSync(resultDir,{recursive:true});
const baseline = process.argv.includes('--baseline') ? require('child_process').execFileSync('git',['show','a062cc4:index.html'],{cwd:root}) : null;
const baselineFiles = baseline ? Object.fromEntries(['style.css','fonts/inter.css'].map(f=>[f,require('child_process').execFileSync('git',['show','a062cc4:'+f],{cwd:root})])) : {};
const server = http.createServer((req,res)=>{
  const file=path.join(root,decodeURI(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURI(req.url.split('?')[0]));
  if(!file.startsWith(root) || !fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type', ({'.html':'text/html','.css':'text/css','.js':'application/javascript','.webp':'image/webp','.mp4':'video/mp4','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream');
  if(baseline && path.basename(file)==='index.html'){res.end(baseline);return;}
  const oldFile=baselineFiles[path.relative(root,file).replaceAll('\\','/')];if(oldFile){res.end(oldFile);return;}
  fs.createReadStream(file).pipe(res);
});
(async()=>{
await new Promise(r=>server.listen(8765,'127.0.0.1',r));
const browser=await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {channel:'chrome'}),headless:true});
const results=[];
for(const [label,url] of [['local','http://127.0.0.1:8765/'], ...(process.argv.includes('--live')?[['live','https://denisafanasjev.ru/']]:[])]){
for(const width of (process.argv.includes('--quick')?[]:process.argv.includes('--slow')?[390,390,390]:[390,1440])){
const context=await browser.newContext({viewport:{width,height:844},deviceScaleFactor:1});
const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
const network={bytes:0,requests:0,videoRequests:0};
const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');
cdp.on('Network.dataReceived',e=>network.bytes+=e.dataLength);
cdp.on('Network.requestWillBeSent',e=>{network.requests++;if(e.request.url.includes('.mp4'))network.videoRequests++;});
if(process.argv.includes('--slow')){
await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:150,downloadThroughput:200000,uploadThroughput:93750});
await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
}
await page.addInitScript(()=>{window.shifts=0; window.lcp=0;new PerformanceObserver(l=>l.getEntries().forEach(e=>{if(!e.hadRecentInput)window.shifts+=e.value})).observe({type:'layout-shift',buffered:true});new PerformanceObserver(l=>l.getEntries().forEach(e=>window.lcp=e.startTime)).observe({type:'largest-contentful-paint',buffered:true});});
try{
await page.goto(url,{waitUntil:process.argv.includes('--slow')?'domcontentloaded':'load',timeout:60000});await page.waitForTimeout(process.argv.includes('--slow')?12000:2500);
const stats=await page.evaluate(()=>({title:document.title,html:document.documentElement.outerHTML.length,lcp:window.lcp,cls:window.shifts,resources:performance.getEntriesByType('resource').map(r=>({url:r.name,bytes:r.transferSize,duration:r.duration})),videos:[...document.querySelectorAll('video')].map(v=>({src:v.currentSrc,width:v.videoWidth,height:v.videoHeight,playing:!v.paused})),overflow:document.documentElement.scrollWidth>innerWidth}));
await page.screenshot({path:path.join(resultDir,`${process.argv[2]||'before'}-${label}-${width}.png`)});
if(label==='live')fs.writeFileSync(path.join(resultDir,'live.html'),await (await context.request.get(url)).text());
results.push({label,width,errors,...stats,network:{...network}});
console.log(JSON.stringify({label,width,lcp:stats.lcp,cls:stats.cls,network}));
if(process.argv.includes('--checks')){
const v=page.locator('video').first();await v.scrollIntoViewIfNeeded();await page.waitForTimeout(1500);
const playing=await v.evaluate(v=>({playing:!v.paused,width:v.videoWidth,controls:v.controls,poster:!!v.poster}));
await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(300);
const paused=await v.evaluate(v=>v.paused);
await v.scrollIntoViewIfNeeded();await page.waitForTimeout(200);
await page.evaluate(()=>{Object.defineProperty(document,'hidden',{get:()=>true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
const hiddenPaused=await v.evaluate(v=>v.paused);
await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
await page.emulateMedia({reducedMotion:'reduce'});await v.scrollIntoViewIfNeeded();await page.waitForTimeout(300);
const reduced=await v.evaluate(v=>({paused:v.paused,controls:v.controls}));
await v.evaluate(v=>v.play());await page.waitForTimeout(150);const manual=await v.evaluate(v=>!v.paused);
await page.evaluate(()=>document.querySelectorAll('video').forEach(v=>v.pause()));
const carousels=await page.locator('.work-gallery--mobile-scroll').evaluateAll(els=>els.map(el=>({scroll:el.scrollWidth>el.clientWidth,items:el.children.length})));
const broken=await page.locator('img').evaluateAll(imgs=>imgs.filter(i=>i.complete&&!i.naturalWidth).map(i=>i.src));
results.at(-1).checks={playing,paused,hiddenPaused,reduced,manual,carousels,broken};
console.log('checks',JSON.stringify(results.at(-1).checks));
}
}catch(e){results.push({label,width,error:e.message});}await context.close();
}}
if(process.argv.includes('--checks')){
const extra={};
for(const mode of ['reduce','saveData','noObserver','noJS']){
const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:mode==='reduce'?'reduce':'no-preference',javaScriptEnabled:mode!=='noJS'});
if(mode==='saveData')await context.addInitScript(()=>Object.defineProperty(navigator.connection,'saveData',{value:true}));
if(mode==='noObserver')await context.addInitScript(()=>delete window.IntersectionObserver);
const page=await context.newPage();const requests=[];page.on('request',r=>requests.push(r.url()));await page.goto('http://127.0.0.1:8765/');
if(mode==='noJS'){extra[mode]={links:await page.locator('a[href$=".mp4"]').count()};}
else {
const v=page.locator('video').first();await v.scrollIntoViewIfNeeded();await page.waitForTimeout(300);
if(mode==='reduce')await page.screenshot({path:path.join(resultDir,'reduce.png')});
extra[mode]=await v.evaluate(v=>({paused:v.paused,controls:v.controls}));extra[mode].videoRequests=requests.filter(u=>u.includes('.mp4')).length;
const box=await v.boundingBox();await v.click({position:{x:22,y:box.height-50}});await page.waitForTimeout(1800);
extra[mode].manual=await v.evaluate(v=>!v.paused);
if(!extra[mode].manual)extra[mode].debug=await v.evaluate(v=>({loaded:v.dataset.loaded,src:v.currentSrc,ready:v.readyState,error:v.error?.message}));
}
await context.close();
}
for(const mode of ['pendingPlay','deniedPlay']){
const context=await browser.newContext({viewport:{width:390,height:844}});
const page=await context.newPage();
await page.addInitScript(mode=>{
    window.nativePlay=HTMLMediaElement.prototype.play;
    window.controlAdditions=0;
    new MutationObserver(records=>records.forEach(r=>{
        if(r.attributeName==='controls' && r.oldValue===null) window.controlAdditions++;
    })).observe(document,{subtree:true,attributes:true,attributeOldValue:true,attributeFilter:['controls']});
    HTMLMediaElement.prototype.play=function(){
        if(mode==='deniedPlay')return Promise.reject(new DOMException('Autoplay denied','NotAllowedError'));
        return new Promise((resolve,reject)=>{window.rejectPendingPlay=reject;});
    };
},mode);
await page.goto('http://127.0.0.1:8765/');
const v=page.locator('video').first();await v.scrollIntoViewIfNeeded();await page.waitForTimeout(350);
extra[mode]=await v.evaluate(v=>({controls:v.controls,poster:!!v.poster,additions:window.controlAdditions}));
const assert=require('assert/strict');
assert(extra[mode].poster);
if(mode==='pendingPlay'){
    assert(!extra[mode].controls);assert.equal(extra[mode].additions,0);
    await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(150);
    await page.evaluate(()=>window.rejectPendingPlay(new DOMException('Interrupted','AbortError')));
    await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.controlAdditions),0);
}else{
    assert(extra[mode].controls);
    await page.evaluate(()=>HTMLMediaElement.prototype.play=window.nativePlay);
    const box=await v.boundingBox();await v.click({position:{x:22,y:box.height-50}});await page.waitForTimeout(1800);
    extra[mode].manual=await v.evaluate(v=>!v.paused);assert(extra[mode].manual);
}
await context.close();
}
const context=await browser.newContext();const page=await context.newPage();
extra.widths=[];for(const width of [320,767,768,1024]){await page.setViewportSize({width,height:844});await page.goto('http://127.0.0.1:8765/');extra.widths.push({width,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});}
await context.close();results.push({extra});console.log('extra checks',JSON.stringify(extra));
const assert=require('assert/strict');
for(const r of results.filter(r=>r.checks)){assert(r.checks.playing.playing);assert(r.checks.paused);assert(r.checks.hiddenPaused);assert(r.checks.reduced.paused&&r.checks.reduced.controls);assert(r.checks.manual);assert.equal(r.checks.broken.length,0);assert(!r.overflow);}
for(const mode of ['reduce','saveData','noObserver']){assert(extra[mode].paused&&extra[mode].controls);assert.equal(extra[mode].videoRequests,0);assert(extra[mode].manual);}
assert.equal(extra.noJS.links,16);assert(extra.widths.every(w=>!w.overflow));
}
fs.writeFileSync(path.join(resultDir,`${process.argv[2]||'before'}.json`),JSON.stringify(results,null,2));
console.log(results.map(r=>({label:r.label,width:r.width,lcp:r.lcp,cls:r.cls,requests:r.resources?.length,bytes:r.resources?.reduce((a,b)=>a+b.bytes,0),playing:r.videos?.filter(v=>v.playing).length,error:r.error,overflow:r.overflow})));
await browser.close();server.close();
})().catch(error => { console.error(error); process.exit(1); });
