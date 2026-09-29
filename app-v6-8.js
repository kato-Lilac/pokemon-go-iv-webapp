const $=id=>document.getElementById(id);
const app={items:[],pvp:null,names:null,rankCache:new Map(),worker:null};

if('serviceWorker' in navigator){
  navigator.serviceWorker.getRegistrations().then(rs=>rs.forEach(r=>r.unregister()));
}
if('caches' in window){
  caches.keys().then(keys=>keys.filter(k=>k.startsWith('go-iv-')).forEach(k=>caches.delete(k)));
}

const CPMS=[.094,.135137432,.16639787,.192650919,.21573247,.236572661,.25572005,.273530381,.29024988,.306057377,.3210876,.34921268,.34921268,.362457751,.37523559,.387592406,.39956728,.411193551,.42250001,.432926419,.44310755,.4530599578,.46279839,.472336083,.48168495,.4908558,.49985844,.508701765,.51739395,.525942511,.53435433,.542635767,.55079269,.558830576,.56675452,.574569153,.58227891,.589887917,.59740001,.604818814,.61215729,.619399365,.62656713,.633644533,.64065295,.647576426,.65443563,.661214806,.667934,.674577537,.68116492,.687680648,.69414365,.700538673,.70688421,.713164996,.71939909,.725571552,.7317,.734741009,.73776948,.740785574,.74378943,.746781211,.74976104,.752729087,.75568551,.758630378,.76156384,.764486065,.76739717,.770297266,.7731865,.776064962,.77893275,.781790055,.78463697,.787473578,.79030001,.792803968,.79530001,.797803921,.8003,.802803892,.8053,.807803863,.81029999,.812803835,.81529999,.817803806,.82029999,.822803778,.82529999,.82780375,.83029999,.832803753,.835300028,.837803755,.840300023];

