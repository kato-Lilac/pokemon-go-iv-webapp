const $=id=>document.getElementById(id);
const app={items:[],pvp:null,names:null,rankCache:new Map(),worker:null};

const CPMS=[
.094,.135137432,.16639787,.192650919,.21573247,.236572661,.25572005,.273530381,.29024988,.306057377,.3210876,.34921268,
.34921268,.362457751,.37523559,.387592406,.39956728,.411193551,.42250001,.432926419,.44310755,.4530599578,.46279839,.472336083,.48168495,.4908558,.49985844,.508701765,.51739395,.525942511,.53435433,.542635767,.55079269,.558830576,.56675452,.574569153,.58227891,.589887917,.59740001,.604818814,.61215729,.619399365,.62656713,.633644533,.64065295,.647576426,.65443563,.661214806,.667934,.674577537,.68116492,.687680648,.69414365,.700538673,.70688421,.713164996,.71939909,.725571552,.7317,.734741009,.73776948,.740785574,.74378943,.746781211,.74976104,.752729087,.75568551,.758630378,.76156384,.764486065,.76739717,.770297266,.7731865,.776064962,.77893275,.781790055,.78463697,.787473578,.79030001,
.792803968,.79530001,.797803921,.8003,.802803892,.8053,.807803863,.81029999,.812803835,.81529999,.817803806,.82029999,.822803778,.82529999,.82780375,.83029999,.832803753,.835300028,.837803755,.840300023
];
const LEVELS=CPMS.map((_,i)=>1+i*.5);
function norm(s){return (s||'').toLowerCase().replace(/[\s・･'’._\-()（）]/g,'').replace(/[♀♂]/g,'')}
function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}

$('files').addEventListener('change',e=>{
  app.items=[...e.target.files].map(f=>({file:f,url:URL.createObjectURL(f),name:'未判定',speciesId:null,cp:'—',atk:null,def:null,hp:null,ranks:{},state:'待機',ocr:'',confidence:0}));
  $('analyze').disabled=!app.items.length;$('csv').disabled=!app.items.length;render();
  setStatus(`${app.items.length}枚読み込みました。「全部解析」を押してください。`);
});
$('clear').onclick=()=>{app.items.forEach(x=>URL.revokeObjectURL(x.url));app.items=[];$('grid').innerHTML='';$('tbody').innerHTML='';$('summaryCard').style.display='none';$('files').value='';$('analyze').disabled=true;$('csv').disabled=true;setStatus('画像を選択してください。');setProgress(0)};
$('analyze').onclick=analyzeAll;$('csv').onclick=downloadCSV;

async function loadData(){
  if(app.pvp&&app.names)return;
  setStatus('ポケモンデータを読み込み中…');
  const [pvpR,namesR]=await Promise.all([
    fetch('https://raw.githubusercontent.com/pvpoke/pvpoke/master/src/data/gamemaster/pokemon.json'),
    fetch('https://raw.githubusercontent.com/motemen/pokemon-data/main/POKEMON_ALL.json')
  ]);
  if(!pvpR.ok||!namesR.ok)throw new Error('ポケモンデータを取得できませんでした');
  app.pvp=await pvpR.json();app.names=await namesR.json();
}
async function getWorker(){
  if(app.worker)return app.worker;
  setStatus('OCRを準備中…');
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
      const top=makeCrop(img,0,0,img.naturalWidth,Math.round(img.naturalHeight*.42),1400);
      const {data}=await worker.recognize(top);it.ocr=data.text||'';
      const cp=it.ocr.match(/\bCP\s*([0-9,]+)/i);if(cp)it.cp=cp[1].replace(/,/g,'');
      const match=findSpecies(it.ocr);if(match){it.name=match.ja||match.en||match.pvp.speciesName;it.speciesId=match.pvp.speciesId;it.pvp=match.pvp}
      const iv=detectIVBars(img);if(iv){it.atk=iv[0];it.def=iv[1];it.hp=iv[2];it.confidence=iv.confidence||0}
      if(it.pvp&&[it.atk,it.def,it.hp].every(Number.isInteger))it.ranks=computeRanks(it.pvp,it.atk,it.def,it.hp);
      it.state=(it.pvp&&[it.atk,it.def,it.hp].every(Number.isInteger))?'完了':'要確認';
      setProgress((i+1)/app.items.length);render();
    }
    setStatus('解析完了。誤認識があればカード内で修正できます。','ok');
  }catch(e){setStatus('解析エラー: '+e.message,'warn')}
  $('analyze').disabled=false;
}
function findSpecies(text){
  const n=norm(text);for(const row of app.names){
    const ja=row.pokeapi_species_name_ja||row.yakkuncom_name||'',en=row.pokeapi_species_name_en||row.pkmn_base_species||'';
    const nj=norm(ja),ne=norm(en);
    if((nj&&nj.length>=2&&n.includes(nj))||(ne&&ne.length>=4&&n.includes(ne))){
      const dex=Number(row.national_pokedex_number);
      const cand=app.pvp.find(p=>Number(p.dex)===dex&&!String(p.speciesId).includes('shadow'));
      if(cand)return{ja,en,pvp:cand};
    }
  }return null;
}
function detectIVBars(img){
  const maxW=900,scale=Math.min(1,maxW/img.naturalWidth),w=Math.round(img.naturalWidth*scale),h=Math.round(img.naturalHeight*scale);
  const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');x.drawImage(img,0,0,w,h);
  const y0=Math.floor(h*.38),hh=Math.floor(h*.6),d=x.getImageData(0,y0,w,hh),data=d.data,counts=new Array(hh).fill(0);
  const orange=(r,g,b)=>r>150&&g>45&&g<195&&b<145&&r>g+25&&r>b+45;
  for(let y=0;y<hh;y++){let cnt=0;for(let xx=0;xx<w;xx++){let k=(y*w+xx)*4;if(orange(data[k],data[k+1],data[k+2]))cnt++}counts[y]=cnt}
  let groups=[],s=null,threshold=Math.max(22,w*.035);
  for(let y=0;y<hh;y++){if(counts[y]>threshold&&s===null)s=y;if((counts[y]<=threshold||y===hh-1)&&s!==null){let e=y-1;if(e-s>=2)groups.push([s,e]);s=null}}
  groups=groups.map(g=>({a:g[0],b:g[1],score:Math.max(...counts.slice(g[0],g[1]+1))})).sort((a,b)=>b.score-a.score).slice(0,8).sort((a,b)=>a.a-b.a);
  let merged=[];for(const g of groups){let last=merged[merged.length-1];if(last&&g.a-last.b<12){last.b=g.b;last.score=Math.max(last.score,g.score)}else merged.push({...g})}
  if(merged.length<3)return null;
  let chosen=merged.sort((a,b)=>b.score-a.score).slice(0,3).sort((a,b)=>a.a-b.a),widths=[];
  for(const g of chosen){const yy=Math.round((g.a+g.b)/2);let xs=[];for(let xx=0;xx<w;xx++){let k=(yy*w+xx)*4;if(orange(data[k],data[k+1],data[k+2]))xs.push(xx)}if(!xs.length)return null;widths.push({min:Math.min(...xs),max:Math.max(...xs)})}
  const starts=widths.map(z=>z.min).sort((a,b)=>a-b),commonStart=starts[1],orangeMax=Math.max(...widths.map(z=>z.max));let trackEnd=orangeMax;
  for(let i=0;i<3;i++){const yy=Math.round((chosen[i].a+chosen[i].b)/2),st=widths[i].min;let last=widths[i].max,gap=0;
    for(let xx=st;xx<w*.97;xx++){let k=(yy*w+xx)*4,r=data[k],g=data[k+1],b=data[k+2],gray=Math.max(r,g,b)-Math.min(r,g,b)<30&&r>95;if(orange(r,g,b)||gray){last=xx;gap=0}else gap++;if(gap>20)break}
    trackEnd=Math.max(trackEnd,last)}
  let total=Math.max(40,trackEnd-commonStart),vals=widths.map(z=>Math.max(0,Math.min(15,Math.round(15*(z.max-commonStart+1)/total))));
  vals.confidence=(trackEnd>orangeMax+20)?.75:.45;return vals;
}
function cpAt(p,a,d,h,cpm){const A=p.baseStats.atk+a,D=p.baseStats.def+d,S=p.baseStats.hp+h;return Math.max(10,Math.floor(A*Math.sqrt(D)*Math.sqrt(S)*cpm*cpm/10))}
function bestUnder(p,a,d,h,cap){let best=null;for(let i=0;i<CPMS.length;i++){const cp=cpAt(p,a,d,h,CPMS[i]);if(cp<=cap){const c=CPMS[i],A=(p.baseStats.atk+a)*c,D=(p.baseStats.def+d)*c,HP=Math.floor((p.baseStats.hp+h)*c);best={sp:A*D*HP}}else break}return best}
function rankFor(p,a,d,h,cap){const key=p.speciesId+'|'+cap;let arr=app.rankCache.get(key);if(!arr){arr=[];for(let A=0;A<16;A++)for(let D=0;D<16;D++)for(let H=0;H<16;H++){const b=bestUnder(p,A,D,H,cap);if(b)arr.push({a:A,d:D,h:H,sp:b.sp})}arr.sort((x,y)=>y.sp-x.sp);arr.forEach((x,i)=>x.rank=i+1);app.rankCache.set(key,arr)}const o=arr.find(x=>x.a===a&&x.d===d&&x.h===h);return o?o.rank:'—'}
function rankML(p,a,d,h){const key=p.speciesId+'|ML';let arr=app.rankCache.get(key);if(!arr){const c=CPMS[CPMS.length-1];arr=[];for(let A=0;A<16;A++)for(let D=0;D<16;D++)for(let H=0;H<16;H++){const atk=(p.baseStats.atk+A)*c,def=(p.baseStats.def+D)*c,hp=Math.floor((p.baseStats.hp+H)*c);arr.push({a:A,d:D,h:H,sp:atk*def*hp})}arr.sort((x,y)=>y.sp-x.sp);arr.forEach((x,i)=>x.rank=i+1);app.rankCache.set(key,arr)}const o=arr.find(x=>x.a===a&&x.d===d&&x.h===h);return o?o.rank:'—'}
const computeRanks=(p,a,d,h)=>({r500:rankFor(p,a,d,h,500),sl:rankFor(p,a,d,h,1500),hl:rankFor(p,a,d,h,2500),ml:rankML(p,a,d,h)});
function render(){
  $('summaryCard').style.display=app.items.length?'block':'none';
  $('tbody').innerHTML=app.items.map((it,i)=>`<tr><td>${i+1}</td><td>${esc(it.name)}</td><td>${esc(it.cp)}</td><td>${fmtIV(it)}</td><td>${fmtRank(it.ranks.r500)}</td><td>${fmtRank(it.ranks.sl)}</td><td>${fmtRank(it.ranks.hl)}</td><td>${fmtRank(it.ranks.ml)}</td><td>${esc(it.state)}</td></tr>`).join('');
  $('grid').innerHTML=app.items.map((it,i)=>`<article class="item"><img class="thumb" src="${it.url}"><div class="info"><div class="name">${esc(it.name)}</div><div class="meta">CP ${esc(it.cp)} ・ ${esc(it.state)}</div><div class="ivrow">${pill('攻撃',it.atk)}${pill('防御',it.def)}${pill('HP',it.hp)}</div><div class="ranks">${pill('500',it.ranks.r500)}${pill('SL',it.ranks.sl)}${pill('HL',it.ranks.hl)}${pill('ML',it.ranks.ml)}</div><div class="editrow"><input type="text" value="${esc(it.name==='未判定'?'':it.name)}" placeholder="ポケモン名" onchange="editName(${i},this.value)">${ivSelect(i,'atk',it.atk)}${ivSelect(i,'def',it.def)}${ivSelect(i,'hp',it.hp)}</div></div></article>`).join('');
}
function pill(l,v){return `<div class="pill">${l}<b>${v??'—'}</b></div>`}
function ivSelect(i,k,v){let o='<select onchange="editIV('+i+',\''+k+'\',this.value)"><option value="">—</option>';for(let n=0;n<=15;n++)o+=`<option ${v===n?'selected':''}>${n}</option>`;return o+'</select>'}
function fmtIV(it){return[it.atk,it.def,it.hp].every(Number.isInteger)?`${it.atk}/${it.def}/${it.hp}`:'—'} function fmtRank(v){return v==null?'—':'#'+v}
window.editIV=(i,k,v)=>{app.items[i][k]=v===''?null:Number(v);recalc(i);render()}
window.editName=(i,v)=>{const it=app.items[i];it.name=v||'未判定';const m=findSpecies(v);if(m){it.pvp=m.pvp;it.speciesId=m.pvp.speciesId}recalc(i);render()}
function recalc(i){const it=app.items[i];if(it.pvp&&[it.atk,it.def,it.hp].every(Number.isInteger)){it.ranks=computeRanks(it.pvp,it.atk,it.def,it.hp);it.state='完了'}else it.state='要確認'}
function loadImage(url){return new Promise((res,rej)=>{const i=new Image;i.onload=()=>res(i);i.onerror=rej;i.src=url})}
function makeCrop(img,x,y,w,h,maxW){const s=Math.min(1,maxW/w),c=document.createElement('canvas');c.width=Math.round(w*s);c.height=Math.round(h*s);c.getContext('2d').drawImage(img,x,y,w,h,0,0,c.width,c.height);return c}
function setStatus(t,cls=''){$('status').className='status '+cls;$('status').textContent=t} function setProgress(v){$('bar').style.width=Math.round(v*100)+'%'}
function downloadCSV(){const rows=[['No','Pokemon','CP','Attack','Defense','HP','500 Rank','SL Rank','HL Rank','ML Rank','State']];app.items.forEach((it,i)=>rows.push([i+1,it.name,it.cp,it.atk??'',it.def??'',it.hp??'',it.ranks.r500??'',it.ranks.sl??'',it.ranks.hl??'',it.ranks.ml??'',it.state]));const csv='\ufeff'+rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='pokemon_go_iv_results.csv';a.click()}
if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});

// lightweight WebGL background, proves WebGL-capable deployment without depending on Unity.
(()=>{const c=$('gl'),gl=c.getContext('webgl');if(!gl)return;function resize(){c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio;gl.viewport(0,0,c.width,c.height)}addEventListener('resize',resize);resize();gl.clearColor(.08,.11,.16,1);gl.clear(gl.COLOR_BUFFER_BIT)})();