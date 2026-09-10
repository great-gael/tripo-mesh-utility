global.self = global;
const D=require('path').join(__dirname,'..')+'/';
require(D+'lib/analyze.js'); require(D+'lib/parsers.js'); require(D+'lib/inspect.js');
const T=global.T3D, fs=require('fs');
const load=p=>{const b=fs.readFileSync(p);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};

let pass=0,fail=0;
const t=(n,c,g)=>{ c?(pass++,console.log('PASS  '+n)):(fail++,console.log('FAIL  '+n+'  got '+JSON.stringify(g))); };

const m = T.parseGLB(load(require('path').join(__dirname,'fixtures')+'/textured.glb'));
const ins = T.inspect(m, T.readAccessor);
console.log(JSON.stringify({materials:ins.materials, names:ins.materialNames, images:ins.images,
  maxTexture:ins.maxTexture, normalMap:ins.hasNormalMap, hasUV:ins.hasUV,
  coverage:+ins.uvCoverage.toFixed(3), overlap:+ins.uvOverlap.toFixed(3),
  outOfRange:ins.uvOutOfRange}, null, 1));

t('material read', ins.materials===1 && ins.materialNames[0]==='TripoPBR', ins.materialNames);
t('png dims from header', ins.images[0].w===512 && ins.images[0].h===256, ins.images[0]);
t('normal map flagged', ins.hasNormalMap===true, null);
t('texture bytes counted', ins.textureBytes>0, ins.textureBytes);
t('UV coverage ~50%', Math.abs(ins.uvCoverage-0.5)<0.03, ins.uvCoverage);
t('no false overlap', ins.uvOverlap<0.02, ins.uvOverlap);
t('UVs in range', ins.uvOutOfRange===0, ins.uvOutOfRange);

// 完全没有 UV 的网格
const bare = T.parseGLB(load(require('path').join(__dirname,'fixtures')+'/inverted.glb'));
const ins2 = T.inspect(bare, T.readAccessor);
t('missing UVs flagged', ins2.hasUV===false && ins2.uvMissingPrims===1, {u:ins2.hasUV,m:ins2.uvMissingPrims});

// jpeg 文件头解析
const jpg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb004300'+'ff'.repeat(0)+
  '', 'hex');
const sof = Buffer.concat([Buffer.from('ffd8','hex'), Buffer.from('ffc0001108','hex'),
  Buffer.from([0x04,0x00, 0x08,0x00]), Buffer.from('03','hex')]);
const got = T.imageSize(new Uint8Array(sof));
t('jpeg dims from SOF0', got && got.w===2048 && got.h===1024, got);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
process.exitCode = fail ? 1 : 0;
