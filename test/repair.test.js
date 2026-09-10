global.self = global;
const D=require('path').join(__dirname,'..')+'/';
['analyze','parsers','inspect','repair','settings','verdict'].forEach(f=>require(D+'lib/'+f+'.js'));
const T=global.T3D;
let pass=0,fail=0;
const t=(n,c,g)=>{ c?(pass++,console.log('PASS  '+n)):(fail++,console.log('FAIL  '+n+' :: '+JSON.stringify(g))); };

function buildGLB(pos, idx){
  const posB=Buffer.alloc(pos.length*4); pos.forEach((v,i)=>posB.writeFloatLE(v,i*4));
  const idxB=Buffer.alloc(idx.length*4); idx.forEach((v,i)=>idxB.writeUInt32LE(v,i*4));
  const pad=b=>Buffer.concat([b,Buffer.alloc((4-(b.length%4))%4)]);
  const bin=Buffer.concat([pad(posB),pad(idxB)]);
  const j={asset:{version:"2.0"},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],
    materials:[{name:"KeepMe"}],
    meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0,mode:4}]}],
    accessors:[{bufferView:0,componentType:5126,count:pos.length/3,type:"VEC3"},
               {bufferView:1,componentType:5125,count:idx.length,type:"SCALAR"}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:posB.length},
                 {buffer:0,byteOffset:pad(posB).length,byteLength:idxB.length}],
    buffers:[{byteLength:bin.length}]};
  let jb=Buffer.from(JSON.stringify(j)); while(jb.length%4) jb=Buffer.concat([jb,Buffer.from(' ')]);
  const ch=(b,ty)=>{const h=Buffer.alloc(8);h.writeUInt32LE(b.length,0);h.writeUInt32LE(ty,4);return Buffer.concat([h,b]);};
  const c0=ch(jb,0x4E4F534A),c1=ch(bin,0x004E4942);
  const hd=Buffer.alloc(12);hd.writeUInt32LE(0x46546C67,0);hd.writeUInt32LE(2,4);hd.writeUInt32LE(12+c0.length+c1.length,8);
  const all=Buffer.concat([hd,c0,c1]);
  return all.buffer.slice(all.byteOffset, all.byteOffset+all.byteLength);
}

const P=[0,0,0,1,0,0,1,1,0,0,1,0,0,0,1,1,0,1,1,1,1,0,1,1];
const cube=[4,5,6,4,6,7,1,0,3,1,3,2,0,4,7,0,7,3,5,1,2,5,2,6,0,1,5,0,5,4,3,7,6,3,6,2];

// 先把整个立方体翻成里朝外，再把 3 个面翻回去，让它们与（错误的）多数派
// 相矛盾。这正是一刀切的全体翻转修不好的那种情形。
let idx=[]; for(let i=0;i<cube.length;i+=3) idx.push(cube[i],cube[i+2],cube[i+1]);
[0,4,9].forEach(f=>{ const x=idx[f*3+1]; idx[f*3+1]=idx[f*3+2]; idx[f*3+2]=x; });

const ab=buildGLB(P,idx);
const m=T.parseGLB(ab);
const an=T.buildAnalysis(m.positions,m.indices);
console.log(`before: insideOut ${an.insideOut}, flipped ${an.flippedTris}`);
t('combined defect detected', an.insideOut===true && an.flippedTris===3, {i:an.insideOut,f:an.flippedTris});

const r=T.repairWinding(m,an.flippedFlags,an.insideOut);
const m2=T.parseGLB(r.buffer);
const a2=T.buildAnalysis(m2.positions,m2.indices);
console.log(`after : insideOut ${a2.insideOut}, flipped ${a2.flippedTris}, patched ${r.patched} of ${an.triCount}`);
t('XOR repair fixes both at once', a2.insideOut===false && a2.flippedTris===0, {i:a2.insideOut,f:a2.flippedTris});
t('patched the complement, not all 12', r.patched===9, r.patched);
t('material preserved', m2.glb.json.materials[0].name==='KeepMe', null);

// 回归测试：简单情形依然能正常工作
const pureInv=[]; for(let i=0;i<cube.length;i+=3) pureInv.push(cube[i],cube[i+2],cube[i+1]);
let mm=T.parseGLB(buildGLB(P,pureInv)), aa=T.buildAnalysis(mm.positions,mm.indices);
let rr=T.repairWinding(mm,aa.flippedFlags,aa.insideOut);
let a3=T.buildAnalysis(...(()=>{const x=T.parseGLB(rr.buffer);return[x.positions,x.indices];})());
t('pure inside-out still fixed', !a3.insideOut&&a3.flippedTris===0, a3);

const local=cube.slice(); local[1]=6; local[2]=5;
mm=T.parseGLB(buildGLB(P,local)); aa=T.buildAnalysis(mm.positions,mm.indices);
rr=T.repairWinding(mm,aa.flippedFlags,aa.insideOut);
a3=T.buildAnalysis(...(()=>{const x=T.parseGLB(rr.buffer);return[x.positions,x.indices];})());
t('pure local flip still fixed', !a3.insideOut&&a3.flippedTris===0, a3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
process.exitCode = fail ? 1 : 0;
