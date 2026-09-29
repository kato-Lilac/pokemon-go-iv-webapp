const $=id=>document.getElementById(id);
const app={items:[],pvp:null,names:null,rankCache:new Map(),worker:null};
const CPMS=[.094,.135137432,.16639787,.192650919,.21573247,.236572661,.25572005,.273530381,.29024988,.306057377,.3210876,.34921268,.34921268,.362457751,.37523559,.387592406,.39956728,.411193551,.42250001,.432926419,.44310755,.4530599578,.46279839,.472336083,.48168495,.4908558,.49985844,.508701765,.51739395,.525942511,.53435433,.542635767,.55079269,.558830576,.56675452,.574569153,.58227891,.589887917,.59740001,.604818814,.61215729,.619399365,.62656713,.633644533,.64065295,.647576426,.65443563,.661214806,.667934,.674577537,.68116492,.687680648,.69414365,.700538673,.70688421,.713164996,.71939909,.725571552,.7317,.734741009,.73776948,.740785574,.74378943,.746781211,.74976104,.752729087,.75568551,.758630378,.76156384,.764486065,.76739717,.770297266,.7731865,.776064962,.77893275,.781790055,.78463697,.787473578,.79030001,.792803968,.79530001,.797803921,.8003,.802803892,.8053,.807803863,.81029999,.812803835,.81529999,.817803806,.82029999,.822803778,.82529999,.82780375,.83029999,.832803753,.835300028,.837803755,.840300023];
const LEVELS=CPMS.map((_,i)=>1+i*.5);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const norm=s=>(s||'').toLowerCase().replace(/[\s・･'’._\-()（）]/g,'').replace(/[♀♂]/g,'');

$('files').addEventListener('change',e=>{
 app.items=[...e.target.files].map(f=>({file:f,url:URL.createObjectURL(f),name:'未判定',cp:null,currentHp:null,atk:null,def:null,hp:null,ranks:{},state:'待機',ocr:'',speciesId:null,pvp:null,candidates:[]}));
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
   const crop=makeCrop(img,0,0,img.naturalWidth,Math.round(img.naturalHeight*.55),1500);
   const {data}=await worker.recognize(crop);it.ocr=data.text||'';
   parseText(it);
   const iv=detectIVBarsV2(img);
   if(iv){it.atk=iv[0];it.def=iv[1];it.hp=iv[2]}
   // 1) OCRで種名、2) CP+現在HP+IVから逆算
   let m=findSpeciesFromText(it.ocr);
   if(m)applySpecies(it,m);
   if(!it.pvp && Number.isInteger(it.cp)&&Number.isInteger(it.currentHp)&&[it.atk,it.def,it.hp].every(Number.isInteger)){
      const cs=inferSpeciesByStats(it.cp,it.currentHp,it.atk,it.def,it.hp);
      it.candidates=cs;
      if(cs.length===1)applySpecies(it,cs[0]);
      else if(cs.length>1){
        // 同一baseStats/同一dexの重複をまとめて実質1種なら採用
        const dexes=[...new Set(cs.map(x=>x.dex))];
        if(dexes.length===1)applySpecies(it,cs[0]);
      }
   }
   if(it.pvp&&[it.atk,it.def,it.hp].every(Number.isInteger))it.ranks=computeRanks(it.pvp,it.atk,it.def,it.hp);
   it.state=it.pvp?'完了':(it.candidates.length?'候補あり':'要確認');
   setProgress((i+1)/app.items.length);render();
  }
  setStatus('解析完了。v2ではピンク色の満タンバーも認識し、CP/HP/IVからポケモン種を逆算します。','ok');
 }catch(e){setStatus('解析エラー: '+e.message,'warn')}
 $('analyze').disabled=false;
}
function parseText(it){
 const t=(it.ocr||'').replace(/[ＯO]/g,'0');
 let m=t.match(/\bCP\s*([0-9,]+)/i);if(m)it.cp=Number(m[1].replace(/,/g,''));
 m=t.match(/(\d{1,3})\s*\/\s*\d{1,3}\s*HP/i);if(m)it.currentHp=Number(m[1]);
}
function findSpeciesFromText(text){
 const n=norm(text);
 for(const row of app.names){
  const ja=row.pokeapi_species_name_ja||row.yakkuncom_name||'',en=row.pokeapi_species_name_en||row.pkmn_base_species||'';
  if((norm(ja).length>=2&&n.includes(norm(ja)))||(norm(en).length>=4&&n.includes(norm(en)))){
   const dex=Number(row.national_pokedex_number),p=app.pvp.find(x=>Number(x.dex)===dex&&!String(x.speciesId).includes('shadow'));
   if(p)return{pvp:p,dex,ja,en};
  }
 }return null;
}
function applySpecies(it,m){
 const p=m.pvp||m;
 it.pvp=p;it.speciesId=p.speciesId;
 const dex=Number(p.dex),row=app.names.find(x=>Number(x.national_pokedex_number)===dex);
 it.name=(row&&(row.pokeapi_species_name_ja||row.yakkuncom_name))||p.speciesName||p.speciesId;
}
function inferSpeciesByStats(cp,hp,a,d,h){
 const out=[],seen=new Set();
 for(const p of app.pvp){
   if(!p.baseStats||String(p.speciesId).includes('shadow'))continue;
   for(let i=0;i<CPMS.length;i++){
    const c=CPMS[i],calc=cpAt(p,a,d,h,c),calcHp=Math.floor((p.baseStats.hp+h)*c);
    if(calc===cp&&calcHp===hp){
      const key=p.speciesId+'|'+i;
      if(!seen.has(key)){seen.add(key);out.push({pvp:p,dex:Number(p.dex),level:LEVELS[i]})}
    }
   }
 }
 return out;
}
function detectIVBarsV2(img){
 const scale=Math.min(1,900/img.naturalWidth),w=Math.round(img.naturalWidth*scale),h=Math.round(img.naturalHeight*scale);
 const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');x.drawImage(img,0,0,w,h);
 // 評価UIは画面中央〜下部。色付きバーの水平線を探す。
 const y0=Math.floor(h*.35),y1=Math.floor(h*.80),idata=x.getImageData(0,y0,w,y1-y0),D=idata.data,H=idata.height;
 const colored=(r,g,b)=>{
   const max=Math.max(r,g,b),min=Math.min(r,g,b),sat=max?((max-min)/max):0;
   // 攻撃の橙 + 防御/HPのピンク/赤
   return r>175 && sat>.18 && (r-g)>18 && (r-b)>8;
 };
 const track=(r,g,b)=>{
   const max=Math.max(r,g,b),min=Math.min(r,g,b);
   return max>155 && (max-min)<32; // 未充填の灰色バー
 };
 let counts=new Array(H).fill(0);
 for(let yy=0;yy<H;yy++)for(let xx=0;xx<w;xx++){let k=(yy*w+xx)*4;if(colored(D[k],D[k+1],D[k+2]))counts[yy]++}
 let bands=[],s=null,thr=Math.max(30,w*.07);
 for(let yy=0;yy<H;yy++){
   if(counts[yy]>thr&&s===null)s=yy;
   if((counts[yy]<=thr||yy===H-1)&&s!==null){let e=yy-1;if(e-s>=3)bands.push({a:s,b:e,score:Math.max(...counts.slice(s,e+1))});s=null}
 }
 // 最も強い3本。縦位置順が攻撃/防御/HP
 bands=bands.sort((a,b)=>b.score-a.score).slice(0,6).sort((a,b)=>a.a-b.a);
 // 近接バンドを統合
 let merged=[];for(const q of bands){let z=merged[merged.length-1];if(z&&q.a-z.b<10){z.b=q.b;z.score=Math.max(z.score,q.score)}else merged.push({...q})}
 if(merged.length<3)return null;
 merged=merged.sort((a,b)=>b.score-a.score).slice(0,3).sort((a,b)=>a.a-b.a);
 let vals=[];
 for(const band of merged){
   const yy=Math.round((band.a+band.b)/2);
   // 色付き/灰色を含む「バー全体」を小さな白区切りを許容して連結
   let pixels=[];
   for(let xx=0;xx<w;xx++){let k=(yy*w+xx)*4,r=D[k],g=D[k+1],b=D[k+2];pixels.push({col:colored(r,g,b),trk:track(r,g,b)})}
   let best=null,start=null,lastGood=-1,gap=0;
   for(let xx=0;xx<w;xx++){
     const good=pixels[xx].col||pixels[xx].trk;
     if(good){
       if(start===null)start=xx;lastGood=xx;gap=0;
     }else if(start!==null){
       gap++;
       if(gap>14){
         const end=lastGood;
         if(end-start>120 && (!best||end-start>best.end-best.start))best={start,end};
         start=null;gap=0;
       }
     }
   }
   if(start!==null){const end=lastGood;if(end-start>120&&(!best||end-start>best.end-best.start))best={start,end}}
   if(!best)return null;
   let lastColor=best.start;
   for(let xx=best.start;xx<=best.end;xx++)if(pixels[xx].col)lastColor=xx;
   const fraction=(lastColor-best.start+1)/(best.end-best.start+1);
   vals.push(Math.max(0,Math.min(15,Math.round(fraction*15))));
 }
 return vals;
}
function cpAt(p,a,d,h,cpm){const A=p.baseStats.atk+a,D=p.baseStats.def+d,S=p.baseStats.hp+h;return Math.max(10,Math.floor(A*Math.sqrt(D)*Math.sqrt(S)*cpm*cpm/10))}
function bestUnder(p,a,d,h,cap){let best=null;for(let i=0;i<CPMS.length;i++){const cp=cpAt(p,a,d,h,CPMS[i]);if(cp<=cap){const c=CPMS[i],A=(p.baseStats.atk+a)*c,D=(p.baseStats.def+d)*c,HP=Math.floor((p.baseStats.hp+h)*c);best={sp:A*D*HP}}else break}return best}
function rankFor(p,a,d,h,cap){const key=p.speciesId+'|'+cap;let arr=app.rankCache.get(key);if(!arr){arr=[];for(let A=0;A<16;A++)for(let D=0;D<16;D++)for(let H=0;H<16;H++){const b=bestUnder(p,A,D,H,cap);if(b)arr.push({a:A,d:D,h:H,sp:b.sp})}arr.sort((x,y)=>y.sp-x.sp);arr.forEach((x,i)=>x.rank=i+1);app.rankCache.set(key,arr)}const o=arr.find(x=>x.a===a&&x.d===d&&x.h===h);return o?o.rank:'—'}
function rankML(p,a,d,h){const key=p.speciesId+'|ML';let arr=app.rankCache.get(key);if(!arr){const c=CPMS[CPMS.length-1];arr=[];for(let A=0;A<16;A++)for(let D=0;D<16;D++)for(let H=0;H<16;H++){const atk=(p.baseStats.atk+A)*c,def=(p.baseStats.def+D)*c,hp=Math.floor((p.baseStats.hp+H)*c);arr.push({a:A,d:D,h:H,sp:atk*def*hp})}arr.sort((x,y)=>y.sp-x.sp);arr.forEach((x,i)=>x.rank=i+1);app.rankCache.set(key,arr)}const o=arr.find(x=>x.a===a&&x.d===d&&x.h===h);return o?o.rank:'—'}
const computeRanks=(p,a,d,h)=>({r500:rankFor(p,a,d,h,500),sl:rankFor(p,a,d,h,1500),hl:rankFor(p,a,d,h,2500),ml:rankML(p,a,d,h)});
function render(){
 $('summaryCard').style.display=app.items.length?'block':'none';
 $('tbody').innerHTML=app.items.map((it,i)=>`<tr><td>${i+1}</td><td>${esc(it.name)}</td><td>${it.cp??'—'}</td><td>${it.currentHp??'—'}</td><td>${fmtIV(it)}</td><td>${fmtRank(it.ranks.r500)}</td><td>${fmtRank(it.ranks.sl)}</td><td>${fmtRank(it.ranks.hl)}</td><td>${fmtRank(it.ranks.ml)}</td><td>${esc(it.state)}</td></tr>`).join('');
 $('grid').innerHTML=app.items.map((it,i)=>`<article class="item"><img class="thumb" src="${it.url}"><div class="info"><div class="name">${esc(it.name)}</div><div class="meta">CP ${it.cp??'—'} ・ 現在HP ${it.currentHp??'—'} ・ ${esc(it.state)}${it.candidates.length>1?` ・ 候補${it.candidates.length}件`:''}</div><div class="ivrow">${pill('攻撃',it.atk)}${pill('防御',it.def)}${pill('HP',it.hp)}</div><div class="ranks">${pill('500',it.ranks.r500)}${pill('SL',it.ranks.sl)}${pill('HL',it.ranks.hl)}${pill('ML',it.ranks.ml)}</div><div class="editrow"><input type="text" value="${esc(it.name==='未判定'?'':it.name)}" placeholder="ポケモン名" onchange="editName(${i},this.value)">${ivSelect(i,'atk',it.atk)}${ivSelect(i,'def',it.def)}${ivSelect(i,'hp',it.hp)}</div>${it.candidates.length>1?`<div class="small">逆算候補: ${esc(it.candidates.slice(0,6).map(c=>c.pvp.speciesName).join(' / '))}</div>`:''}</div></article>`).join('');
}
function pill(l,v){return `<div class="pill">${l}<b>${v??'—'}</b></div>`}
function ivSelect(i,k,v){let o=`<select onchange="editIV(${i},'${k}',this.value)"><option value="">—</option>`;for(let n=0;n<=15;n++)o+=`<option ${v===n?'selected':''}>${n}</option>`;return o+'</select>'}
function fmtIV(it){return[it.atk,it.def,it.hp].every(Number.isInteger)?`${it.atk}/${it.def}/${it.hp}`:'—'}function fmtRank(v){return v==null?'—':'#'+v}
window.editIV=(i,k,v)=>{app.items[i][k]=v===''?null:Number(v);retryResolve(i);render()}
window.editName=(i,v)=>{const it=app.items[i],m=findSpeciesFromText(v);it.name=v||'未判定';if(m)applySpecies(it,m);retryResolve(i);render()}
function retryResolve(i){const it=app.items[i];if(!it.pvp&&Number.isInteger(it.cp)&&Number.isInteger(it.currentHp)&&[it.atk,it.def,it.hp].every(Number.isInteger)){const c=inferSpeciesByStats(it.cp,it.currentHp,it.atk,it.def,it.hp);it.candidates=c;if(c.length===1)applySpecies(it,c[0])}if(it.pvp&&[it.atk,it.def,it.hp].every(Number.isInteger)){it.ranks=computeRanks(it.pvp,it.atk,it.def,it.hp);it.state='完了'}else it.state='要確認'}
function loadImage(url){return new Promise((res,rej)=>{const i=new Image;i.onload=()=>res(i);i.onerror=rej;i.src=url})}
function makeCrop(img,x,y,w,h,maxW){const s=Math.min(1,maxW/w),c=document.createElement('canvas');c.width=Math.round(w*s);c.height=Math.round(h*s);c.getContext('2d').drawImage(img,x,y,w,h,0,0,c.width,c.height);return c}
function setStatus(t,cls=''){$('status').className='status '+cls;$('status').textContent=t}function setProgress(v){$('bar').style.width=Math.round(v*100)+'%'}
function downloadCSV(){const rows=[['No','Pokemon','CP','Current HP','Attack','Defense','HP','500 Rank','SL Rank','HL Rank','ML Rank','State']];app.items.forEach((it,i)=>rows.push([i+1,it.name,it.cp??'',it.currentHp??'',it.atk??'',it.def??'',it.hp??'',it.ranks.r500??'',it.ranks.sl??'',it.ranks.hl??'',it.ranks.ml??'',it.state]));const csv='\ufeff'+rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='pokemon_go_iv_results_v2.csv';a.click()}
if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
