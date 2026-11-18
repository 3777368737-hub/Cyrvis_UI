import { writeFile, readFile } from 'node:fs/promises';
import sharp from 'sharp';
const root=new URL('./',import.meta.url);
const states=[['idle','陪伴','安静地等你开口'],['listening','倾听','侧过头，认真听你说'],['thinking','思考','目光上移，整理思路'],['speaking','回应','用眼神和声纹回应'],['working','执行','看向任务，动手处理'],['sleeping','休息','闭上眼，收起提示']];
function robot(state='idle',id='r'){
const p=id;
const eyes=state==='sleeping'?'<path d="M143 170q15 10 30 0 M227 170q15 10 30 0" fill="none" stroke-width="7" stroke-linecap="round"/>':state==='speaking'?'<path d="M141 172q15-25 32 0 M227 172q15-25 32 0" fill="none" stroke-width="9" stroke-linecap="round"/>':state==='thinking'?'<rect x="148" y="142" width="16" height="27" rx="8"/><rect x="232" y="142" width="16" height="27" rx="8"/>':'<rect x="145" y="149" width="25" height="40" rx="12.5"/><rect x="230" y="149" width="25" height="40" rx="12.5"/>';
const mouth=state==='speaking'?'<g stroke="#83D5FF" stroke-width="5" stroke-linecap="round"><path d="M181 207v6 M190 202v16 M200 198v24 M210 203v14 M219 207v6"/></g>':state==='sleeping'?'':'<path d="M189 207q11 7 22 0" fill="none" stroke="#71A9C8" stroke-width="4" stroke-linecap="round"/>';
return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 480" role="img" aria-label="CYRVIS ${states.find(s=>s[0]===state)[1]}" class="robot state-${state}"><defs>
<linearGradient id="${p}-shell" x1=".15" x2=".9" y2="1"><stop stop-color="#FFFFFF"/><stop offset=".5" stop-color="#EAF0F6"/><stop offset="1" stop-color="#A9BACD"/></linearGradient>
<linearGradient id="${p}-face" x2=".7" y2="1"><stop stop-color="#263E58"/><stop offset=".5" stop-color="#14263D"/><stop offset="1" stop-color="#0B1628"/></linearGradient>
<linearGradient id="${p}-blue" x2=".9" y2="1"><stop stop-color="#75B6FF"/><stop offset="1" stop-color="#2A61B9"/></linearGradient>
<radialGradient id="${p}-shadow"><stop stop-color="#25486D" stop-opacity=".22"/><stop offset="1" stop-color="#25486D" stop-opacity="0"/></radialGradient>
</defs>
<ellipse cx="200" cy="433" rx="130" ry="24" fill="url(#${p}-shadow)"/>
<g class="whole">
<g class="feet" fill="url(#${p}-shell)" stroke="#A8BACD" stroke-width="1.5"><path d="M141 370h46v42q-3 15-24 15h-30q-15-3-10-17z"/><path d="M213 370h46l18 40q5 14-10 17h-30q-21 0-24-15z"/></g>
<path d="M145 262q55-20 110 0l16 79q2 42-38 48h-66q-40-6-38-48z" fill="url(#${p}-shell)" stroke="#B8C8D8" stroke-width="1.5"/>
<path d="M145 346q55 19 110 0" fill="none" stroke="#A7B9CC" stroke-width="2"/>
<g class="arm arm-left" transform="${state==='working'?'rotate(-32 132 283)':'rotate(9 132 283)'}"><rect x="102" y="274" width="31" height="77" rx="15" fill="url(#${p}-shell)" stroke="#B4C5D5"/><path d="M109 335h16" stroke="#89A3BD" stroke-width="2"/></g>
<g class="arm arm-right" transform="${state==='speaking'?'rotate(-23 269 285)':state==='listening'?'rotate(-55 269 285)':'rotate(-9 269 285)'}"><rect x="267" y="274" width="31" height="77" rx="15" fill="url(#${p}-shell)" stroke="#B4C5D5"/><path d="M274 335h16" stroke="#89A3BD" stroke-width="2"/></g>
<circle cx="200" cy="307" r="25" fill="#D2DEEB"/><g fill="none" stroke="url(#${p}-blue)" stroke-width="7" stroke-linecap="round"><path d="M211 294a17 17 0 0 0-20-3 M184 300a17 17 0 0 0 0 14 M191 323a17 17 0 0 0 20-3"/></g>
<g class="head" transform="${state==='listening'?'rotate(-8 200 230)':state==='thinking'?'rotate(3 200 230)':''}">
<rect x="67" y="139" width="31" height="72" rx="15" fill="url(#${p}-blue)"/><rect x="302" y="139" width="31" height="72" rx="15" fill="url(#${p}-blue)"/>
<path d="M85 126q1-43 49-50q66-11 132 0q48 7 49 50v88q-2 44-50 51q-65 9-130 0q-48-7-50-51z" fill="url(#${p}-shell)" stroke="#C5D2E0" stroke-width="2"/>
<path d="M115 104q85-29 170 0" fill="none" stroke="white" stroke-width="5" stroke-linecap="round"/>
<path d="M109 139q0-23 27-27q64-9 128 0q27 4 27 27v60q-1 31-32 35q-59 8-118 0q-31-4-32-35z" fill="url(#${p}-face)" stroke="#8297B0" stroke-width="2"/>
<path d="M124 134q75-20 150 0" fill="none" stroke="#6789AA" stroke-opacity=".25" stroke-width="3" stroke-linecap="round"/>
<g class="eyes" fill="#8DDCFF" stroke="#8DDCFF">${eyes}</g>${mouth}
<circle cx="200" cy="94" r="3.2" fill="${state==='sleeping'?'#8FA3B8':'#4D96E5'}"/>
<path d="M159 251h82" stroke="#C2CDDA" stroke-width="2" stroke-linecap="round"/>
</g>
${state==='thinking'?'<g fill="#5088C9"><circle cx="316" cy="79" r="5"/><circle cx="335" cy="63" r="7"/><circle cx="359" cy="51" r="9"/></g>':''}
${state==='listening'?'<g fill="none" stroke="#79B4EE" stroke-width="4" stroke-linecap="round"><path d="M49 147q-14 25 0 50 M36 132q-25 41 0 80"/></g>':''}
${state==='working'?'<g transform="rotate(-9 98 333)"><rect x="55" y="303" width="84" height="55" rx="10" fill="#3169B5"/><path d="M72 322h49 M72 334h32" stroke="#A5D9FF" stroke-width="4" stroke-linecap="round"/></g>':''}
</g></svg>`;
}
const text=(x,y,s,size=16,color='#60758D',extra='')=>`<text x="${x}" y="${y}" font-family="Helvetica Neue,PingFang SC,Arial,sans-serif" font-size="${size}" fill="${color}" ${extra}>${s}</text>`;
const nested=(state,x,y,w)=>robot(state,'board-'+state).replace('viewBox="0 0 400 480"',`x="${x}" y="${y}" width="${w}" height="${w*1.2}" viewBox="0 0 400 480"`);
const board=`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1280" viewBox="0 0 1600 1280"><rect width="1600" height="1280" fill="#F2F6FA"/>${text(72,65,'CYRVIS / DESKTOP COMPANION',15,'#2A4564','letter-spacing="2"')}${text(1528,65,'CHARACTER CONCEPT 01',12,'#60758D','text-anchor="end" letter-spacing="2"')}${nested('idle',100,100,510)}${text(740,240,'你的桌面小伙伴。',53,'#1A304C')}${text(744,300,'叫一声，它就转向你。',25)}${text(744,350,'听你说话，替你行动，安静地陪在身边。',21)}<rect x="744" y="405" width="404" height="76" rx="24" fill="white"/>${text(772,451,'“Cyrvis，帮我整理一下今天的文件。”',18,'#385675')}${text(744,545,'陶瓷白机身 · 蓝色侧耳 · 分段 C 胸标',17)}${text(744,578,'短手臂与小脚，让回应变成动作。',17)}<path d="M72 750H1528" stroke="#D6E1EB"/>${text(72,799,'每一种状态，都看得懂。',24,'#1A304C')}${states.slice(1).map(([s,t,d],i)=>nested(s,58+i*300,821,270)+text(193+i*300,1173,t,21,'#1A304C','text-anchor="middle"')+text(193+i*300,1207,d,15,'#60758D','text-anchor="middle"')).join('')}</svg>`;
await writeFile(new URL('character-board.svg',root),board);
await sharp(Buffer.from(board)).png().toFile(new URL('character-board.png',root).pathname);
for(const [s] of states){const r=robot(s,s);await writeFile(new URL(`robot-${s}.svg`,root),r);await sharp(Buffer.from(r)).resize(800,960).png().toFile(new URL(`robot-${s}.png`,root).pathname);}
await writeFile(new URL('states.json',root),JSON.stringify(Object.fromEntries(states.map(([s,t,d])=>[s,{label:t,description:d,svg:robot(s,'live-'+s)}]))));
const template=await readFile(new URL('preview.template.html',root),'utf8');
await writeFile(new URL('preview.html',root),template.replace('/*STATE_DATA*/',JSON.stringify(Object.fromEntries(states.map(([s,t,d])=>[s,{label:t,description:d,svg:robot(s,'live-'+s)}])))));
console.log('Robot artwork and interactive prototype exported.');
