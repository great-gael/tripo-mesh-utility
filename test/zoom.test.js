/* 缩放在 Firefox 里一动不动，而原因并不是它根本不存在。

   `wheel` 对同一个滚轮档位的报告在各浏览器里完全不同：Chrome 用
   像素（deltaMode 0，deltaY 100），Firefox 用行（deltaMode 1，
   deltaY 3）。旧的处理函数把 deltaY 原样乘以 0.0012 — 在 Chrome 里
   每档 12,75 %，在 Firefox 里 0,36 %。这不是缩放慢，这是压根没有缩放：
   要得到三倍的系数需要 315 档。这种错误，在不对的浏览器里做任何
   目视检查都发现不了，而且看上去就像缺了一个功能。 */
global.self = global;
require('../lib/viewer.js');
const {radRasten} = global.T3D;
let pass=0,fail=0;
const t=(n,c,g)=>{ c?(pass++,console.log('PASS  '+n)):(fail++,console.log('FAIL  '+n+' :: '+JSON.stringify(g))); };

t('Pixel: eine Rastung ist deltaY 100', radRasten(100,0)===1, radRasten(100,0));
t('Zeilen: eine Rastung ist deltaY 3', radRasten(3,1)===1, radRasten(3,1));
t('Seiten: eine Rastung ist deltaY 1', radRasten(1,2)===1, radRasten(1,2));
t('fehlender deltaMode gilt als Pixel', radRasten(100,undefined)===1, radRasten(100,undefined));

/* 真正的承诺在于：同一个操作在两个浏览器里的效果是一样的。没有这条
   保证，归一化可能会悄无声息地退回原样。 */
t('Chrome und Firefox ergeben dieselbe Rastung', radRasten(100,0)===radRasten(3,1), null);
t('Herauszoomen behaelt das Vorzeichen', radRasten(-100,0)===-1 && radRasten(-3,1)===-1, null);

/* 而且效果必须看得见。每档 22 % 意味着：拨几下就能看到细节，
   而不是三百下。 */
const PRO=0.2;
const proRastung=Math.exp(PRO)-1;
t('eine Rastung aendert die Entfernung um ueber 15 %', proRastung>0.15, proRastung);
const bisDreifach=Math.ceil(Math.log(3)/PRO);
t('ein Faktor drei braucht hoechstens 8 Rastungen', bisDreifach<=8, bisDreifach);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
