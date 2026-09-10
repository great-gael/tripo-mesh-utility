global.self = global;
const D=require('path').join(__dirname,'..')+'/';
['analyze','parsers','inspect','repair','settings','verdict'].forEach(f=>require(D+'lib/'+f+'.js'));
const T=global.T3D, cfg=T.settings.DEFAULTS;
let pass=0,fail=0;
const t=(n,c,g)=>{ c?(pass++,console.log('PASS  '+n)):(fail++,console.log('FAIL  '+n+' :: '+JSON.stringify(g))); };

// 闭合球体，缠绕方向朝外，两极已处理过，因此没有退化三角形。
function sphere(seg){
  const pos=[],idx=[];
  for(let i=0;i<=seg;i++)for(let j=0;j<=seg*2;j++){
    const th=i/seg*Math.PI, ph=j/(seg*2)*2*Math.PI;
    pos.push(Math.sin(th)*Math.cos(ph),Math.cos(th),Math.sin(th)*Math.sin(ph));
  }
  const w=seg*2+1;
  for(let i=0;i<seg;i++)for(let j=0;j<seg*2;j++){
    const a=i*w+j,b=a+1,c=a+w,d=c+1;
    if(i>0)      idx.push(a,b,c);
    if(i<seg-1)  idx.push(b,d,c);
  }
  return {positions:new Float32Array(pos), indices:idx};
}
const S=sphere(60);
const A=idx=>T.buildAnalysis(S.positions,new Uint32Array(idx),{sliverQ:cfg.sliverQ});
const V=(an,c)=>T.verdict.decide(an,{hasGLTF:false},c||cfg);

let an=A(S.indices);
console.log(`sphere: ${an.triCount} tris, ${an.totalEdges} edges, degen ${an.degenerate}, holes ${an.holes}, insideOut ${an.insideOut}`);
t('sphere is closed & outward', an.holes===0&&an.degenerate===0&&!an.insideOut, {h:an.holes,d:an.degenerate,i:an.insideOut});
t('closed sphere reads clean', V(an).level==='clean', V(an));

let small=S.indices.slice(); small.splice(0,6);
an=A(small);
console.log(`small hole : ${an.largestHole}-edge, open ${(an.openRatio*100).toFixed(3)}% -> ${V(an).chip}`);
t('small hole = minor', V(an).level==='minor', V(an));

let big=S.indices.slice(); big.splice(0,60*6);
an=A(big);
console.log(`big hole   : ${an.largestHole}-edge, open ${(an.openRatio*100).toFixed(3)}% -> ${V(an).chip}`);
t('big hole = re-roll', V(an).level==='reroll', V(an));

// 在缠绕正确的球体上散布若干反转的面
let inv=S.indices.slice();
const picks=[];
for(let k=0;k<40;k++){ const t3=(k*181)%(inv.length/3); picks.push(t3); const x=inv[t3*3+1]; inv[t3*3+1]=inv[t3*3+2]; inv[t3*3+2]=x; }
an=A(inv);
console.log(`40 inverted: found ${an.flippedTris}, ${(an.flippedTris/an.triCount*100).toFixed(2)}% -> ${V(an).chip}`);
t('finds exactly 40', an.flippedTris===40, an.flippedTris);
t('0.28% inverted = minor', V(an).level==='minor', V(an));

let inv2=S.indices.slice();
const n=Math.floor(inv2.length/3*0.05);
for(let k=0;k<n;k++){ const x=inv2[k*3+1]; inv2[k*3+1]=inv2[k*3+2]; inv2[k*3+2]=x; }
an=A(inv2);
console.log(`5% inverted: found ${an.flippedTris} -> ${V(an).chip}`);
t('5% inverted = re-roll', V(an).level==='reroll', V(an));
t('lax threshold changes the call', V(an,Object.assign({},cfg,{rerollFlipPercent:20})).level!=='reroll', null);


/* 一个没有参照量的数目不是判断。

   Tripo 那个有 1,9 Mio. 三角形的模型只有 1 个洞和 2 条 non-manifold 边，
   却得到了 "Re-roll this generation"。阈值定在零，工具对每一个高密度
   mesh 都说同一句话，作为决策依据毫无价值。这与上面在开放边那里
   已经警告过的，是同一个量纲错误。 */
function basis(ueber){
  const a={ triCount:100, vertCount:60, weldedCount:60, unusedVerts:0, degenerate:0,
    slivers:0, duplicateFaces:0, totalEdges:150, boundaryEdgeCount:0, openRatio:0,
    holes:0, largestHole:0, nonManifold:0, inconsistentEdges:0, orientContradictions:0,
    windingUnstable:false, flippedTris:0, insideOut:false, islands:1, strayIslands:0 };
  for(const k in ueber) a[k]=ueber[k];
  return a;
}

const gross=T.verdict.decide(basis({triCount:1906449,totalEdges:2859673,nonManifold:2,holes:1}),{hasGLTF:false},cfg);
t('2 von 2,9 Mio. Kanten sind kein Re-roll', gross.level!=='reroll', gross.level+' :: '+gross.why);
t('werden aber als Warnung genannt', JSON.stringify(gross.warnings).indexOf('non-manifold')!==-1, gross.warnings);

const klein=T.verdict.decide(basis({triCount:12,totalEdges:18,nonManifold:2}),{hasGLTF:false},cfg);
t('2 von 18 Kanten bleiben ein Re-roll', klein.level==='reroll', klein.level+' :: '+klein.why);

const aus=Object.assign({},cfg,{failNonManifold:false});
const abgeschaltet=T.verdict.decide(basis({triCount:12,totalEdges:18,nonManifold:2}),{hasGLTF:false},aus);
t('abgeschaltet bleibt abgeschaltet', abgeschaltet.level!=='reroll', abgeschaltet.level);


/* 只统计看得见的洞。

   由三条边构成的洞是文件里的缺陷，却不是有人看得见的缺陷。在 Tripo
   的斧头上，35 个洞里有 17 个不足六条边 — 谁把两者一样计数，就会在
   几乎每一个生成的 mesh 上报出两位数，也因此被人无视。 */
const wenigeSichtbar=T.verdict.decide(basis({holes:12,holesBig:2}),{hasGLTF:false},cfg);
t('12 Loecher, davon 2 sichtbar: kein Re-roll', wenigeSichtbar.level!=='reroll', wenigeSichtbar.level+' :: '+wenigeSichtbar.why);

const alleSichtbar=T.verdict.decide(basis({holes:12,holesBig:12}),{hasGLTF:false},cfg);
t('12 sichtbare Loecher: Re-roll', alleSichtbar.level==='reroll', alleSichtbar.level+' :: '+alleSichtbar.why);
t('die Begruendung nennt die sichtbare Zahl', alleSichtbar.why.indexOf('12 holes')!==-1, alleSichtbar.why);

/* 缺少这个新字段的分析结果来自较早的版本，不许悄无声息地变成零个
   可见的洞。 */
t('ohne holesBig gilt die Gesamtzahl', T.verdict.decide(basis({holes:12}),{hasGLTF:false},cfg).level==='reroll', 'faellt nicht zurueck');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
process.exitCode = fail ? 1 : 0;
