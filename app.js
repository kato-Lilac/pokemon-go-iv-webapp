const $=id=>document.getElementById(id);
const app={items:[],pvp:null,names:null,rankCache:new Map(),worker:null};

const CPMS=[.094,.135137432,.16639787,.192650919,.21573247,.236572661,.25572005,.273530381,.29024988,.306057377,.3210876,.34921268,.34921268,.362457751,.37523559,.387592406,.39956728,.411193551,.42250001,.432926419,.44310755,.4530599578,.46279839,.472336083,.48168495,.4908558,.49985844,.508701765,.51739395,.525942511,.53435433,.542635767,.55079269,.558830576,.56675452,.574569153,.58227891,.589887917,.59740001,.604818814,.61215729,.619399365,.62656713,.633644533,.64065295,.647576426,.65443563,.661214806,.667934,.674577537,.68116492,.687680648,.69414365,.700538673,.70688421,.713164996,.71939909,.725571552,.7317,.734741009,.73776948,.740785574,.74378943,.746781211,.74976104,.752729087,.75568551,.758630378,.76156384,.764486065,.76739717,.770297266,.7731865,.776064962,.77893275,.781790055,.78463697,.787473578,.79030001,.792803968,.79530001,.797803921,.8003,.802803892,.8053,.807803863,.81029999,.812803835,.81529999,.817803806,.82029999,.822803778,.82529999,.82780375,.83029999,.832803753,.835300028,.837803755,.840300023];
const LEVELS=CPMS.map((_,i)=>1+i*.5);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const norm=s=>(s||'').toLowerCase().replace(/[\s・･'’._\-()（）]/g,'').replace(/[♀♂]/g,'');

$('files').addEventListener('change',e=>{
 app.items=[...e.target.files].map(f=>({file:f,url:URL.createObjectURL(f),name:'未判定',cp:null,currentHp:null,atk:null,def:null,hp:null,ranks:{},megaRanks:[],state:'待機',ocr:'',speciesId:null,pvp:null,candidates:[]}));
 $('analyze').disabled=!app.items.length;$('csv').disabled=!app.items.length;render();setStatus(`${app.items.length}枚読み込みました。`);
});
$('clear').onclick=()=>{app.items.forEach(x=>URL.revokeObjectURL(x.url));app.items=[];$('grid').innerHTML='';$('tbody').innerHTML='';$('summaryCard').style.display='none';$('files').value='';$('analyze').disabled=true;$('csv').disabled=true;setProgress(0);setStatus('画像を選択してください。')};
$('analyze').onclick=analyzeAll;$('csv').onclick=downloadCSV;

async function loadData(){
 if(app.pvp&&app.names)return;
 const [a,b]=await Promise.all([
  fetch('https://raw.githubusercontent.com/pvpoke/pvpoke/master/src/data/gamemaster/pokemon.json'),
  fetch('https://raw.githubusercontent.com/motemen/pokemon-data/main/POKEMON_ALL.json')
 ]);
 if(!a.ok||!b.ok)throw new Error('ポケモンデータを取得できませんでした');
 app.pvp=await a.json();app.names=await b.json();
}
async function getWorker(){
 if(app.worker)return app.worker;
 app.worker=await Tesseract.createWorker('jpn+eng',1,{logger:m=>{if(m.status==='recognizing text')setStatus(`OCR解析中… ${Math.round((m.progress||0)*100)}%`) }});
 return app.worker;
}

async function analyzeAll(){
 $('analyze').disabled=true;
 try{
  await loadData();const worker=await getWorker();
  for(let i=0;i<app.items.length;i++){
   const it=app.items[i];it.state='解析中';render();setStatus(`${i+1}/${app.items.length} を解析中…`);
   const img=await loadImage(it.url);
   const crop=makeCrop(img,0,0,img.naturalWidth,Math.round(img.naturalHeight*.58),1500);
   const {data}=await worker.recognize(crop);it.ocr=data.text||'';
   parseText(it);

   const iv=detectIVBarsV4(img);
   if(iv){it.atk=iv[0];it.def=iv[1];it.hp=iv[2]}

   const ocrSpecies=findSpeciesLongestInText(it.ocr);
   if(ocrSpecies)applySpecies(it,ocrSpecies);

   if(!it.pvp && Number.isInteger(it.cp)&&Number.isInteger(it.currentHp)&&[it.atk,it.def,it.hp].every(Number.isInteger)){
      const cs=inferSpeciesByStats(it.cp,it.currentHp,it.atk,it.def,it.hp);
      it.candidates=cs;
      const dexes=[...new Set(cs.map(x=>x.dex))];
      if(dexes.length===1&&cs.length)applySpecies(it,cs[0]);
   }

   recalcItem(it);
   setProgress((i+1)/app.items.length);render();
  }
  setStatus('解析完了。v4では評価バーの実際の色付き長さを基準にIVを判定します。','ok');
 }catch(e){setStatus('解析エラー: '+e.message,'warn')}
 $('analyze').disabled=false;
}

function parseText(it){
 const t=(it.ocr||'').replace(/[ＯO]/g,'0');
 let m=t.match(/\bCP\s*([0-9,]+)/i);if(m)it.cp=Number(m[1].replace(/,/g,''));
 m=t.match(/(\d{1,3})\s*\/\s*\d{1,3}\s*HP/i);if(m)it.currentHp=Number(m[1]);
}

function isMega(p){
 return !!p && ((Array.isArray(p.tags)&&p.tags.includes('mega')) || String(p.speciesId||'').includes('_mega'));
}
function basePvpForDex(dex){
 return app.pvp.find(x=>Number(x.dex)===Number(dex)&&!String(x.speciesId).includes('shadow')&&!isMega(x));
}
function rowNames(row){
 return [row.pokeapi_species_name_ja||'',row.yakkuncom_name||'',row.pokeapi_species_name_en||'',row.pkmn_base_species||''].filter(Boolean);
}

// OCR用：部分一致は許すが、最も長いポケモン名を優先。
// 例: リザードンなら「リザード」ではなく「リザードン」。
function findSpeciesLongestInText(text){
 const n=norm(text);let matches=[];
 for(const row of app.names){
   for(const nm of rowNames(row)){
     const nn=norm(nm);
     if(nn && ((/[^\x00-\x7F]/.test(nm)&&nn.length>=2)||(nn.length>=4)) && n.includes(nn)){
       const dex=Number(row.national_pokedex_number),p=basePvpForDex(dex);
       if(p)matches.push({pvp:p,dex,row,matchLen:[...nn].length,name:nm});
     }
   }
 }
 matches.sort((a,b)=>b.matchLen-a.matchLen);
 return matches[0]||null;
}

// 手入力用：完全一致のみ。
// 「リザードン」→リザードン、「ギギアル」→ギギアル。部分一致では確定しない。
function findSpeciesExact(input){
 const q=norm(input);if(!q)return null;
 let found=[];
 for(const row of app.names){
   for(const nm of rowNames(row)){
     if(norm(nm)===q){
       const dex=Number(row.national_pokedex_number),p=basePvpForDex(dex);
       if(p)found.push({pvp:p,dex,row,name:nm});
     }
   }
 }
 return found[0]||null;
}

function applySpecies(it,m){
 const p=m.pvp||m;it.pvp=p;it.speciesId=p.speciesId;
 const dex=Number(p.dex),row=app.names.find(x=>Number(x.national_pokedex_number)===dex);
 it.name=(row&&(row.pokeapi_species_name_ja||row.yakkuncom_name))||p.speciesName||p.speciesId;
}

function inferSpeciesByStats(cp,hp,a,d,h){
 const out=[],seen=new Set();
 for(const p of app.pvp){
   if(!p.baseStats||String(p.speciesId).includes('shadow')||isMega(p))continue;
   for(let i=0;i<CPMS.length;i++){
    const c=CPMS[i],calc=cpAt(p,a,d,h,c),calcHp=Math.floor((p.baseStats.hp+h)*c);
    if(calc===cp&&calcHp===hp){
      const key=p.speciesId+'|'+i;if(!seen.has(key)){seen.add(key);out.push({pvp:p,dex:Number(p.dex),level:LEVELS[i]})}
    }
   }
 }
 return out;
}

// v4:
// 1) 評価画面の3本のバーを「暖色の充填 + 灰色の未充填」で検出
// 2) 3本で共通の開始/終了Xを求める
// 3) 各バーの最後の暖色ピクセル / バー全長 から0〜15を求める
// ユーザー提供画像では 12 / 15 / 15 になる方式。
function detectIVBarsV4(img){
 const scale=Math.min(1,1000/img.naturalWidth);
 const w=Math.round(img.naturalWidth*scale),h=Math.round(img.naturalHeight*scale);
 const c=document.createElement('canvas');c.width=w;c.height=h;
 const ctx=c.getContext('2d');ctx.drawImage(img,0,0,w,h);
 const id=ctx.getImageData(0,0,w,h),D=id.data;
 const px=(x,y)=>{const k=(y*w+x)*4;return[D[k],D[k+1],D[k+2]]};

 const colored=([r,g,b])=>r>180&&(r-g)>25&&(r-b)>20&&g>50;
 const gray=([r,g,b])=>{
   const mean=(r+g+b)/3,range=Math.max(r,g,b)-Math.min(r,g,b);
   return mean>195&&mean<242&&range<14;
 };

 const y0=Math.floor(h*.40),y1=Math.floor(h*.70);
 let rows=[];

 for(let y=y0;y<y1;y++){
   let best=null,start=null,last=-1,gap=0,colorCount=0;

   for(let x=0;x<w;x++){
     const p=px(x,y),isColor=colored(p),good=isColor||gray(p);

     if(good){
       if(start===null){start=x;colorCount=0}
       last=x;gap=0;if(isColor)colorCount++;
     }else if(start!==null){
       gap++;
       // 白い5刻みの区切り線は許容
       if(gap>12){
         const end=last,len=end-start+1;
         if(len>w*.22&&colorCount>w*.06){
           const cand={start,end,colorCount};
           if(!best||len>(best.end-best.start+1))best=cand;
         }
         start=null;gap=0;colorCount=0;
       }
     }
   }

   if(start!==null){
     const end=last,len=end-start+1;
     if(len>w*.22&&colorCount>w*.06){
       const cand={start,end,colorCount};
       if(!best||len>(best.end-best.start+1))best=cand;
     }
   }

   if(best)rows.push({y,...best});
 }

 // 連続するYを1本のバーにまとめ、最長トラックの行を代表にする
 let groups=[];
 for(const r of rows){
   if(!groups.length||r.y-groups[groups.length-1][groups[groups.length-1].length-1].y>3)groups.push([r]);
   else groups[groups.length-1].push(r);
 }
 const reps=groups.map(g=>g.reduce((a,b)=>(b.end-b.start)>(a.end-a.start)?b:a));

 // 同じX範囲を持ち、ほぼ等間隔に並ぶ3本を選択
 let triple=null,bestScore=Infinity;
 for(let a=0;a<reps.length;a++)for(let b=a+1;b<reps.length;b++)for(let c3=b+1;c3<reps.length;c3++){
   const t=[reps[a],reps[b],reps[c3]];
   const starts=t.map(z=>z.start),ends=t.map(z=>z.end);
   const sx=Math.max(...starts)-Math.min(...starts);
   const ex=Math.max(...ends)-Math.min(...ends);
   const d1=t[1].y-t[0].y,d2=t[2].y-t[1].y;
   if(sx>20||ex>20||d1<25||d2<25)continue;
   const score=sx+ex+Math.abs(d1-d2)*.3;
   if(score<bestScore){bestScore=score;triple=t}
 }
 if(!triple)return null;
 triple.sort((a,b)=>a.y-b.y);

 const median=a=>[...a].sort((x,y)=>x-y)[1];
 const start=median(triple.map(z=>z.start));
 const end=median(triple.map(z=>z.end));
 const total=end-start+1;
 if(total<=0)return null;

 return triple.map(r=>{
   let lastColor=start-1;
   for(let x=start;x<=end;x++)if(colored(px(x,r.y)))lastColor=x;
   const fraction=Math.max(0,Math.min(1,(lastColor-start+1)/total));
   return Math.max(0,Math.min(15,Math.round(fraction*15)));
 });
}

function cpAt(p,a,d,h,cpm){
 const A=p.baseStats.atk+a,D=p.baseStats.def+d,S=p.baseStats.hp+h;
 return Math.max(10,Math.floor(A*Math.sqrt(D)*Math.sqrt(S)*cpm*cpm/10));
}
function bestUnder(p,a,d,h,cap){
 let best=null;
 for(let i=0;i<CPMS.length;i++){
  const cp=cpAt(p,a,d,h,CPMS[i]);
  if(cp<=cap){
   const c=CPMS[i],A=(p.baseStats.atk+a)*c,D=(p.baseStats.def+d)*c,HP=Math.floor((p.baseStats.hp+h)*c);
   best={sp:A*D*HP};
  }else break;
 }
 return best;
}
function rankFor(p,a,d,h,cap){
 const key=p.speciesId+'|'+cap;let arr=app.rankCache.get(key);
 if(!arr){
  arr=[];
  for(let A=0;A<16;A++)for(let D=0;D<16;D++)for(let H=0;H<16;H++){
   const b=bestUnder(p,A,D,H,cap);if(b)arr.push({a:A,d:D,h:H,sp:b.sp});
  }
  arr.sort((x,y)=>y.sp-x.sp);arr.forEach((x,i)=>x.rank=i+1);app.rankCache.set(key,arr);
 }
 const o=arr.find(x=>x.a===a&&x.d===d&&x.h===h);return o?o.rank:'—';
}
function rankML(p,a,d,h){
 const key=p.speciesId+'|ML';let arr=app.rankCache.get(key);
 if(!arr){
  const c=CPMS[CPMS.length-1];arr=[];
  for(let A=0;A<16;A++)for(let D=0;D<16;D++)for(let H=0;H<16;H++){
   const atk=(p.baseStats.atk+A)*c,def=(p.baseStats.def+D)*c,hp=Math.floor((p.baseStats.hp+H)*c);
   arr.push({a:A,d:D,h:H,sp:atk*def*hp});
  }
  arr.sort((x,y)=>y.sp-x.sp);arr.forEach((x,i)=>x.rank=i+1);app.rankCache.set(key,arr);
 }
 const o=arr.find(x=>x.a===a&&x.d===d&&x.h===h);return o?o.rank:'—';
}
const computeRanks=(p,a,d,h)=>({r500:rankFor(p,a,d,h,500),sl:rankFor(p,a,d,h,1500),hl:rankFor(p,a,d,h,2500),ml:rankML(p,a,d,h)});

function megaLabel(baseName,p){
 const s=String(p.speciesName||'');
 if(/\(Mega X\)/i.test(s))return `メガ${baseName}X`;
 if(/\(Mega Y\)/i.test(s))return `メガ${baseName}Y`;
 return `メガ${baseName}`;
}
function recalcItem(it){
 if(it.pvp&&[it.atk,it.def,it.hp].every(Number.isInteger)){
   it.ranks=computeRanks(it.pvp,it.atk,it.def,it.hp);
   const megas=app.pvp.filter(p=>Number(p.dex)===Number(it.pvp.dex)&&isMega(p)&&!String(p.speciesId).includes('shadow'));
   it.megaRanks=megas.map(p=>({label:megaLabel(it.name,p),pvp:p,ranks:computeRanks(p,it.atk,it.def,it.hp)}));
   it.state='完了';
 }else{
   it.ranks={};it.megaRanks=[];
   it.state=it.candidates.length?'候補あり':'要確認';
 }
}

function render(){
 $('summaryCard').style.display=app.items.length?'block':'none';
 $('tbody').innerHTML=app.items.map((it,i)=>`<tr><td>${i+1}</td><td>${esc(it.name)}</td><td>${it.cp??'—'}</td><td>${it.currentHp??'—'}</td><td>${fmtIV(it)}</td><td>${fmtRank(it.ranks.r500)}</td><td>${fmtRank(it.ranks.sl)}</td><td>${fmtRank(it.ranks.hl)}</td><td>${fmtRank(it.ranks.ml)}</td><td>${esc(it.state)}</td></tr>`).join('');

 $('grid').innerHTML=app.items.map((it,i)=>`<article class="item"><img class="thumb" src="${it.url}"><div class="info">
 <div class="name">${esc(it.name)}</div>
 <div class="meta">CP ${it.cp??'—'} ・ 現在HP ${it.currentHp??'—'} ・ ${esc(it.state)}</div>
 <div class="ivrow">${pill('攻撃',it.atk)}${pill('防御',it.def)}${pill('HP',it.hp)}</div>
 <div class="ranks">${pill('500',it.ranks.r500)}${pill('SL',it.ranks.sl)}${pill('HL',it.ranks.hl)}${pill('ML',it.ranks.ml)}</div>
 ${renderMegas(it)}
 <div class="nameEdit"><input type="text" maxlength="6" value="${esc(it.name==='未判定'?'':it.name)}" placeholder="ポケモン名（最大6文字）" onchange="editName(${i},this.value)"></div>
 <div class="ivEdit">${ivSelect(i,'atk',it.atk)}${ivSelect(i,'def',it.def)}${ivSelect(i,'hp',it.hp)}</div>
 ${it.candidates.length>1?`<div class="small">逆算候補: ${esc(it.candidates.slice(0,6).map(c=>c.pvp.speciesName).join(' / '))}</div>`:''}
 </div></article>`).join('');
}
function renderMegas(it){
 if(!it.megaRanks||!it.megaRanks.length)return'';
 return `<div class="mega">${it.megaRanks.map(m=>`<div class="megaTitle">${esc(m.label)}</div><div class="ranks">${pill('500',m.ranks.r500)}${pill('SL',m.ranks.sl)}${pill('HL',m.ranks.hl)}${pill('ML',m.ranks.ml)}</div>`).join('')}</div>`;
}
function pill(l,v){return `<div class="pill">${l}<b>${v??'—'}</b></div>`}
function ivSelect(i,k,v){
 let o=`<select onchange="editIV(${i},'${k}',this.value)"><option value="">—</option>`;
 for(let n=0;n<=15;n++)o+=`<option ${v===n?'selected':''}>${n}</option>`;
 return o+'</select>';
}
function fmtIV(it){return[it.atk,it.def,it.hp].every(Number.isInteger)?`${it.atk}/${it.def}/${it.hp}`:'—'}
function fmtRank(v){return v==null?'—':'#'+v}

window.editIV=(i,k,v)=>{
 app.items[i][k]=v===''?null:Number(v);
 retryResolve(i,true);render();
}

window.editName=(i,v)=>{
 const it=app.items[i];
 v=[...v].slice(0,6).join('');
 it.name=v||'未判定';

 // 手入力では「完全一致」だけで確定。部分一致は絶対に使わない。
 const m=findSpeciesExact(v);
 if(m){
   applySpecies(it,m);
   recalcItem(it);
 }else{
   // 入力途中の文字を勝手に別ポケモンへ置換しない
   it.pvp=null;it.speciesId=null;it.ranks={};it.megaRanks=[];it.state='名前要確認';
 }
 render();
}

function retryResolve(i,allowInference){
 const it=app.items[i];
 if(allowInference && !it.pvp&&Number.isInteger(it.cp)&&Number.isInteger(it.currentHp)&&[it.atk,it.def,it.hp].every(Number.isInteger)){
   const c=inferSpeciesByStats(it.cp,it.currentHp,it.atk,it.def,it.hp);
   it.candidates=c;
   const dexes=[...new Set(c.map(x=>x.dex))];
   if(dexes.length===1&&c.length)applySpecies(it,c[0]);
 }
 recalcItem(it);
}

function loadImage(url){return new Promise((res,rej)=>{const i=new Image;i.onload=()=>res(i);i.onerror=rej;i.src=url})}
function makeCrop(img,x,y,w,h,maxW){const s=Math.min(1,maxW/w),c=document.createElement('canvas');c.width=Math.round(w*s);c.height=Math.round(h*s);c.getContext('2d').drawImage(img,x,y,w,h,0,0,c.width,c.height);return c}
function setStatus(t,cls=''){$('status').className='status '+cls;$('status').textContent=t}
function setProgress(v){$('bar').style.width=Math.round(v*100)+'%'}

function downloadCSV(){
 const rows=[['No','Pokemon','CP','Current HP','Attack','Defense','HP','500 Rank','SL Rank','HL Rank','ML Rank','Mega','Mega 500','Mega SL','Mega HL','Mega ML','State']];
 app.items.forEach((it,i)=>{
   if(it.megaRanks.length){
     it.megaRanks.forEach((m,j)=>rows.push([j?'':i+1,j?'':it.name,j?'':(it.cp??''),j?'':(it.currentHp??''),j?'':(it.atk??''),j?'':(it.def??''),j?'':(it.hp??''),j?'':(it.ranks.r500??''),j?'':(it.ranks.sl??''),j?'':(it.ranks.hl??''),j?'':(it.ranks.ml??''),m.label,m.ranks.r500??'',m.ranks.sl??'',m.ranks.hl??'',m.ranks.ml??'',it.state]));
   }else{
     rows.push([i+1,it.name,it.cp??'',it.currentHp??'',it.atk??'',it.def??'',it.hp??'',it.ranks.r500??'',it.ranks.sl??'',it.ranks.hl??'',it.ranks.ml??'','','','','','',it.state]);
   }
 });
 const csv='\ufeff'+rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
 const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='pokemon_go_iv_results_v4.csv';a.click();
}

if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