const LEVELS=CPMS.map((_,i)=>1+i*.5);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const norm=s=>(s||'').toLowerCase().replace(/[\s・･'’._\-()（）]/g,'').replace(/[♀♂]/g,'');

$('files').addEventListener('change',e=>{
  app.items=[...e.target.files].map(f=>({
    file:f,url:URL.createObjectURL(f),name:'未判定',cp:null,currentHp:null,
    atk:null,def:null,hp:null,ranks:{},lineageForms:[],
    state:'待機',ocr:'',speciesId:null,pvp:null,candidates:[]
  }));
  $('analyze').disabled=!app.items.length;$('csv').disabled=!app.items.length;$('pip').disabled=!app.items.length;
  render();setStatus(`${app.items.length}枚読み込みました。`);
});

$('clear').onclick=()=>{
  app.items.forEach(x=>URL.revokeObjectURL(x.url));app.items=[];
  $('grid').innerHTML='';$('tbody').innerHTML='';$('summaryCard').style.display='none';
  $('files').value='';$('analyze').disabled=true;$('csv').disabled=true;$('pip').disabled=true;
  setProgress(0);setStatus('画像を選択してください。');
};
$('analyze').onclick=analyzeAll;
$('csv').onclick=downloadCSV;
$('pip').onclick=startPip;

async function loadData(){
  if(app.pvp&&app.names)return;
  const [a,b]=await Promise.all([
    fetch('https://raw.githubusercontent.com/pvpoke/pvpoke/master/src/data/gamemaster/pokemon.json',{cache:'no-store'}),
    fetch('https://raw.githubusercontent.com/motemen/pokemon-data/main/POKEMON_ALL.json',{cache:'no-store'})
  ]);
  if(!a.ok||!b.ok)throw new Error('ポケモンデータを取得できませんでした');
  app.pvp=await a.json();app.names=await b.json();
}

async function getWorker(){
  if(app.worker)return app.worker;
  app.worker=await Tesseract.createWorker('jpn+eng',1,{logger:m=>{
    if(m.status==='recognizing text')setStatus(`OCR解析中… ${Math.round((m.progress||0)*100)}%`);
  }});
  return app.worker;
}

async function analyzeAll(){
  invalidatePipVideo();
  $('analyze').disabled=true;
  try{
    await loadData();
    const worker=await getWorker();

    for(let i=0;i<app.items.length;i++){
      const it=app.items[i];
      it.state='解析中';render();setStatus(`${i+1}/${app.items.length} を解析中…`);

      const img=await loadImage(it.url);

      // CP is read only from the top-center CP label.
      const cpGuess=await recognizeCP(img,worker);
      if(Number.isInteger(cpGuess))it.cp=cpGuess;

      // Pokémon name is read only from the lower description:
      // "この○○は..."
      const desc=await recognizeDescriptionPokemonName(img,worker);
      it.ocr=desc.rawText||'';

      if(desc.name){
        const exact=findSpeciesExact(desc.name);
        if(exact){
          applySpecies(it,exact);
        }else{
          it.name=desc.name;
          it.pvp=null;
          it.speciesId=null;
          it.state='名前要確認';
        }
      }else{
        it.name='未判定';
        it.pvp=null;
        it.speciesId=null;
      }

      const iv=detectIVBarsV5(img);
      if(iv){it.atk=iv[0];it.def=iv[1];it.hp=iv[2]}

      await recalcItem(it);
      setProgress((i+1)/app.items.length);
      render();
    }

    setStatus('解析完了。名前は下部説明文、CPは画面上部のCP表示から読み取りました。未判定の名前は手入力してください。','ok');
  }catch(e){
    setStatus('解析エラー: '+e.message,'warn');
  }
  $('analyze').disabled=false;
}


async function recognizeCP(img,worker){
  const W=img.naturalWidth,H=img.naturalHeight;

  const regions=[
    [0.27,0.030,0.46,0.105],
    [0.22,0.025,0.56,0.130],
    [0.30,0.045,0.40,0.095]
  ];

  const candidates=[];

  for(const [rx,ry,rw,rh] of regions){
    for(const invert of [false,true]){
      const c=makeCPProcessedCrop(
        img,
        Math.round(W*rx),Math.round(H*ry),
        Math.round(W*rw),Math.round(H*rh),
        1500,
        invert
      );

      try{
        const {data}=await worker.recognize(c,{
          tessedit_pageseg_mode:'7',
          tessedit_char_whitelist:'CPcp0123456789 '
        });

        const txt=(data.text||'')
          .replace(/[ＯO]/g,'0')
          .replace(/[Il|]/g,'1');

        let m=txt.match(/CP\s*([0-9]{2,5})/i);

        if(!m){
          const compact=txt.replace(/\s+/g,'');
          m=compact.match(/CP([0-9]{2,5})/i);
        }

        if(m){
          const n=Number(m[1]);
          if(Number.isInteger(n)&&n>=10&&n<=10000)candidates.push(n);
        }
      }catch(e){}
    }
  }

  if(!candidates.length)return null;

  const freq=new Map();
  candidates.forEach(n=>freq.set(n,(freq.get(n)||0)+1));
  const ranked=[...freq.entries()].sort((a,b)=>b[1]-a[1] || a[0]-b[0]);

  if(ranked[0][1]>=2)return ranked[0][0];
  return candidates.length===1?candidates[0]:null;
}

function makeCPProcessedCrop(img,x,y,w,h,maxW,invert=false){
  const scale=Math.max(1,Math.min(4,maxW/w));
  const c=document.createElement('canvas');
  c.width=Math.round(w*scale);
  c.height=Math.round(h*scale);

  const ctx=c.getContext('2d');
  ctx.drawImage(img,x,y,w,h,0,0,c.width,c.height);

  const im=ctx.getImageData(0,0,c.width,c.height);
  const d=im.data;

  for(let i=0;i<d.length;i+=4){
    const gray=Math.round(d[i]*.30+d[i+1]*.59+d[i+2]*.11);
    let v=gray>180?255:gray<105?0:Math.round((gray-105)/75*255);
    if(invert)v=255-v;
    d[i]=d[i+1]=d[i+2]=v;
  }

  ctx.putImageData(im,0,0);
  return c;
}

async function recognizeDescriptionPokemonName(img,worker){
  const W=img.naturalWidth,H=img.naturalHeight;

  const regions=[
    [0.02,0.805,0.96,0.185],
    [0.02,0.770,0.96,0.220],
    [0.02,0.835,0.96,0.150]
  ];

  const rawAttempts=[];

  for(const [rx,ry,rw,rh] of regions){
    const c=makeDescriptionCrop(
      img,
      Math.round(W*rx),Math.round(H*ry),
      Math.round(W*rw),Math.round(H*rh),
      1800
    );

    try{
      const {data}=await worker.recognize(c,{tessedit_pageseg_mode:'6'});
      const raw=(data.text||'')
        .replace(/\r/g,'')
        .replace(/[ \t]+/g,' ')
        .trim();

      if(raw)rawAttempts.push(raw);

      const name=extractNameFromDescription(raw);
      if(name)return{name,rawText:raw};
    }catch(e){}
  }

  for(const raw of rawAttempts){
    const name=extractNameFromDescription(raw.replace(/\s+/g,''));
    if(name)return{name,rawText:raw};
  }

  return{name:null,rawText:rawAttempts.join('\n---\n')};
}

function extractNameFromDescription(text){
  if(!text)return null;

  const cleaned=String(text)
    .replace(/[「」『』"'“”]/g,'')
    .replace(/\s+/g,'');

  let m=cleaned.match(/この([ァ-ヶー・]{2,8})は/);

  if(!m){
    m=cleaned.match(/([ァ-ヶー・]{2,8})は(?:20\d{2}|19\d{2})[\/年]/);
  }

  if(!m)return null;

  const candidate=m[1].replace(/・+$/,'');
  return candidate.length>=2&&candidate.length<=8?candidate:null;
}

function makeDescriptionCrop(img,x,y,w,h,maxW){
  const scale=Math.max(1,Math.min(3.5,maxW/w));
  const c=document.createElement('canvas');
  c.width=Math.round(w*scale);
  c.height=Math.round(h*scale);

  const ctx=c.getContext('2d');
  ctx.drawImage(img,x,y,w,h,0,0,c.width,c.height);

  const im=ctx.getImageData(0,0,c.width,c.height);
  const d=im.data;

  for(let i=0;i<d.length;i+=4){
    const gray=Math.round(d[i]*.30+d[i+1]*.59+d[i+2]*.11);
    let v;
    if(gray>205)v=255;
    else if(gray<145)v=0;
    else v=Math.round((gray-145)/60*255);
    d[i]=d[i+1]=d[i+2]=v;
  }

  ctx.putImageData(im,0,0);
  return c;
}

function parseText(it){
  const t=(it.ocr||'').replace(/[ＯO]/g,'0');
  let m=t.match(/\bCP\s*([0-9,]+)/i);
  if(m)it.cp=Number(m[1].replace(/,/g,''));

  m=t.match(/(\d{1,3})\s*\/\s*\d{1,3}\s*HP/i);
  if(m)it.currentHp=Number(m[1]);
}

function isMega(p){
  return !!p && (
    (Array.isArray(p.tags)&&p.tags.includes('mega')) ||
    String(p.speciesId||'').includes('_mega')
  );
}

function basePvpForDex(dex){
  return app.pvp.find(x=>
    Number(x.dex)===Number(dex) &&
    !String(x.speciesId).includes('shadow') &&
    !isMega(x)
  );
}

function rowNames(row){
  return [
    row.pokeapi_species_name_ja||'',
    row.yakkuncom_name||'',
    row.pokeapi_species_name_en||'',
    row.pkmn_base_species||''
  ].filter(Boolean);
}

function findSpeciesLongestInText(text){
  const n=norm(text);let matches=[];
  for(const row of app.names){
    for(const nm of rowNames(row)){
      const nn=norm(nm);
      if(!nn)continue;
      const minLen=/[^\x00-\x7F]/.test(nm)?2:4;
      if(nn.length>=minLen && n.includes(nn)){
        const dex=Number(row.national_pokedex_number);
        const p=basePvpForDex(dex);
        if(p)matches.push({pvp:p,dex,row,matchLen:[...nn].length,name:nm});
      }
    }
  }
  matches.sort((a,b)=>b.matchLen-a.matchLen);
  return matches[0]||null;
}

function findSpeciesExact(input){
  const q=norm(input);
  if(!q)return null;

  for(const row of app.names){
    for(const nm of rowNames(row)){
      if(norm(nm)===q){
        const dex=Number(row.national_pokedex_number);
        const p=basePvpForDex(dex);
        if(p)return{pvp:p,dex,row,name:nm};
      }
    }
  }
  return null;
}

function applySpecies(it,m){
  const p=m.pvp||m;
  it.pvp=p;it.speciesId=p.speciesId;
  const dex=Number(p.dex);
  const row=app.names.find(x=>Number(x.national_pokedex_number)===dex);
  it.name=(row&&(row.pokeapi_species_name_ja||row.yakkuncom_name))||p.speciesName||p.speciesId;
}

function inferSpeciesByStats(cp,hp,a,d,h){
  const out=[],seen=new Set();

  for(const p of app.pvp){
    if(!p.baseStats||String(p.speciesId).includes('shadow')||isMega(p))continue;

    for(let i=0;i<CPMS.length;i++){
      const c=CPMS[i];
      const calc=cpAt(p,a,d,h,c);
      const calcHp=Math.floor((p.baseStats.hp+h)*c);

      if(calc===cp&&calcHp===hp){
        const key=p.speciesId+'|'+i;
        if(!seen.has(key)){
          seen.add(key);
          out.push({pvp:p,dex:Number(p.dex),level:LEVELS[i]});
        }
      }
    }
  }
  return out;
}

/*
 v6 IV bar detection.
 実際のユーザー画像 IMG_8783.jpeg で確認:
 - 攻撃バー色付き: x≈84..279
 - バー全体:       x≈84..329
 - 196 / 246 ≈ 0.797 → 12/15
 - 防御・HPは全長 → 15/15
*/
function detectIVBarsV5(img){
  const scale=Math.min(1,1000/img.naturalWidth);
  const w=Math.round(img.naturalWidth*scale);
  const h=Math.round(img.naturalHeight*scale);

  const c=document.createElement('canvas');
  c.width=w;c.height=h;
  const ctx=c.getContext('2d');
  ctx.drawImage(img,0,0,w,h);

  const id=ctx.getImageData(0,0,w,h);
  const D=id.data;

  const px=(x,y)=>{
    const k=(y*w+x)*4;
    return[D[k],D[k+1],D[k+2]];
  };

  const colored=([r,g,b])=>r>180&&(r-g)>25&&(r-b)>20&&g>50;

  const gray=([r,g,b])=>{
    const mean=(r+g+b)/3;
    const range=Math.max(r,g,b)-Math.min(r,g,b);
    return mean>195&&mean<242&&range<14;
  };

  // 評価UI位置は端末・スクショによって下側へ動くため広く探索
  const y0=Math.floor(h*.50);
  const y1=Math.floor(h*.92);

  let rows=[];

  for(let y=y0;y<y1;y++){
    let best=null,start=null,last=-1,gap=0,colorCount=0;

    for(let x=0;x<w;x++){
      const p=px(x,y);
      const isColor=colored(p);
      const good=isColor||gray(p);

      if(good){
        if(start===null){
          start=x;
          colorCount=0;
        }
        last=x;
        gap=0;
        if(isColor)colorCount++;
      }else if(start!==null){
        gap++;

        // 5/10の白い区切り線やアンチエイリアスを跨ぐ
        if(gap>12){
          const end=last;
          const len=end-start+1;

          if(len>w*.22 && colorCount>w*.055){
            const cand={start,end,colorCount};
            if(!best||len>(best.end-best.start+1))best=cand;
          }

          start=null;
          gap=0;
          colorCount=0;
        }
      }
    }

    if(start!==null){
      const end=last;
      const len=end-start+1;

      if(len>w*.22 && colorCount>w*.055){
        const cand={start,end,colorCount};
        if(!best||len>(best.end-best.start+1))best=cand;
      }
    }

    if(best)rows.push({y,...best});
  }

  if(!rows.length)return null;

  // 同一バーの複数行をまとめる
  let groups=[];

  for(const r of rows){
    if(!groups.length||r.y-groups[groups.length-1][groups[groups.length-1].length-1].y>3){
      groups.push([r]);
    }else{
      groups[groups.length-1].push(r);
    }
  }

  const reps=groups
    .filter(g=>g.length>=3)
    .map(g=>g.reduce((a,b)=>(b.end-b.start)>(a.end-a.start)?b:a));

  // 開始位置/終了位置がほぼ同じ3本を探す
  let triple=null,bestScore=Infinity;

  for(let a=0;a<reps.length;a++){
    for(let b=a+1;b<reps.length;b++){
      for(let c3=b+1;c3<reps.length;c3++){
        const t=[reps[a],reps[b],reps[c3]];
        const starts=t.map(z=>z.start);
        const ends=t.map(z=>z.end);

        const sx=Math.max(...starts)-Math.min(...starts);
        const ex=Math.max(...ends)-Math.min(...ends);
        const d1=t[1].y-t[0].y;
        const d2=t[2].y-t[1].y;

        if(sx>22||ex>22||d1<20||d2<20)continue;

        const score=sx+ex+Math.abs(d1-d2)*.35;

        if(score<bestScore){
          bestScore=score;
          triple=t;
        }
      }
    }
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

    for(let x=start;x<=end;x++){
      if(colored(px(x,r.y)))lastColor=x;
    }

    const fraction=Math.max(0,Math.min(1,(lastColor-start+1)/total));
    return Math.max(0,Math.min(15,Math.round(fraction*15)));
  });
}

function cpAt(p,a,d,h,cpm){
  const A=p.baseStats.atk+a;
  const D=p.baseStats.def+d;
  const S=p.baseStats.hp+h;
  return Math.max(10,Math.floor(A*Math.sqrt(D)*Math.sqrt(S)*cpm*cpm/10));
}

function bestUnder(p,a,d,h,cap){
  let best=null;

  for(let i=0;i<CPMS.length;i++){
    const cp=cpAt(p,a,d,h,CPMS[i]);

    if(cp<=cap){
      const c=CPMS[i];
      const A=(p.baseStats.atk+a)*c;
      const D=(p.baseStats.def+d)*c;
      const HP=Math.floor((p.baseStats.hp+h)*c);
      best={sp:A*D*HP};
    }else{
      break;
    }
  }

  return best;
}

function rankFor(p,a,d,h,cap){
  const key=p.speciesId+'|'+cap;
  let arr=app.rankCache.get(key);

  if(!arr){
    arr=[];

    for(let A=0;A<16;A++){
      for(let D=0;D<16;D++){
        for(let H=0;H<16;H++){
          const b=bestUnder(p,A,D,H,cap);
          if(b)arr.push({a:A,d:D,h:H,sp:b.sp});
        }
      }
    }

    arr.sort((x,y)=>y.sp-x.sp);
    arr.forEach((x,i)=>x.rank=i+1);
    app.rankCache.set(key,arr);
  }

  const o=arr.find(x=>x.a===a&&x.d===d&&x.h===h);
  return o?o.rank:'—';
}

function rankML(p,a,d,h){
  const key=p.speciesId+'|ML';
  let arr=app.rankCache.get(key);

  if(!arr){
    const c=CPMS[CPMS.length-1];
    arr=[];

    for(let A=0;A<16;A++){
      for(let D=0;D<16;D++){
        for(let H=0;H<16;H++){
          const atk=(p.baseStats.atk+A)*c;
          const def=(p.baseStats.def+D)*c;
          const hp=Math.floor((p.baseStats.hp+H)*c);
          arr.push({a:A,d:D,h:H,sp:atk*def*hp});
        }
      }
    }

    arr.sort((x,y)=>y.sp-x.sp);
    arr.forEach((x,i)=>x.rank=i+1);
    app.rankCache.set(key,arr);
  }

  const o=arr.find(x=>x.a===a&&x.d===d&&x.h===h);
  return o?o.rank:'—';
}

const computeRanks=(p,a,d,h)=>({
  r500:rankFor(p,a,d,h,500),
  sl:rankFor(p,a,d,h,1500),
  hl:rankFor(p,a,d,h,2500),
  ml:rankML(p,a,d,h)
});

function japaneseNameForDex(dex){
  const row=app.names.find(x=>Number(x.national_pokedex_number)===Number(dex));
  return (row&&(row.pokeapi_species_name_ja||row.yakkuncom_name))||null;
}

function dexFromSpeciesUrl(url){
  const m=String(url||'').match(/\/pokemon-species\/(\d+)\/?$/);
  return m?Number(m[1]):null;
}

function megaLabel(baseName,p){
  const id=String(p.speciesId||'').toLowerCase();
  const s=String(p.speciesName||'');

  if(id.includes('_mega_x')||/\bMega X\b/i.test(s))return `メガ${baseName}X`;
  if(id.includes('_mega_y')||/\bMega Y\b/i.test(s))return `メガ${baseName}Y`;
  return `メガ${baseName}`;
}

async function buildOrderedLineageForms(it){
  it.lineageForms=[];
  if(!it.pvp)return;

  try{
    const currentDex=Number(it.pvp.dex);

    const sr=await fetch(`https://pokeapi.co/api/v2/pokemon-species/${currentDex}/`,{cache:'no-store'});
    if(!sr.ok)return;

    const species=await sr.json();
    const cr=await fetch(species.evolution_chain.url,{cache:'no-store'});
    if(!cr.ok)return;

    const chain=await cr.json();
    let nodes=[];

    const walk=(node,depth)=>{
      const ndex=dexFromSpeciesUrl(node.species.url);
      if(ndex)nodes.push({dex:ndex,depth});
      (node.evolves_to||[]).forEach(ch=>walk(ch,depth+1));
    };

    walk(chain.chain,0);

    // 進化段階が高い順。同じ段階では図鑑番号順。
    nodes.sort((a,b)=>b.depth-a.depth || a.dex-b.dex);

    let forms=[];

    for(const n of nodes){
      const base=basePvpForDex(n.dex);
      if(!base)continue;

      const baseName=japaneseNameForDex(n.dex)||base.speciesName||base.speciesId;

      // この進化段階にメガシンカがあるなら通常形より先に並べる
      const megas=app.pvp.filter(p=>
        Number(p.dex)===Number(n.dex) &&
        isMega(p) &&
        !String(p.speciesId).includes('shadow')
      );

      // X/YはX→Yの順、それ以外はspeciesId順
      megas.sort((a,b)=>{
        const ida=String(a.speciesId||'');
        const idb=String(b.speciesId||'');
        const score=id=>{
          if(id.includes('_mega_x'))return 0;
          if(id.includes('_mega_y'))return 1;
          return 2;
        };
        return score(ida)-score(idb) || ida.localeCompare(idb);
      });

      for(const mega of megas){
        forms.push({
          kind:'メガシンカ',
          name:megaLabel(baseName,mega),
          pvp:mega,
          depth:n.depth,
          isCurrent:false,
          ranks:computeRanks(mega,it.atk,it.def,it.hp)
        });
      }

      forms.push({
        kind:n.dex===currentDex?'現在':'通常',
        name:baseName,
        pvp:base,
        depth:n.depth,
        isCurrent:n.dex===currentDex,
        ranks:computeRanks(base,it.atk,it.def,it.hp)
      });
    }

    it.lineageForms=forms;

  }catch(e){
    it.lineageForms=[];
  }
}

async function recalcItem(it){
  if(it.pvp&&[it.atk,it.def,it.hp].every(Number.isInteger)){
    it.ranks=computeRanks(it.pvp,it.atk,it.def,it.hp);
    await buildOrderedLineageForms(it);
    it.state='完了';
  }else{
    it.ranks={};
    it.lineageForms=[];
    it.state=it.candidates.length?'候補あり':'要確認';
  }
}


function megaSuffixForForm(p){
  const id=String(p?.speciesId||'').toLowerCase();
  const name=String(p?.speciesName||'');

  if(id.includes('_mega_x') || /\bMega X\b/i.test(name))return 'X';
  if(id.includes('_mega_y') || /\bMega Y\b/i.test(name))return 'Y';
  if(id.includes('_mega_z') || /\bMega Z\b/i.test(name))return 'Z';
  return 'N';
}

function getMegaFormsForItem(it){
  if(!it?.pvp || !app.pvp)return [];

  const forms=app.pvp.filter(p=>
    Number(p.dex)===Number(it.pvp.dex) &&
    isMega(p) &&
    !String(p.speciesId||'').includes('shadow')
  );

  const order={N:0,X:1,Y:2,Z:3};
  forms.sort((a,b)=>{
    const sa=megaSuffixForForm(a),sb=megaSuffixForForm(b);
    return (order[sa]??9)-(order[sb]??9) || String(a.speciesId).localeCompare(String(b.speciesId));
  });

  return forms;
}

function getMegaRankText(it,leagueKey){
  if(!it?.pvp || ![it.atk,it.def,it.hp].every(Number.isInteger))return '—';

  const forms=getMegaFormsForItem(it);
  if(!forms.length)return '—';

  return forms.map(p=>{
    const ranks=computeRanks(p,it.atk,it.def,it.hp);
    const val=ranks[leagueKey];
    if(forms.length===1)return '#'+val;
    return `${megaSuffixForForm(p)}:#${val}`;
  }).join(' / ');
}

function render(){
  $('summaryCard').style.display=app.items.length?'block':'none';

  $('tbody').innerHTML=app.items.map((it,i)=>`
    <tr>
      <td>${i+1}</td>
      <td>${esc(it.name)}</td>
      <td>${it.cp??'—'}</td>
      <td>${fmtIV(it)}</td>
      <td>${fmtRank(it.ranks.r500)}</td>
      <td>${esc(getMegaRankText(it,'r500'))}</td>
      <td>${fmtRank(it.ranks.sl)}</td>
      <td>${esc(getMegaRankText(it,'sl'))}</td>
      <td>${fmtRank(it.ranks.hl)}</td>
      <td>${esc(getMegaRankText(it,'hl'))}</td>
      <td>${fmtRank(it.ranks.ml)}</td>
      <td>${esc(getMegaRankText(it,'ml'))}</td>
      <td>${esc(it.state)}</td>
    </tr>
  `).join('');

  $('grid').innerHTML=app.items.map((it,i)=>`
    <article class="item">
      <img class="thumb" src="${it.url}">
      <div class="info">
        <div class="meta">CP ${it.cp??'—'} ・ ${esc(it.state)}</div>

        <div class="ivrow">
          ${pill('攻撃',it.atk)}
          ${pill('防御',it.def)}
          ${pill('HP',it.hp)}
        </div>

        ${renderLineage(it)}

        <div class="nameEdit">
          <input id="name-${i}" type="text" maxlength="6"
            value="${esc(it.name==='未判定'?'':it.name)}"
            placeholder="ポケモン名（最大6文字）">
          <button onclick="confirmName(${i})">名前を確定</button>
        </div>

        <div class="cpEdit">
          <span>CP</span>
          <input id="cp-${i}" type="number" inputmode="numeric" min="10" max="99999" value="${it.cp??''}" placeholder="CPを入力">
          <button onclick="confirmCP(${i})">確定</button>
        </div>

        <div class="ivEdit">
          ${ivSelect(i,'atk',it.atk)}
          ${ivSelect(i,'def',it.def)}
          ${ivSelect(i,'hp',it.hp)}
        </div>

        ${it.candidates.length>1
          ?`<div class="small">逆算候補: ${esc(it.candidates.slice(0,6).map(c=>c.pvp.speciesName).join(' / '))}</div>`
          :''
        }
      </div>
    </article>
  `).join('');
  drawPipFrame();
}

function renderLineage(it){
  if(!it.lineageForms||!it.lineageForms.length)return'';

  return `<div class="forms">
    ${it.lineageForms.map(f=>`
      <div class="formBlock">
        <div class="formTitle">
          ${esc(f.name)}
          <span class="formKind">${esc(f.kind)}</span>
          ${f.isCurrent?'<span class="currentMark">現在のポケモン</span>':''}
        </div>
        <div class="ranks">
          ${pill('500',f.ranks.r500)}
          ${pill('SL',f.ranks.sl)}
          ${pill('HL',f.ranks.hl)}
          ${pill('ML',f.ranks.ml)}
        </div>
      </div>
    `).join('')}
  </div>`;
}

function pill(l,v){
  return `<div class="pill">${l}<b>${v??'—'}</b></div>`;
}

function ivSelect(i,k,v){
  let o=`<select onchange="editIV(${i},'${k}',this.value)">
    <option value="">—</option>`;

  for(let n=0;n<=15;n++){
    o+=`<option ${v===n?'selected':''}>${n}</option>`;
  }

  return o+'</select>';
}

function fmtIV(it){
  return[it.atk,it.def,it.hp].every(Number.isInteger)
    ?`${it.atk}/${it.def}/${it.hp}`
    :'—';
}

function fmtRank(v){
  return v==null?'—':'#'+v;
}

window.confirmName=async i=>{
  invalidatePipVideo();
  const it=app.items[i];
  const el=$(`name-${i}`);
  const v=[...(el?.value||'')].slice(0,6).join('');

  if(!v){
    setStatus('ポケモン名を入力してください。','warn');
    return;
  }

  const m=findSpeciesExact(v);

  if(!m){
    it.name=v;
    it.pvp=null;
    it.speciesId=null;
    it.ranks={};
    it.lineageForms=[];
    it.state='名前要確認';
    render();
    setStatus(`「${v}」は完全一致で見つかりませんでした。`,'warn');
    return;
  }

  applySpecies(it,m);
  await recalcItem(it);
  render();
  setStatus(`${it.name}として確定しました。`,'ok');
};

window.confirmCP=async i=>{
  invalidatePipVideo();
  const it=app.items[i];
  const el=$(`cp-${i}`);
  const v=Number(el?.value);

  if(!Number.isFinite(v)||v<10){
    setStatus('CPを正しく入力してください。','warn');
    return;
  }

  it.cp=Math.floor(v);
  await retryResolve(i,true);
  render();
  drawPipFrame();
  setStatus(`CP ${it.cp} に更新しました。`,'ok');
};

window.editIV=async(i,k,v)=>{
  invalidatePipVideo();
  app.items[i][k]=v===''?null:Number(v);
  await retryResolve(i,true);
  render();
};

async function retryResolve(i,allowInference){
  const it=app.items[i];
  await recalcItem(it);
}

function loadImage(url){
  return new Promise((res,rej)=>{
    const i=new Image;
    i.onload=()=>res(i);
    i.onerror=rej;
    i.src=url;
  });
}

function makeCrop(img,x,y,w,h,maxW){
  const s=Math.min(1,maxW/w);
  const c=document.createElement('canvas');
  c.width=Math.round(w*s);
  c.height=Math.round(h*s);
  c.getContext('2d').drawImage(img,x,y,w,h,0,0,c.width,c.height);
  return c;
}

function setStatus(t,cls=''){
  $('status').className='status '+cls;
  $('status').textContent=t;
}

function setProgress(v){
  $('bar').style.width=Math.round(v*100)+'%';
}




function invalidatePipVideo(){
  const wrap=$('pipPreviewWrap');
  const v=$('pipVideo');

  if(wrap)wrap.style.display='none';

  if(v){
    try{v.pause()}catch(e){}
    v.removeAttribute('src');
    try{v.load()}catch(e){}
  }

  if(pipVideoURL){
    URL.revokeObjectURL(pipVideoURL);
    pipVideoURL=null;
  }
}

let pipVideoURL=null;
let pipPreparing=false;

function buildSummaryRows(){
  return app.items.map((it,i)=>({
    no:i+1,
    name:it.name||'未判定',
    cp:it.cp??'—',
    iv:[it.atk,it.def,it.hp].every(Number.isInteger)?`${it.atk}/${it.def}/${it.hp}`:'—',
    r500:it.ranks?.r500??'—',
    m500:getMegaRankText(it,'r500'),
    sl:it.ranks?.sl??'—',
    msl:getMegaRankText(it,'sl'),
    hl:it.ranks?.hl??'—',
    mhl:getMegaRankText(it,'hl'),
    ml:it.ranks?.ml??'—',
    mml:getMegaRankText(it,'ml')
  }));
}

function getPipPages(){
  const rows=buildSummaryRows();
  const pages=[];

  for(let i=0;i<rows.length;i+=5){
    const batch=rows.slice(i,i+5);

    pages.push({type:'A',rows:batch});
    pages.push({type:'B',rows:batch});
  }

  if(!pages.length){
    pages.push({type:'A',rows:[]});
    pages.push({type:'B',rows:[]});
  }

  return pages;
}

function drawSinglePipPage(ctx,page,x,pageW,pageH){
  const pad=28;
  const tableX=x+pad;
  const headerY=72;
  const rowStart=165;
  const rowH=98;

  ctx.fillStyle='#070b10';
  ctx.fillRect(x,0,pageW,pageH);

  ctx.fillStyle='#ffffff';
  ctx.font='800 30px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  ctx.textBaseline='middle';
  ctx.fillText(
    page.type==='A' ? 'Pokémon GO IV ① 500 / SL' : 'Pokémon GO IV ② HL / ML',
    tableX,28
  );

  let widths,headers;

  if(page.type==='A'){
    widths=[60,205,90,135,92,190,92,190];
    headers=['No.','ポケモン','CP','IV','500','500メガ','SL','SLメガ'];
  }else{
    widths=[60,235,110,200,110,200];
    headers=['No.','ポケモン','HL','HLメガ','ML','MLメガ'];
  }

  let hx=tableX;
  ctx.font='700 22px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

  headers.forEach((h,i)=>{
    ctx.fillStyle='#9eabb9';
    ctx.fillText(h,hx+6,headerY);
    hx+=widths[i];
  });

  ctx.fillStyle='#2c3745';
  ctx.fillRect(tableX,110,pageW-pad*2,2);

  for(let r=0;r<5;r++){
    const row=page.rows[r];
    const y=rowStart+r*rowH;

    if(r>0){
      ctx.fillStyle='#1d2631';
      ctx.fillRect(tableX,y-rowH/2,pageW-pad*2,1);
    }

    if(!row)continue;

    let vals;

    if(page.type==='A'){
      vals=[
        String(row.no),
        row.name,
        String(row.cp),
        row.iv,
        row.r500==='—'?'—':'#'+row.r500,
        row.m500,
        row.sl==='—'?'—':'#'+row.sl,
        row.msl
      ];
    }else{
      vals=[
        String(row.no),
        row.name,
        row.hl==='—'?'—':'#'+row.hl,
        row.mhl,
        row.ml==='—'?'—':'#'+row.ml,
        row.mml
      ];
    }

    let xx=tableX;

    vals.forEach((v,i)=>{
      const isName=i===1;
      const megaCol=page.type==='A'
        ? [5,7].includes(i)
        : [3,5].includes(i);

      ctx.fillStyle=isName?'#ffffff':'#e2e8ef';

      const fontSize=megaCol ? 20 : (isName ? 26 : 23);
      ctx.font=(isName?'800 ':'700 ')+fontSize+'px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

      // prevent long mega strings from visually colliding with next column
      const colWidth=widths[i];
      let text=String(v);

      if(megaCol && text.length>18){
        text=text.replace(' / ','/');
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(xx+4,y-35,colWidth-8,70);
      ctx.clip();
      ctx.fillText(text,xx+6,y);
      ctx.restore();

      xx+=colWidth;
    });
  }
}

function drawPipFrameAt(offset){
  const c=$('pipCanvas');
  if(!c)return;

  const ctx=c.getContext('2d');
  const pages=getPipPages();
  const pageW=c.width;
  const pageH=c.height;
  const totalW=pages.length*pageW;

  ctx.fillStyle='#070b10';
  ctx.fillRect(0,0,pageW,pageH);

  // Draw enough copies for a seamless loop.
  for(let loop=0;loop<2;loop++){
    for(let i=0;i<pages.length;i++){
      const x=(i*pageW)+(loop*totalW)-offset;
      if(x>pageW || x+pageW<0)continue;
      drawSinglePipPage(ctx,pages[i],x,pageW,pageH);
    }
  }
}

function drawPipFrame(){
  drawPipFrameAt(0);
}

function chooseRecorderMime(){
  const types=[
    'video/mp4;codecs=h264',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];

  for(const t of types){
    if(window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t))return t;
  }
  return '';
}

async function buildPipVideo(){
  if(pipPreparing)return false;

  const c=$('pipCanvas');
  const v=$('pipVideo');

  if(!window.MediaRecorder || !c.captureStream){
    setStatus('このSafariではPiP動画の生成機能が利用できません。','warn');
    return false;
  }

  pipPreparing=true;
  $('pip').disabled=true;
  setStatus('PiP用動画を作成中… 件数に応じて数秒〜十数秒かかります。');

  try{
    const stream=c.captureStream(30);
    const mime=chooseRecorderMime();
    const recorder=mime?new MediaRecorder(stream,{mimeType:mime}):new MediaRecorder(stream);
    const chunks=[];

    recorder.ondataavailable=e=>{
      if(e.data && e.data.size)chunks.push(e.data);
    };

    const done=new Promise((resolve,reject)=>{
      recorder.onerror=e=>reject(e.error||new Error('MediaRecorder error'));
      recorder.onstop=()=>resolve();
    });

    recorder.start(250);

    const pages=getPipPages();
    const pageW=c.width;
    const total=pages.length*pageW;

    // 3.2 sec per subpage. Each 5-Pokémon batch has page A then B.
    const duration=Math.max(6400,pages.length*3200);
    const start=performance.now();

    await new Promise(resolve=>{
      function frame(now){
        const elapsed=now-start;
        const progress=Math.min(1,elapsed/duration);
        const offset=(progress*total)%total;
        drawPipFrameAt(offset);

        if(elapsed<duration){
          requestAnimationFrame(frame);
        }else{
          resolve();
        }
      }
      requestAnimationFrame(frame);
    });

    recorder.stop();
    await done;

    stream.getTracks().forEach(t=>t.stop());

    if(!chunks.length)throw new Error('動画データを生成できませんでした');

    const type=recorder.mimeType || mime || 'video/mp4';
    const blob=new Blob(chunks,{type});

    if(pipVideoURL)URL.revokeObjectURL(pipVideoURL);
    pipVideoURL=URL.createObjectURL(blob);

    v.srcObject=null;
    v.src=pipVideoURL;
    v.muted=true;
    v.loop=true;
    v.playsInline=true;

    $('pipPreviewWrap').style.display='block';

    await v.load?.();

    try{
      await v.play();
    }catch(e){
      // controls are visible; user can tap play if Safari blocks it
    }

    setStatus('PiP準備完了。動画を再生したままSafariからPokémon GOへ移動してください。自動PiPにならない場合は動画のPiPアイコンを1回押してください。','ok');
    return true;

  }catch(e){
    setStatus('PiP動画の準備に失敗しました: '+(e?.message||e),'warn');
    return false;
  }finally{
    pipPreparing=false;
    $('pip').disabled=!app.items.length;
  }
}

async function startPip(){
  await buildPipVideo();
}

// Browser permits this only in some contexts. It is a best-effort fallback;
// the primary iPhone path is playing a normal Blob-backed <video> and leaving Safari.
document.addEventListener('visibilitychange',async()=>{
  if(document.visibilityState!=='hidden')return;

  const v=$('pipVideo');
  if(!v || !v.src || v.paused)return;

  try{
    if(v.webkitSupportsPresentationMode &&
       v.webkitSupportsPresentationMode('picture-in-picture') &&
       v.webkitPresentationMode!=='picture-in-picture'){
      v.webkitSetPresentationMode('picture-in-picture');
    }else if(document.pictureInPictureEnabled &&
             v.requestPictureInPicture &&
             !document.pictureInPictureElement){
      await v.requestPictureInPicture();
    }
  }catch(e){
    // iOS may reject non-user-gesture PiP. In that case system automatic PiP
    // or the native video PiP control remains the fallback.
  }
});

function downloadCSV(){
  const rows=[[
    'No','Pokemon','CP','Attack','Defense','HP',
    '500','500 Mega','SL','SL Mega','HL','HL Mega','ML','ML Mega','State'
  ]];

  app.items.forEach((it,i)=>{
    rows.push([
      i+1,it.name,it.cp??'',
      it.atk??'',it.def??'',it.hp??'',
      it.ranks.r500??'',getMegaRankText(it,'r500'),
      it.ranks.sl??'',getMegaRankText(it,'sl'),
      it.ranks.hl??'',getMegaRankText(it,'hl'),
      it.ranks.ml??'',getMegaRankText(it,'ml'),
      it.state
    ]);
  });

  const csv='\ufeff'+rows.map(r=>
    r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')
  ).join('\n');

  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download='pokemon_go_iv_results_v6_7.csv';
  a.click();
}
