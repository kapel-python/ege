(function(){
/* ============================================================
   Окно «Цель достигнута» — поздравление с достижением цели прогноза.
   Смотрит ТОЛЬКО на клиентский прогноз дашборда (forecast().mid из
   js/state.js, не серверный): как только mid впервые достигнет цель
   пользователя (число из его goal_id: g60/g80/g95...), окно показывается
   один раз для этой цели — на любом экране SPA (оверлей на body, поверх
   всех окон сайта). Гарантия доставки: флаг «уже поздравили» ставится
   только после фактического показа окна, а триггер смотрит и на пик
   истории — поэтому даже вышедший из браузера (или просевший после
   взятия цели прогноз) всё равно получит поздравление при следующем
   визите. Проверка — опросом каждые 5 с + отложенная проверка
   после загрузки (событийного хука у прогноза нет: снапшоты пишутся из
   нескольких мест state.js, опрос покрывает их все с задержкой ≤5 с).
   Флаг «уже поздравили» — localStorage, ключ на (предмет, goal_id):
   смена цели вверх даёт новое поздравление, повторного спама нет.
   Первый экран закрыть/пропустить нельзя (кнопки появляются только после
   анимации, Esc/фон/крестик окно не закрывают — так задумано).
   Данные собирает collectGoalCelebrationData() из Store/DataAPI/forecast:
   history — ВЕСЬ forecastHistory (не окно 14 дней), уроки — completedLessons
   против DataAPI.lessons(), avg — totalTimeSec/уроки («в среднем на урок»).
   Ручной вызов: openGoalCelebration({goal, history, topicsDone, ...}).
   ============================================================ */

var COPY={sub:'Прогноз вышел на целевой уровень — это стоит отметить.',live:'Цель достигнута: ',
  wish:'<strong class="gc-g">Удачи на ЕГЭ!</strong><span class="st">Ты проделал большую работу. Теперь главное — спокойствие и уверенность. Всё получится.</span>'};

var $=function(i){try{return (typeof document!=='undefined'&&document)?document.getElementById(i):null}catch(e){return null}};
var RM=(typeof matchMedia!=='undefined')?matchMedia('(prefers-reduced-motion: reduce)').matches:false;
var root=(typeof document!=='undefined'&&document)?document.documentElement:null;

var ov=null,card=null,s1=null,s2=null,sc=null,cv=null,gcBuilt=false;
var GcTemplate=`<div class="gc-ov" id="gc-ov" role="dialog" aria-modal="true" aria-labelledby="gc-h1" hidden>
  <div class="gc-sr" id="gc-live" aria-live="polite"></div>
  <div class="gc-card" id="gc-card" tabindex="-1">

    <section class="gc-s1" id="gc-s1">
      <div class="gc-hero1" id="gc-hero1">
        <i class="gc-flash"></i>
        <svg class="gc-ring" viewBox="0 0 132 132"><defs><linearGradient id="gc-rg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="132" y2="132"><stop offset="0" style="stop-color:var(--accent)"/><stop offset="1" style="stop-color:var(--violet)"/></linearGradient></defs>
          <circle class="gc-rt" cx="66" cy="66" r="58"/><circle class="gc-rp" id="gc-rp" pathLength="1" cx="66" cy="66" r="58"/></svg>
        <b class="gc-g gc-hn" id="gc-hn">0</b>
        <span class="gc-ok"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
      </div>
      <h2 class="gc-t1" id="gc-h1"></h2>
      <p class="gc-sub" id="gc-sub"></p>
      <div class="gc-acts" id="gc-acts1">
        <button class="gc-btn gc-pri gc-lg" id="gc-goP">Посмотреть прогресс</button>
        <button class="gc-btn gc-ghost gc-lg" id="gc-cls1">Закрыть</button>
      </div>
    </section>

    <section class="gc-s2" id="gc-s2" hidden>
      <div class="gc-scroll" id="gc-scroll">
        <div class="gc-eyebrow gc-rise" id="gc-e1">Твой путь</div>
        <h3 class="gc-t2" id="gc-h2"></h3>

        <div class="gc-blk gc-rise" id="gc-bChart">
          <div class="gc-hero"><b class="gc-g gc-big" id="gc-days">0</b><span id="gc-daysL"></span></div>
          <div id="gc-chart"></div>
        </div>

        <div class="gc-tiles gc-rise" id="gc-bTiles">
          <div class="gc-tile"><div class="gc-v"><span id="gc-vTop">0</span> <small id="gc-vTopT"></small></div><div class="gc-l">уроков пройдено</div><div class="gc-seg" id="gc-seg"></div></div>
          <div class="gc-tile"><div class="gc-v"><span id="gc-vAvg">0</span> <small id="gc-vAvgU"></small></div><div class="gc-l" id="gc-lAvg"></div>
            <svg class="gc-ring2" viewBox="0 0 38 38"><circle class="gc-t" cx="19" cy="19" r="15"/><circle class="gc-p" pathLength="1" cx="19" cy="19" r="15"/><path class="gc-h" d="M19 11v8l5 3"/></svg></div>
          <div class="gc-tile"><div class="gc-v">+<span id="gc-vGain">0</span></div><div class="gc-l" id="gc-lGain"></div><div class="gc-trk"><b></b></div></div>
        </div>

        <div class="gc-tiles gc-rise" id="gc-bT2">
          <div class="gc-tile" id="gc-tBest"><div class="gc-v">+<span id="gc-vBest">0</span></div><div class="gc-l" id="gc-lBest"></div>
            <svg class="gc-spark" viewBox="0 0 60 20"><path pathLength="1" d="M2 17C14 17 16 9 28 10S44 3 58 3"/></svg></div>
          <div class="gc-tile" id="gc-tStr"><div class="gc-v"><span id="gc-vStr">0</span></div><div class="gc-l">дней подряд</div>
            <svg class="gc-fl" id="gc-flame" viewBox="0 0 24 24"><path d="M12 2c1 4 5 5.5 5 11a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4-1-6 1-10z"/></svg></div>
        </div>

        <div class="gc-blk gc-rise" id="gc-bAct">
          <div class="gc-eyebrow">Активность</div>
          <div class="gc-hero" style="margin-top:12px"><b class="gc-g gc-mid" id="gc-vAct">0</b><span id="gc-lAct"></span></div>
          <div class="gc-cal" id="gc-cal"></div>
        </div>

        <div class="gc-blk gc-rise" id="gc-bAch">
          <div class="gc-eyebrow">Достижения</div>
          <div class="gc-ach" id="gc-ach"></div>
        </div>

        <div class="gc-wish gc-rise" id="gc-bWish"><p class="gc-t3" id="gc-wishT"></p></div>

        <div class="gc-acts" id="gc-acts2"><button class="gc-btn gc-pri gc-lg" id="gc-done">Закрыть</button></div>
      </div>
      <div class="gc-skip" id="gc-skip" aria-hidden="true">Нажми на экран, чтобы ускорить</div>
    </section>
  </div>
  <canvas id="gc-fx" aria-hidden="true"></canvas>
</div>

`;

function buildDOM(){
  if(gcBuilt&&ov&&card)return true;
  if(typeof document==='undefined'||!document||!document.body)return false;
  try{
    if(!$('gc-ov'))document.body.insertAdjacentHTML('beforeend',GcTemplate);
    ov=$('gc-ov');card=$('gc-card');s1=$('gc-s1');s2=$('gc-s2');sc=$('gc-scroll');cv=$('gc-fx');
    root=document.documentElement;
    if(!ov||!card||!s1||!s2||!sc)return false;
    if(!gcBuilt){
      $('gc-cls1').onclick=close;$('gc-done').onclick=close;
      card.addEventListener('click',function(e){if(skipOn&&!e.target.closest('button'))skipClick()});
      ['wheel','touchstart'].forEach(function(e){sc.addEventListener(e,function(){userScrolled=true},{passive:true})});
      document.addEventListener('keydown',gcKeys);
      if(typeof addEventListener!=='undefined'){
        addEventListener('resize',fit);
        if(typeof window!=='undefined'&&window.visualViewport)window.visualViewport.addEventListener('resize',fit);
      }
      gcBuilt=true;
    }
    return true;
  }catch(e){return false}
}

function gcKeys(e){
  if(!ov||ov.hidden)return;
  if(e.key==='Tab'){var f=Array.prototype.filter.call(card.querySelectorAll('button'),function(b){return !b.disabled&&b.offsetParent!==null&&getComputedStyle(b.closest('.gc-acts')||b).visibility!=='hidden'});
    if(!f.length){e.preventDefault();card.focus();return}
    var a=document.activeElement,i=f.indexOf(a);
    if(e.shiftKey&&(i<=0)){e.preventDefault();f[f.length-1].focus()}else if(!e.shiftKey&&(i===-1||i===f.length-1)){e.preventDefault();f[0].focus()}}
  else if(e.key==='ArrowDown'||e.key==='PageDown'||e.key===' '||e.key==='ArrowUp'||e.key==='PageUp')userScrolled=true}
var dead=true,timers=[],pend=[],raf=0,userScrolled=false,lastFocus=null,onCloseCb=null,prevOverflow='',skipOn=false,skipTick=0;

function wait(ms){return new Promise(function(r){var id=setTimeout(r,RM?Math.min(ms,30):ms);timers.push(id);pend.push(function(){clearTimeout(id);r()})})}
function plural(n,f){var a=Math.abs(n)%100,b=a%10;return a>10&&a<20?f[2]:b>1&&b<5?f[1]:b===1?f[0]:f[2]}
function vh(){try{if(typeof window!=='undefined'&&window.visualViewport)return window.visualViewport.height;if(typeof innerHeight!=='undefined')return innerHeight;}catch(e){}return 800}
function fit(){ov.style.setProperty('--vh',vh()+'px');if(!ov.hidden&&!s2.hidden)card.style.height=Math.min(660,vh()-32)+'px'}

/* мгновенно доигрывает все конечные анимации/переходы внутри окна */
function ff(){if(!card.getAnimations)return;void card.offsetWidth;
  card.getAnimations({subtree:true}).forEach(function(a){try{var t=a.effect&&a.effect.getComputedTiming();if(t&&t.iterations!==Infinity)a.finish()}catch(e){}})}
function skipClick(){skipTick++;pend.splice(0).forEach(function(f){f()});ff()}

/* печать по словам */
function prep(el){var out=[];(function walk(n){Array.prototype.slice.call(n.childNodes).forEach(function(c){
  if(c.nodeType===3){var f=document.createDocumentFragment();c.textContent.split(/(\s+)/).forEach(function(s){
    if(!s)return;if(/^\s+$/.test(s)){f.append(s)}else{var w=document.createElement('span');w.className='gc-ww';w.textContent=s;out.push(w);f.append(w)}});c.replaceWith(f)}
  else if(c.classList&&(c.classList.contains('gc-g')||c.classList.contains('gc-ww'))){c.classList.add('gc-ww');out.push(c)}
  else walk(c)})})(el);return out}
function arm(el){el._w=prep(el)}
async function type(el){var ws=el._w||prep(el),step=Math.min(45,Math.max(24,900/Math.max(ws.length,1))),tk=skipTick;
  for(var i=0;i<ws.length;i++){if(dead)return;
    if(skipTick!==tk){for(;i<ws.length;i++)ws[i].classList.add('gc-is-in');ff();return}
    ws[i].classList.add('gc-is-in');await wait(step)}
  if(skipTick===tk)await wait(260)}

function follow(el){if(userScrolled||dead)return;sc.scrollTo({top:Math.max(0,el.offsetTop+el.offsetHeight-sc.clientHeight+20),behavior:RM?'auto':'smooth'})}
async function reveal(el){el.classList.add('gc-is-in');follow(el);await wait(380)}
function count(el,to,dur){var t0=performance.now(),tk=skipTick;if(RM){el.textContent=to;return}
  (function f(n){var k=Math.min(1,(n-t0)/(dur||1000));if(skipTick!==tk)k=1;el.textContent=Math.round(to*(1-Math.pow(1-k,3)));if(k<1&&!dead)requestAnimationFrame(f)})(t0)}

/* герой: число набирается, кольцо замыкается */
function heroCount(goal,dur){return new Promise(function(res){
  var hn=$('gc-hn'),rp=$('gc-rp');if(RM){hn.textContent=goal;rp.style.strokeDashoffset=0;return res()}
  var t0=performance.now();(function f(n){if(dead)return res();var k=Math.min(1,(n-t0)/dur),e=1-Math.pow(1-k,3);
    hn.textContent=Math.round(goal*e);rp.style.strokeDashoffset=1-e;if(k<1)requestAnimationFrame(f);else res()})(t0)})}
function chime(){try{var AC=(typeof window!=='undefined')?(window.AudioContext||window.webkitAudioContext):null;if(!AC)return;var A=new AC(),t=A.currentTime;if(A.resume)A.resume();
  [660,880,1320].forEach(function(fr,i){var o=A.createOscillator(),g=A.createGain(),s=t+i*.09;o.type='sine';o.frequency.value=fr;
    g.gain.setValueAtTime(0,s);g.gain.linearRampToValueAtTime(.06,s+.02);g.gain.exponentialRampToValueAtTime(.0001,s+.9);
    o.connect(g);g.connect(A.destination);o.start(s);o.stop(s+1)})}catch(e){}}

/* фейерверки */
function fireworks(){return new Promise(function(res){
  if(RM)return res();
  if(!cv||!cv.getContext)return res();var x=cv.getContext('2d');if(!x)return res();var dpr=(typeof devicePixelRatio!=='undefined')?devicePixelRatio:1,W=(typeof innerWidth!=='undefined')?innerWidth:800,H=(typeof innerHeight!=='undefined')?innerHeight:600;cv.width=W*dpr;cv.height=H*dpr;x.setTransform(dpr,0,0,dpr,0,0);
  var cs=getComputedStyle(root),cols=['--accent','--violet','--success'].map(function(v){return cs.getPropertyValue(v).trim()});
  var R=[],P=[],n=0,N=6,t0=performance.now(),last=t0,next=0;
  function launch(){var tx=W*(.15+Math.random()*.7);R.push({sx:tx+(Math.random()-.5)*80,tx:tx,ty:H*(.12+Math.random()*.32),t:0,c:cols[n%3]});n++}
  function boom(r){for(var i=0;i<60;i++){var a=i/60*Math.PI*2+Math.random()*.2,s=1.6+Math.random()*3.4;
    P.push({x:r.tx,y:r.ty,px:r.tx,py:r.ty,vx:Math.cos(a)*s,vy:Math.sin(a)*s,age:0,life:900+Math.random()*700,c:i%5===0?cols[(n+1)%3]:r.c})}}
  (function frame(now){
    if(dead){x.clearRect(0,0,W,H);return res()}
    var dt=Math.min(now-last,40),k=dt/16.6;last=now;x.clearRect(0,0,W,H);
    if(n<N&&now-t0>=next){launch();next+=380}
    x.lineCap='round';x.lineWidth=2;
    R=R.filter(function(r){r.t+=dt;var e=Math.min(1,r.t/650),y=H+(r.ty-H)*(1-Math.pow(1-e,3)),px=r.sx+(r.tx-r.sx)*e;
      x.globalAlpha=.8;x.strokeStyle=r.c;x.beginPath();x.moveTo(px-(r.tx-r.sx)*.04,y+22);x.lineTo(px,y);x.stroke();
      if(e>=1){boom(r);return false}return true});
    P=P.filter(function(p){p.age+=dt;if(p.age>p.life)return false;p.px=p.x;p.py=p.y;p.vx*=Math.pow(.985,k);p.vy=p.vy*Math.pow(.985,k)+.045*k;p.x+=p.vx*k;p.y+=p.vy*k;
      x.globalAlpha=1-p.age/p.life;x.strokeStyle=p.c;x.beginPath();x.moveTo(p.px,p.py);x.lineTo(p.x,p.y);x.stroke();return true});
    if(n<N||R.length||P.length)raf=requestAnimationFrame(frame);else{x.clearRect(0,0,W,H);res()}
  })(t0)})}

/* график: всегда 4 отметки, независимо от длительности */
function chart(d){
  var pts=d.history.map(function(p){return{t:+new Date(p.t),s:p.score}}).sort(function(a,b){return a.t-b.t});
  if(pts.length<2)pts=[pts[0],{t:pts[0].t+864e5,s:pts[0].s}];
  var t0=pts[0].t,t1=pts[pts.length-1].t,span=Math.max(1,Math.round((t1-t0)/864e5));
  function at(f){var T=t0+f*(t1-t0),i=1;while(i<pts.length-1&&pts[i].t<T)i++;var a=pts[i-1],b=pts[i];return b.t===a.t?b.s:a.s+(b.s-a.s)*Math.min(1,Math.max(0,(T-a.t)/(b.t-a.t)))}
  var F=[0,1/3,2/3,1],S=F.map(function(f){return Math.round(at(f))});
  var all=S.concat([d.goal]),lo=Math.min.apply(0,all)-6,hi=Math.max.apply(0,all)+6;
  var X=function(f){return 30+420*f},Y=function(v){return 40+(hi-v)/(hi-lo)*118},B=168;
  var path='M'+X(0)+' '+Y(S[0]);
  for(var i=1;i<4;i++){var m=(X(F[i-1])+X(F[i]))/2;path+=' C'+m+' '+Y(S[i-1])+' '+m+' '+Y(S[i])+' '+X(F[i])+' '+Y(S[i])}
  var L=['Старт','День '+Math.round(span/3),'День '+Math.round(span*2/3),'День '+span],A=['start','middle','middle','end'];
  var h='<svg viewBox="0 0 480 196" role="img" aria-label="График прогноза: 4 отметки от старта до цели">'+
   '<defs><linearGradient id="gc-gg" gradientUnits="userSpaceOnUse" x1="30" y1="0" x2="450" y2="0"><stop offset="0" style="stop-color:var(--accent)"/><stop offset="1" style="stop-color:var(--violet)"/></linearGradient>'+
   '<linearGradient id="gc-ga" gradientUnits="userSpaceOnUse" x1="0" y1="30" x2="0" y2="'+B+'"><stop offset="0" style="stop-color:var(--accent);stop-opacity:.22"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/></linearGradient></defs>'+
   '<line class="gc-ax" x1="30" x2="450" y1="'+B+'" y2="'+B+'"/>'+
   '<line class="gc-gl" x1="30" x2="450" y1="'+Y(d.goal)+'" y2="'+Y(d.goal)+'"/><text class="gc-glt" x="450" y="'+(Y(d.goal)-8)+'" text-anchor="end">цель '+d.goal+'</text>'+
   '<path class="gc-ar" d="'+path+' L450 '+B+' L30 '+B+' Z"/><path class="gc-cv" pathLength="1" d="'+path+'"/>';
  for(var j=0;j<4;j++){var dl=(.3+F[j]*1.6).toFixed(2)+'s',cx=X(F[j]),cy=Y(S[j]),end=j===3;
    h+='<g style="--d:'+dl+'"><line class="gc-vg" x1="'+cx+'" x2="'+cx+'" y1="'+(cy+8)+'" y2="'+B+'"/>'+
      (end?'<circle class="gc-halo" cx="'+cx+'" cy="'+cy+'" r="11"/>':'')+
      '<circle class="gc-dot'+(end?' gc-end':'')+'" cx="'+cx+'" cy="'+cy+'" r="'+(end?7:5.5)+'"/>'+
      '<text class="gc-sc" x="'+cx+'" y="'+(cy-14)+'" text-anchor="'+A[j]+'">'+S[j]+'</text>'+
      '<text class="gc-dl" x="'+cx+'" y="188" text-anchor="'+A[j]+'">'+L[j]+'</text></g>'}
  var w=Math.min(7,span),bg=0,bd=0;for(var k=0;k+w<=span;k++){var g=at((k+w)/span)-at(k/span);if(g>bg){bg=g;bd=k}}
  return{html:h+'</svg>',days:span,t0:t0,gain:S[3]-S[0],from:S[0],to:S[3],best:{gain:Math.round(bg),a:bd,b:bd+w}}}

/* календарь активности: ячеек не больше 42 при любой длительности */
function calendar(act,t0,span){
  var days=span+1,n=Math.min(42,days),arr=[],map={},i;
  act.forEach(function(a){var s=typeof a==='string',k=Math.floor((+new Date(s?a:a.t)-t0)/864e5);if(k>=0&&k<=span)map[k]=(map[k]||0)+(s?1:(a.value||1))});
  for(i=0;i<n;i++)arr.push(0);
  Object.keys(map).forEach(function(k){arr[Math.min(n-1,Math.floor(k/days*n))]+=map[k]});
  var mx=Math.max.apply(0,arr)||1;
  return{n:n,active:Object.keys(map).length,days:days,lv:arr.map(function(v){var r=v/mx;return v?(r>.66?3:r>.33?2:1):0})}}

var STAR='<svg viewBox="0 0 24 24"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"/></svg>';

/* ===== сценарий ===== */
async function stage1(d){
  await wait(380);s1.classList.add('gc-run');
  await heroCount(d.goal,1900);if(dead)return;
  s1.classList.add('gc-land');
  if(!RM&&typeof navigator!=='undefined'&&navigator.vibrate){try{navigator.vibrate([15,40,15])}catch(e){}}
  if(d.sound&&!RM)chime();
  var fw=fireworks();
  await wait(250);await type($('gc-h1'));await wait(120);await type($('gc-sub'));
  await fw;await wait(200);if(dead)return;
  $('gc-acts1').classList.add('gc-is-ready');$('gc-goP').focus({preventScroll:true})}

async function stage2(d){
  var c=chart(d);
  $('gc-goP').disabled=$('gc-cls1').disabled=true;s1.classList.add('gc-out');await wait(300);if(dead)return;
  card.style.height=card.offsetHeight+'px';s1.hidden=true;s2.hidden=false;card.offsetWidth;
  card.style.height=Math.min(660,vh()-32)+'px';card.focus({preventScroll:true});await wait(600);if(dead)return;

  $('gc-chart').innerHTML=c.html;$('gc-daysL').textContent=plural(c.days,['день','дня','дней'])+' в пути';
  var tot=d.topicsTotal||d.topicsDone,on=Math.round(d.topicsDone/tot*12),sg='';
  for(var i=0;i<12;i++)sg+='<i style="--i:'+i+'"'+(i<on?' class="gc-on"':'')+'></i>';
  $('gc-seg').innerHTML=sg;$('gc-vTopT').textContent=d.topicsTotal?'/ '+d.topicsTotal:'';
  $('gc-vAvgU').textContent=d.avg.unit;$('gc-lAvg').textContent=d.avg.label;
  $('gc-lGain').textContent=c.from+' → '+c.to+' '+plural(c.gain,['балл','балла','баллов']);

  var hasBest=c.best.gain>0,hasStr=d.streak>0;
  $('gc-tBest').hidden=!hasBest;$('gc-tStr').hidden=!hasStr;$('gc-bT2').hidden=!(hasBest||hasStr);
  $('gc-lBest').textContent='лучшая неделя · дни '+c.best.a+'–'+c.best.b;
  $('gc-flame').setAttribute('class','gc-fl '+(d.streak>30?'gc-lv3':d.streak>6?'gc-lv2':'gc-lv1'));
  var cal=d.activity&&d.activity.length?calendar(d.activity,c.t0,c.days-0>0?Math.round(c.days):1):null;
  $('gc-bAct').hidden=!cal;
  if(cal){var ch='';cal.lv.forEach(function(l,i){ch+='<i class="'+(l?'gc-l'+l:'')+'" style="--i:'+i+'"></i>'});
    $('gc-cal').innerHTML=ch;$('gc-cal').style.setProperty('--st',(1.2/cal.n).toFixed(3)+'s');
    $('gc-lAct').textContent='из '+cal.days+' '+plural(cal.days,['дня','дней','дней'])+' ты занимался'}
  var ac=(d.achievements||[]).slice(0,4);$('gc-bAch').hidden=!ac.length;
  $('gc-ach').innerHTML=ac.map(function(a,i){return '<div style="--i:'+i+'"><b>'+STAR+'</b>'+(a.title||a)+'</div>'}).join('');

  skipOn=true;$('gc-skip').classList.add('gc-on');
  await reveal($('gc-e1'));await type($('gc-h2'));if(dead)return;
  await reveal($('gc-bChart'));$('gc-bChart').classList.add('gc-run');count($('gc-days'),c.days,1400);await wait(2500);if(dead)return;
  await reveal($('gc-bTiles'));$('gc-bTiles').classList.add('gc-run');
  count($('gc-vTop'),d.topicsDone,1100);count($('gc-vAvg'),d.avg.value,1100);count($('gc-vGain'),c.gain,1100);await wait(1600);if(dead)return;
  if(!$('gc-bT2').hidden){await reveal($('gc-bT2'));$('gc-bT2').classList.add('gc-run');count($('gc-vBest'),c.best.gain,1000);count($('gc-vStr'),d.streak||0,1000);await wait(1400);if(dead)return}
  if(!$('gc-bAct').hidden){await reveal($('gc-bAct'));$('gc-bAct').classList.add('gc-run');count($('gc-vAct'),cal.active,1200);await wait(2000);if(dead)return}
  if(!$('gc-bAch').hidden){await reveal($('gc-bAch'));$('gc-bAch').classList.add('gc-run');await wait(1400);if(dead)return}
  await reveal($('gc-bWish'));await type($('gc-wishT'));await wait(250);if(dead)return;
  skipOn=false;$('gc-skip').classList.remove('gc-on');
  $('gc-acts2').classList.add('gc-is-ready');follow($('gc-acts2'));$('gc-done').focus({preventScroll:true})}

function close(){
  dead=true;skipOn=false;timers.forEach(clearTimeout);timers=[];pend=[];if(typeof cancelAnimationFrame!=='undefined'){try{cancelAnimationFrame(raf)}catch(e){}}
  ov.hidden=true;root.style.overflow=prevOverflow;if(lastFocus&&lastFocus.focus)lastFocus.focus();
  if(onCloseCb)onCloseCb()}

function normalizeCelebration(input){
  var d=input||{};
  var goal=Number(d.goal);if(!Number.isFinite(goal))return null;
  var src=d.history||[],hist=[];
  for(var i=0;i<src.length;i++){var p=src[i];if(!p)continue;var s=Number(p.score);
    if(p.t&&Number.isFinite(s))hist.push({t:String(p.t),score:s})}
  if(!hist.length)return null;
  var done=Math.max(0,Math.floor(Number(d.topicsDone)||0));
  var tot=(d.topicsTotal==null||d.topicsTotal==='')?null:Math.max(0,Math.floor(Number(d.topicsTotal)||0));
  var av=d.avg||{},avv=Number(av.value);if(!Number.isFinite(avv))avv=0;
  var out={goal:goal,history:hist,topicsDone:done,
    avg:{value:avv,unit:String(av.unit||''),label:String(av.label||'')}};
  if(tot)out.topicsTotal=tot;
  var st=Number(d.streak);out.streak=(Number.isFinite(st)&&st>0)?Math.floor(st):0;
  if(d.activity&&d.activity.length)out.activity=d.activity;
  if(d.achievements&&d.achievements.length)out.achievements=d.achievements.slice(0,8);
  out.sound=d.sound===true;
  out.onClose=(typeof d.onClose==='function')?d.onClose:null;
  return out;
}

var GcGlobal=(typeof globalThis!=='undefined')?globalThis:((typeof window!=='undefined')?window:{});
GcGlobal.openGoalCelebration=function(data){
  var d=normalizeCelebration(data);if(!d)return false;
  if(!buildDOM())return false;
  if(!ov.hidden)return false;
  dead=false;userScrolled=false;skipOn=false;pend=[];onCloseCb=d.onClose||null;lastFocus=document.activeElement;
  prevOverflow=root.style.overflow;root.style.overflow='hidden';
  card.style.height='';s1.hidden=false;s1.className='gc-s1';s2.hidden=true;sc.scrollTop=0;$('gc-skip').classList.remove('gc-on');
  Array.prototype.forEach.call(ov.querySelectorAll('.gc-is-in,.gc-is-ready,.gc-run'),function(e){e.classList.remove('gc-is-in','gc-is-ready','gc-run')});
  $('gc-hn').textContent='0';$('gc-rp').style.strokeDashoffset=1;
  fit();
  $('gc-h1').innerHTML='Твоя цель <b class="gc-g">'+d.goal+'</b> '+plural(d.goal,['балл','балла','баллов'])+' достигнута!';
  $('gc-sub').textContent=COPY.sub;$('gc-live').textContent=COPY.live+d.goal;
  $('gc-h2').textContent='Вот как ты к этому шёл';$('gc-wishT').innerHTML=COPY.wish;
  [$('gc-h1'),$('gc-sub'),$('gc-h2'),$('gc-wishT')].forEach(arm);
  $('gc-goP').disabled=$('gc-cls1').disabled=false;
  ov.hidden=false;card.focus({preventScroll:true});
  stage1(d);
  $('gc-goP').onclick=function(){stage2(d)};
  return true;
};

/* закрыть можно только кнопками после анимации; Esc, фон и крестик не закрывают.
   Обработчики вешаются один раз в buildDOM (см. gcKeys выше). */



/* ===== данные из Store/DataAPI/прогноза дашборда ===== */
function gcGoalNum(){
  try{
    if(typeof DataAPI==='undefined'||typeof Store==='undefined'||!Store.state)return null;
    var gid=Store.state.goal;if(!gid)return null;
    var goals=(DataAPI.goals&&typeof DataAPI.goals==='function')?DataAPI.goals():[];
    var g=null;
    for(var i=0;i<goals.length;i++){if(goals[i]&&String(goals[i].id)===String(gid)){g=goals[i];break}}
    if(!g)return null;
    var dm=String(g.desc||'').match(/(\d+)\s*\+/);if(dm)return Number(dm[1]);
    var lm=String(g.label||'').match(/\d+/);if(lm)return Number(lm[0]);
    return null;
  }catch(e){return null}
}
function gcToday(){
  try{if(typeof todayStr==='function'){var s=todayStr();if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s}}catch(e){}
  return new Date().toISOString().slice(0,10);
}
function collectGoalCelebrationData(){
  try{
    if(typeof Store==='undefined'||!Store.state)return null;
    if(typeof DataAPI==='undefined')return null;
    var subject='profile_math';
    try{if(typeof currentSubjectId==='function')subject=String(currentSubjectId()||subject)}catch(e){}
    try{if(DataAPI.isSubjectAvailable&&typeof DataAPI.isSubjectAvailable==='function'&&!DataAPI.isSubjectAvailable())return null}catch(e){return null}
    var gid=Store.state.goal;if(!gid)return null;
    var goal=gcGoalNum();if(!Number.isFinite(goal))return null;
    var f=null;
    try{if(typeof forecast==='function')f=forecast()}catch(e){f=null}
    if(!f||f.empty||!Number.isFinite(f.mid))return null;
    var raw=Array.isArray(Store.state.forecastHistory)?Store.state.forecastHistory:[],hist=[];
    for(var i=0;i<raw.length;i++){var x=raw[i];
      if(x&&/^\d{4}-\d{2}-\d{2}$/.test(x.date||'')&&Number.isFinite(x.mid))hist.push({t:x.date,score:x.mid})}
    hist.sort(function(a,b){return a.t<b.t?-1:(a.t>b.t?1:0)});
    if(!hist.length)hist.push({t:gcToday(),score:f.mid});
    var lessons=[];
    try{lessons=(DataAPI.lessons&&typeof DataAPI.lessons==='function')?DataAPI.lessons():[];if(!Array.isArray(lessons))lessons=[]}catch(e){lessons=[]}
    var done=0;
    try{var cl=Store.state.completedLessons||{};
      for(var j=0;j<lessons.length;j++){if(lessons[j]&&lessons[j].id&&cl[lessons[j].id])done++}}catch(e){}
    var totalMin=0;
    try{totalMin=Math.max(0,Math.round((Number(Store.state.totalTimeSec)||0)/60))}catch(e){}
    var avgV=done>0?Math.max(1,Math.round(totalMin/Math.max(1,done))):totalMin;
    var activity=[];
    try{var act=Store.state.activity||{};
      for(var k in act){if(!Object.prototype.hasOwnProperty.call(act,k))continue;
        if(!/^\d{4}-\d{2}-\d{2}$/.test(k))continue;
        var n=Number(act[k]&&(act[k].solved||0))||0;
        if(n>0)activity.push({t:k,value:n})}}catch(e){}
    var achNames=[];
    try{var unlocked=Store.state.achievements||{};
      var ids=Object.keys(unlocked).sort(function(a,b){return ((unlocked[a]&&unlocked[a].ts)||0)-((unlocked[b]&&unlocked[b].ts)||0)});
      var catalog=(DataAPI.achievements&&typeof DataAPI.achievements==='function')?DataAPI.achievements():[];
      var byId={};
      for(var q=0;q<catalog.length;q++){if(catalog[q]&&catalog[q].id)byId[String(catalog[q].id)]=catalog[q]}
      for(var r=0;r<ids.length;r++){var c=byId[String(ids[r])];if(c&&c.name)achNames.push(String(c.name))}}catch(e){}
    var streak=0;
    try{streak=Math.max(0,Math.floor(Number(Store.state.streak)||0))}catch(e){}
    var data={goal:goal,history:hist,topicsDone:done,
      avg:{value:avgV,unit:'мин',label:'в среднем на урок'},sound:false,onClose:null};
    if(lessons.length)data.topicsTotal=lessons.length;
    if(streak>0)data.streak=streak;
    if(activity.length)data.activity=activity;
    if(achNames.length)data.achievements=achNames;
    var peak=f.mid;
    for(var pi=0;pi<hist.length;pi++){if(hist[pi].score>peak)peak=hist[pi].score}
    return {subject:subject,goalId:String(gid),goal:goal,current:f.mid,peak:peak,data:data};
  }catch(e){return null}
}

/* ===== флаг «уже поздравили» + проверка ===== */
var gcMemFlags={};
function gcFlagStorage(){
  try{if(typeof localStorage!=='undefined'&&localStorage&&typeof localStorage.getItem==='function')return localStorage}catch(e){}
  return null;
}
function gcFlagKey(subject,goalId){return 'ege_goal_celebrated_v1:'+String(subject)+':'+String(goalId)}
function gcFlagGet(key){
  var s=gcFlagStorage();
  try{if(s)return s.getItem(key)==='1'}catch(e){}
  return !!gcMemFlags[key];
}
function gcFlagSet(key){
  var s=gcFlagStorage();
  try{if(s){s.setItem(key,'1');return}}catch(e){}
  gcMemFlags[key]=true;
}
function gcIsOpen(){try{return !!(ov&&!ov.hidden)}catch(e){return false}}
function maybeCelebrateGoal(){
  try{
    if(typeof document!=='undefined'&&document&&document.hidden)return false;
    if(gcIsOpen())return false;
    var c=collectGoalCelebrationData();if(!c)return false;
    /* Гарантия доставки: флаг ставится только после реального показа окна.
       Поэтому хватает и просевшего прогноза: раз пик истории брал цель,
       а поздравления не было — показать сейчас, даже если текущий mid ниже. */
    if(!(c.current>=c.goal||c.peak>=c.goal))return false;
    var key=gcFlagKey(c.subject,c.goalId);
    if(gcFlagGet(key))return false;
    var ok=false;
    try{ok=openGoalCelebration(c.data)===true}catch(e){ok=false}
    if(ok){try{gcFlagSet(key)}catch(e){}}
    return ok;
  }catch(e){return false}
}
function gcBootTick(){try{maybeCelebrateGoal()}catch(e){}}

/* ===== автозапуск: отложенная проверка + опрос каждые 5 с ===== */
try{
  if(typeof document!=='undefined'&&document&&typeof window!=='undefined'){
    if(document.readyState==='loading'&&typeof document.addEventListener==='function'){
      document.addEventListener('DOMContentLoaded',function(){try{setTimeout(gcBootTick,2000)}catch(e){}});
    }else{try{setTimeout(gcBootTick,2000)}catch(e){}}
    if(typeof setInterval!=='undefined'){try{setInterval(gcBootTick,5000)}catch(e){}}
  }
}catch(e){}

try{
  GcGlobal.collectGoalCelebrationData=collectGoalCelebrationData;
  GcGlobal.maybeCelebrateGoal=maybeCelebrateGoal;
  GcGlobal.__goalCelebration={goalNum:gcGoalNum,normalize:normalizeCelebration,
    flagKey:gcFlagKey,flagGet:gcFlagGet,flagSet:gcFlagSet,isOpen:gcIsOpen};
}catch(e){}


})();
