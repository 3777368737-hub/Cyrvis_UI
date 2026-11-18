import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const out = fileURLToPath(new URL('./', import.meta.url));
await mkdir(out, { recursive: true });
const defs = `<defs>
  <linearGradient id="ice" x1="0.15" y1="0" x2="0.85" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="#E9FDFF"/><stop offset=".42" stop-color="#76E7FF"/><stop offset="1" stop-color="#348BFA"/></linearGradient>
  <radialGradient id="space"><stop stop-color="#132E46"/><stop offset="1" stop-color="#080F1C"/></radialGradient>
  <linearGradient id="tile" x2=".8" y2="1"><stop stop-color="#172D43"/><stop offset="1" stop-color="#080F1C"/></linearGradient>
  <filter id="bloom" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="9"/></filter>
</defs>`;

// The open C is a single filled contour: it remains legible without gradients or glow.
const shell = 'M 376.27 155.08 A 157 157 0 1 0 376.27 356.92 L 346.39 331.85 A 118 118 0 1 1 346.39 180.15 Z';
const core = 'M 256 218 L 294 256 L 256 294 L 218 256 Z';
function mark({ mono, detail = true } = {}) {
  const ink = mono ?? 'url(#ice)';
  return `<g fill="${ink}"><path d="${shell}"/><path d="${core}"/><path d="M 320 246 H 378 L 388 256 L 378 266 H 320 L 330 256 Z"/></g>${detail ? `<path d="M 302 194 A 77 77 0 1 0 302 318" fill="none" stroke="${mono ?? '#70DFFF'}" stroke-opacity="${mono ? '.65' : '.65'}" stroke-width="5"/>` : ''}`;
}
const glyphs = {
  C: 'M42 4H14L4 14V46L14 56H42',
  Y: 'M4 4L24 29L44 4M24 29V56',
  R: 'M4 56V4H32L43 14V23L32 33H4M25 33L45 56',
  V: 'M3 4L24 56L45 4',
  I: 'M24 4V56',
  S: 'M43 4H14L4 14V22L14 30H33L43 39V46L33 56H4',
};
function wordmark(color = '#E8F6FF') {
  return `<g fill="none" stroke="${color}" stroke-width="5" stroke-linecap="square" stroke-linejoin="bevel">${[...'CYRVIS'].map((c, i) => `<path transform="translate(${i * 72} 0)" d="${glyphs[c]}"/>`).join('')}</g>`;
}
function svg(w, h, body, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}">${defs}${body}</svg>`;
}
const files = {
  'cyrvis-mark.svg': svg(512, 512, mark(), 'CYRVIS perception core logo'),
  'cyrvis-mark-mono.svg': svg(512, 512, mark({ mono: '#101D30' }), 'CYRVIS monochrome logo'),
  'cyrvis-mark-white.svg': svg(512, 512, mark({ mono: '#FFFFFF' }), 'CYRVIS white logo'),
  'cyrvis-mark-small.svg': svg(512, 512, mark({ mono: '#74DFFF', detail: false }), 'CYRVIS simplified small logo'),
  'cyrvis-lockup.svg': svg(1032, 280, `<g transform="translate(-16 -16) scale(.61)">${mark()}</g><g transform="translate(330 93) scale(1.55)">${wordmark()}</g>`, 'CYRVIS horizontal logo'),
  'cyrvis-app-icon.svg': svg(512, 512, `<rect x="20" y="20" width="472" height="472" rx="108" fill="url(#tile)"/><rect x="21" y="21" width="470" height="470" rx="107" fill="none" stroke="#A1DBFF" stroke-opacity=".17"/><g transform="translate(2 0)">${mark()}</g>`, 'CYRVIS desktop app icon'),
};
const text = (x, y, str, size = 16, color = '#91A8BE', extra = '') => `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-family="Helvetica Neue,Arial,sans-serif" ${extra}>${str}</text>`;
const sample = (x, y, size, mono) => `<g transform="translate(${x} ${y}) scale(${size / 512})">${mark({ mono, detail: size > 32 })}</g>`;
let board = `<rect width="1600" height="1120" fill="#080F1C"/>
  <rect width="1600" height="760" fill="url(#space)"/>
  ${text(70, 67, 'CYRVIS', 19, '#DCEEF9', 'letter-spacing="6"')}
  ${text(1530, 67, 'PERSONAL AGENT / IDENTITY CONCEPT', 12, '#809AB2', 'text-anchor="end" letter-spacing="2"')}
  <path d="M70 94H1530" stroke="#2C4054"/>
  <g transform="translate(555 100) scale(.96)">
    <g opacity=".22" filter="url(#bloom)">${mark()}</g>${mark()}
  </g>
  <g transform="translate(559 602) scale(1.2)">${wordmark()}</g>
  ${text(800, 722, 'AWARE. ALIGNED. ALWAYS WITH YOU.', 13, '#8FAAC0', 'text-anchor="middle" letter-spacing="4"')}
  <path d="M70 776H1530" stroke="#2C4054"/>
  ${text(70, 816, 'DESKTOP ICON', 11, '#91A8BE', 'letter-spacing="2"')}
  <g transform="translate(64 842) scale(.33)"><rect x="20" y="20" width="472" height="472" rx="108" fill="url(#tile)" stroke="#31485F" stroke-width="2"/>${mark()}</g>
  ${text(70, 1052, 'A quiet presence on your desktop.', 13)}
  <path d="M425 816V1060M820 816V1060M1215 816V1060" stroke="#25394C"/>
  ${text(465, 816, 'ONE COLOR / LIGHT &amp; DARK', 11, '#91A8BE', 'letter-spacing="2"')}
  <rect x="465" y="853" width="146" height="146" rx="20" fill="#E8F0F6"/>
  ${sample(463, 851, 150, '#101D30')}
  ${sample(630, 851, 150, '#F0F7FF')}
  ${text(465, 1052, 'The silhouette carries the identity.', 13)}
  ${text(860, 816, 'SMALL-SIZE CLARITY', 11, '#91A8BE', 'letter-spacing="2"')}
  ${sample(850, 860, 112)}${sample(996, 885, 64)}${sample(1110, 901, 32)}
  ${text(906, 1010, '112 px', 12, '#91A8BE', 'text-anchor="middle"')}
  ${text(1028, 1010, '64 px', 12, '#91A8BE', 'text-anchor="middle"')}
  ${text(1126, 1010, '32 px', 12, '#91A8BE', 'text-anchor="middle"')}
  ${text(860, 1052, 'Simplified geometry at small sizes.', 13)}
  ${text(1255, 816, 'SPECTRUM', 11, '#91A8BE', 'letter-spacing="2"')}`;
for (const [i, color] of ['#E9FDFF', '#76E7FF', '#348BFA', '#080F1C'].entries()) {
  board += `<rect x="${1255 + i * 69}" y="870" width="57" height="84" rx="8" fill="${color}" stroke="#355069"/>${text(1255 + i * 69, 978, color.slice(1), 10)}`;
}
board += text(1255, 1052, 'Cold light. Deep space.', 13);
files['cyrvis-identity-board.svg'] = svg(1600, 1120, board, 'CYRVIS science fiction personal agent visual identity');
for (const [name, content] of Object.entries(files)) await writeFile(out + name, content + '\n');
for (const name of ['cyrvis-identity-board', 'cyrvis-app-icon', 'cyrvis-mark']) {
  const width = name === 'cyrvis-identity-board' ? 1600 : 1024;
  await sharp(Buffer.from(files[name + '.svg'])).resize(width).png().toFile(out + name + '.png');
}
for (const size of [16, 32, 64, 128, 256]) {
  await sharp(Buffer.from(files[size <= 32 ? 'cyrvis-mark-small.svg' : 'cyrvis-mark.svg'])).resize(size).png().toFile(out + `cyrvis-mark-${size}.png`);
}
console.log(`Created CYRVIS identity assets in ${out}`);
