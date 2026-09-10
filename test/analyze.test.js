global.self = global;
require('../lib/analyze.js');
const {buildAnalysis} = global.T3D;
const P=new Float32Array([0,0,0,1,0,0,1,1,0,0,1,0,0,0,1,1,0,1,1,1,1,0,1,1]);
const cube=[4,5,6,4,6,7,1,0,3,1,3,2,0,4,7,0,7,3,5,1,2,5,2,6,0,1,5,0,5,4,3,7,6,3,6,2];
let pass=0,fail=0;
function t(name,cond,got){ if(cond){pass++;console.log('PASS  '+name);} else {fail++;console.log('FAIL  '+name+'  got '+JSON.stringify(got));} }

// 回归测试：v1 已经做对的每一项，现在都必须依然成立
let r=buildAnalysis(P,new Uint32Array(cube));
t('closed cube clean', r.holes===0&&r.flippedTris===0&&r.islands===1&&r.degenerate===0&&!r.insideOut, r);
t('cube dims 1x1x1', r.dims.every(d=>Math.abs(d-1)<1e-6), r.dims);

r=buildAnalysis(P,new Uint32Array(cube.slice(0,30)));
t('one face removed -> 1 hole of 4 edges', r.holes===1&&r.largestHole===4&&r.boundaryEdgeCount===4, {h:r.holes,l:r.largestHole});

const f=cube.slice(); f[1]=6; f[2]=5;
t('one tri flipped', buildAnalysis(P,new Uint32Array(f)).flippedTris===1, null);

const inv=[]; for(let i=0;i<cube.length;i+=3) inv.push(cube[i],cube[i+2],cube[i+1]);
t('inside out detected', buildAnalysis(P,new Uint32Array(inv)).insideOut===true, null);

// --- 新增的指标 ---
// 重复面
r=buildAnalysis(P,new Uint32Array(cube.concat([4,5,6])));
t('duplicate face found', r.duplicateFaces===1, r.duplicateFaces);

// 退化面依旧与重复面分开计数
r=buildAnalysis(P,new Uint32Array(cube.concat([2,2,3])));
t('degenerate not counted as dup', r.degenerate===1&&r.duplicateFaces===0, {d:r.degenerate,u:r.duplicateFaces});

// sliver（细长三角形）：极其扁平的三角形
const SP=new Float32Array([0,0,0, 1,0,0, 0.5,0.0001,0]);
r=buildAnalysis(SP,new Uint32Array([0,1,2]));
t('sliver detected', r.slivers===1&&r.degenerate===0, {s:r.slivers,d:r.degenerate});
// 而等边三角形不是 sliver
const EQ=new Float32Array([0,0,0, 1,0,0, 0.5,0.866,0]);
t('equilateral is not a sliver', buildAnalysis(EQ,new Uint32Array([0,1,2])).slivers===0, null);

// 孤立顶点
const OP=new Float32Array([0,0,0,1,0,0,0,1,0, 9,9,9]);
t('orphan vertex found', buildAnalysis(OP,new Uint32Array([0,1,2])).unusedVerts===1, null);

// 洞的大小：一个 3 条边的针孔与一个更大的边界环，两者同时存在
// 移除 2 个相对的面，构造出带两个独立边界环的条带
const two=cube.slice(0,24).concat(cube.slice(30));  // 去掉第 5 个面（右侧），其余保留
r=buildAnalysis(P,new Uint32Array(two));
t('multiple holes sized & sorted', r.holes>=1 && r.holeSizes[0]>=r.holeSizes[r.holeSizes.length-1], r.holeSizes);

// 游离孤岛：大立方体 + 1 个远处的小三角形
const bigP=new Float32Array(P.length+9); bigP.set(P,0);
bigP.set([50,50,50, 50.01,50,50, 50,50.01,50], P.length);
r=buildAnalysis(bigP,new Uint32Array(cube.concat([8,9,10])));
t('stray island counted', r.islands===2&&r.strayIslands===1, {i:r.islands,s:r.strayIslands});
t('island sizes sorted desc', r.islandTris[0]===12&&r.islandTris[1]===1, r.islandTris);

// 轴心 / 地面
r=buildAnalysis(P,new Uint32Array(cube));
t('pivot offset reported', r.pivotOffset>0.4&&r.pivotOffset<0.6, r.pivotOffset);
t('rests on ground', r.restsOnGround===true, r.restsOnGround);
const off=new Float32Array(P.length); for(let i=0;i<P.length;i+=3){off[i]=P[i];off[i+1]=P[i+1]+40;off[i+2]=P[i+2];}
t('floating mesh not on ground', buildAnalysis(off,new Uint32Array(cube)).restsOnGround===false, null);

