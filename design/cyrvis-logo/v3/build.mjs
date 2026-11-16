import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
const root = new URL('./', import.meta.url);
const word = JSON.parse(await readFile(new URL('wordmark-paths.json', root), 'utf8'));
const point = (r,a) => {const t=a*Math.PI/180;return `${(256+r*Math.cos(t)).toFixed(3)} ${(256+r*Math.sin(t)).toFixed(3)}`;};
// Three independent rounded annular pieces. Their shared center preserves the C silhouette.
function segment(a,b) {
 const outer=178, inner=103, corner=7, trim=2.8;
 return `M ${point(outer,a+trim)} A ${outer} ${outer} 0 0 1 ${point(outer,b-trim)} Q ${point(outer,b)} ${point(outer-corner,b)} L ${point(inner+corner,b)} Q ${point(inner,b)} ${point(inner,b-trim)} A ${inner} ${inner} 0 0 0 ${point(inner,a+trim)} Q ${point(inner,a)} ${point(inner+corner,a)} L ${point(outer-corner,a)} Q ${point(outer,a)} ${point(outer,a+trim)} Z`;
}
const pieces = [segment(150,210), segment(222,322), segment(38,138)];
const gradient=(id,stops,x1='0',y1='0',x2='1',y2='1')=>`<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops.map(([offset,color])=>`<stop offset="${offset}" stop-color="${color}"/>`).join('')}</linearGradient>`;
const defs=`<defs>
${gradient('badge',[[0,'#3F7DDB'],[.5,'#235DB7'],[1,'#153D86']])}
${gradient('blue0',[[0,'#3F70B4'],[1,'#153D81']])}
${gradient('blue1',[[0,'#77BCF4'],[.5,'#4B95E3'],[1,'#2968C3']])}
${gradient('blue2',[[0,'#5595E2'],[1,'#2456AC']])}
${gradient('white0',[[0,'#E0EBF9'],[1,'#9FB9DB']])}
${gradient('white1',[[0,'#FFFFFF'],[1,'#E8F3FF']])}
${gradient('white2',[[0,'#F6FAFF'],[1,'#C0D4ED']])}
${gradient('tile',[[0,'#3376D2'],[1,'#173E84']])}
</defs>`;
function mark(mode='blue',flat=false) {
 const colors = mode==='mono'?['#1D2E48','#1D2E48','#1D2E48']:mode==='flat-white'?['#FFFFFF','#FFFFFF','#FFFFFF']:pieces.map((_,i)=>`url(#${mode}${i})`);
 const body = flat || mode==='mono'||mode==='flat-white'?'':`<g transform="translate(0 6)" fill="${mode==='white'?'#123F83':'#153A76'}" opacity="${mode==='white'?'.32':'.8'}">${pieces.map(d=>`<path d="${d}"/>`).join('')}</g>`;
 return body+pieces.map((d,i)=>`<path d="${d}" fill="${colors[i]}"/>`).join('');
}
const pm=(x,y,size,mode='blue',flat=false)=>`<g transform="translate(${x} ${y}) scale(${size/512})">${mark(mode,flat)}</g>`;
const pw=(x,y,width,color='#1C2C45')=>`<g transform="translate(${x} ${y}) scale(${width/word.width})" fill="${color}">${word.paths.map(d=>`<path d="${d}"/>`).join('')}</g>`;
const text=(x,y,s,size=14,color='#78869A',attrs='')=>`<text x="${x}" y="${y}" font-family="Helvetica Neue,Arial,sans-serif" font-size="${size}" fill="${color}" ${attrs}>${s}</text>`;
const svg=(w,h,body,title)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${title}">${defs}${body}</svg>\n`;
const badge=`<circle cx="256" cy="256" r="246" fill="url(#badge)"/><g transform="translate(32 26) scale(.875)">${mark('white')}</g>`;
const tile=`<rect x="16" y="16" width="480" height="480" rx="112" fill="url(#tile)"/>${pm(30,24,452,'white')}`;
const files={
 'cyrvis-mark.svg':svg(512,512,mark(),'Cyrvis three-part layered C'),
 'cyrvis-mark-mono.svg':svg(512,512,mark('mono'),'Cyrvis monochrome segmented C'),
 'cyrvis-mark-white.svg':svg(512,512,mark('flat-white'),'Cyrvis white segmented C'),
 'cyrvis-badge.svg':svg(512,512,badge,'Cyrvis blue circular badge'),
 'cyrvis-app-icon.svg':svg(512,512,tile,'Cyrvis app icon'),
 'cyrvis-lockup.svg':svg(960,256,pm(0,0,256)+pw(280,13,650),'Cyrvis signature'),
};
const board=`<rect width="1600" height="1120" fill="#F6F8FB"/>
${text(72,67,'CYRVIS',15,'#1C2C45','letter-spacing="3"')}
${text(1528,67,'SEGMENTED / LAYERED',12,'#78869A','letter-spacing="2" text-anchor="end"')}
<g transform="translate(178 153) scale(.91)">${badge}</g>
${pm(932,185,370)}${pw(968,552,290)}
${text(410,690,'THE EMBLEM',12,'#66778D','letter-spacing="2" text-anchor="middle"')}
${text(1115,690,'THE SIGNATURE',12,'#66778D','letter-spacing="2" text-anchor="middle"')}
<path d="M72 754H1528" stroke="#DFE5ED"/>
${text(72,810,'THREE PARTS. ONE C.',12,'#66778D','letter-spacing="1.6"')}
${pm(53,840,180,'mono')}
${text(268,911,'Cut with space.',22,'#1C2C45')}
${text(268,946,'Shaped by light.',22,'#1C2C45')}
${text(72,1065,'Shared curvature / rounded terminals',13,'#78869A')}
<g transform="translate(630 843) scale(.34)">${tile}</g>
${text(838,915,'cyrvis',27,'#1C2C45')}
${text(838,948,'Desktop icon',14,'#78869A')}
${text(636,1065,'Blue enamel / cool white',13,'#78869A')}
<rect x="1100" y="825" width="428" height="205" rx="18" fill="#EAF0F8"/>
${pm(1112,842,150)}${pm(1294,891,64)}${pm(1410,910,32)}${pm(1471,922,16,'mono',true)}
${text(1187,1001,'150',11,'#78869A','text-anchor="middle"')}${text(1326,1001,'64',11,'#78869A','text-anchor="middle"')}${text(1426,1001,'32',11,'#78869A','text-anchor="middle"')}${text(1479,1001,'16',11,'#78869A','text-anchor="middle"')}
${text(1100,1065,'Color at scale / flat at 16 px',13,'#78869A')}`;
files['cyrvis-identity-board.svg']=svg(1600,1120,board,'Cyrvis segmented C identity presentation');
for(const [name,content] of Object.entries(files))await writeFile(new URL(name,root),content);
for(const name of ['cyrvis-mark','cyrvis-badge','cyrvis-app-icon','cyrvis-identity-board'])await sharp(Buffer.from(files[name+'.svg'])).resize(name==='cyrvis-identity-board'?1600:1024).png().toFile(new URL(name+'.png',root).pathname);
for(const size of [16,32,64,128,256])await sharp(Buffer.from(size===16?files['cyrvis-mark-mono.svg']:files['cyrvis-mark.svg'])).resize(size).png().toFile(new URL(`cyrvis-mark-${size}.png`,root).pathname);
console.log('Created segmented identity in '+root.pathname);