// 接缝拆分出的顶点依然能被正确焊接
const uP=[],uI=[]; for(let i=0;i<cube.length;i++){const v=cube[i];uP.push(P[v*3],P[v*3+1],P[v*3+2]);uI.push(i);}
r=buildAnalysis(new Float32Array(uP),new Uint32Array(uI));
t('seam-split welds closed', r.holes===0&&r.weldedCount===8, {h:r.holes,w:r.weldedCount});


/* 可见的洞：同一个 mesh 上一个大洞和一个极小的洞。

   没有顶盖的立方体有一个由 4 条边组成的洞；旁边是一个 4x4 的平面，
   它的边界有 16 条边。两者都是洞，但只有其中一个会被人注意到。
   计数放在 analyze.js 里而不是更晚，因为 holeSizes 为了显示被截断
   到十二条 — 洞更多时，从中挑出来的一部分根本就是错的。 */
const zwei=(()=>{
  const pos=Array.from(P), idx=cube.slice(0,30);   // 缺一个面的立方体
  const b=pos.length/3;
  for(let i=0;i<=4;i++)for(let j=0;j<=4;j++) pos.push(j,i,10);  // 平面，位于远处
  for(let i=0;i<4;i++)for(let j=0;j<4;j++){
    const a=b+i*5+j;
    idx.push(a,a+5,a+1, a+1,a+5,a+6);
  }
  return {pos:new Float32Array(pos), idx:new Uint32Array(idx)};
})();

r=buildAnalysis(zwei.pos,zwei.idx);
t('zwei Loecher, 16 und 4 Kanten', r.holes===2&&r.largestHole===16&&r.holeSizes.join()==='16,4', {h:r.holes,s:r.holeSizes});
t('ohne Schwelle zaehlen beide', r.holesBig===2, r.holesBig);

r=buildAnalysis(zwei.pos,zwei.idx,{minHoleEdges:6});
t('Schwelle 6 laesst nur das grosse gelten', r.holesBig===1&&r.holes===2, {b:r.holesBig,h:r.holes});
t('die Schwelle steht im Ergebnis', r.minHoleEdges===6, r.minHoleEdges);

/* 报告里不提的东西，viewer 也不许画出来：否则面板数出一个洞，
   而画面里却亮着两个。 */
t('die Kantenanzeige folgt derselben Schwelle', r.boundaryEdgesBig.length===32&&r.boundaryEdges.length===40, {g:r.boundaryEdgesBig.length,a:r.boundaryEdges.length});

r=buildAnalysis(zwei.pos,zwei.idx,{minHoleEdges:20});
t('Schwelle 20 laesst keines gelten', r.holesBig===0, r.holesBig);
t('und dann bleibt die Anzeige leer', r.boundaryEdgesBig.length===0, r.boundaryEdgesBig.length);

r=buildAnalysis(zwei.pos,zwei.idx);
t('ohne Schwelle wird nichts weggelassen', r.boundaryEdgesBig.length===r.boundaryEdges.length, r.boundaryEdgesBig.length);
t('und dann gibt es nichts Kleines', r.boundaryEdgesSmall.length===0, r.boundaryEdgesSmall.length);

/* 切换开关把两个集合前后相接地放进同一个缓冲区。若其中丢了一条边，
   或者有一条边出现了两次，viewer 在 "All holes" 下画出的东西就与
   mesh 实际拥有的不同 — 而且没人会察觉，因为叠在一起的线看起来
   完全一样。所以这里立下一个硬性保证。 */
[0,4,6,10,20].forEach(function(s){
  const q=buildAnalysis(zwei.pos,zwei.idx,{minHoleEdges:s});
  const zus=q.boundaryEdgesBig.length+q.boundaryEdgesSmall.length;
  t('Schwelle '+s+': gross + klein ergibt genau alle Kanten', zus===q.boundaryEdges.length, {zus:zus,alle:q.boundaryEdges.length});
  const paare=a=>{const o=[];for(let i=0;i<a.length;i+=2)o.push(a[i]+"-"+a[i+1]);return o;};
  const zusammen=paare(q.boundaryEdgesBig).concat(paare(q.boundaryEdgesSmall)).sort();
  t('Schwelle '+s+': keine Kante doppelt, keine fehlt', JSON.stringify(zusammen)===JSON.stringify(paare(q.boundaryEdges).sort()), zusammen.length);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
process.exitCode = fail ? 1 : 0;
