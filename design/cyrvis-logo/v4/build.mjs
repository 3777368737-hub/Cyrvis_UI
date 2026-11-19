import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const root = new URL('./', import.meta.url);
const word = JSON.parse(
  await readFile(new URL('wordmark-paths.json', root), 'utf8'),
);
const orange = '#FF751F';
const black = '#101112';
// Approved concept 03: preserve its stepped C silhouette and square eye.
// The eye is a real cutout so the monochrome tray template also retains it.
const outline =
  'M88 32 H224 V64 H256 V96 H192 V112 H112 V176 H192 V192 H256 V224 H224 V256 H88 V224 H56 V192 H24 V96 H56 V64 H88Z M144 56 H168 V80 H144Z';
const mark = (color) =>
  `<path fill="${color}" fill-rule="evenodd" d="${outline}"/>`;
const tile = `<rect width="512" height="512" rx="112" fill="${black}"/><g transform="translate(76 76) scale(1.25)">${mark(orange)}</g>`;
const svg = (width, height, body, label) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}">${body}</svg>\n`;
const wordmark = (color) =>
  `<g transform="translate(280 13) scale(${650 / word.width})" fill="${color}">${word.paths.map((d) => `<path d="${d}"/>`).join('')}</g>`;
const files = {
  'cyrvis-mark.svg': svg(512, 512, tile, 'Cyrvis orange arcade C on black'),
  'cyrvis-app-icon.svg': svg(512, 512, tile, 'Cyrvis app icon'),
  'cyrvis-mark-mono.svg': svg(
    288,
    288,
    mark('#000000'),
    'Cyrvis monochrome arcade C',
  ),
  'cyrvis-mark-white.svg': svg(
    288,
    288,
    mark('#FFFFFF'),
    'Cyrvis white arcade C',
  ),
  'cyrvis-lockup.svg': svg(
    960,
    256,
    `<g transform="scale(.5)">${tile}</g>${wordmark('#1C2C45')}`,
    'Cyrvis signature',
  ),
};

for (const [name, content] of Object.entries(files)) {
  await writeFile(new URL(name, root), content);
}
for (const name of ['cyrvis-mark', 'cyrvis-app-icon']) {
  await sharp(Buffer.from(files[`${name}.svg`]))
    .resize(1024)
    .png()
    .toFile(new URL(`${name}.png`, root).pathname);
}
for (const size of [16, 32, 64, 128, 256]) {
  await sharp(Buffer.from(files['cyrvis-mark.svg']))
    .resize(size)
    .png()
    .toFile(new URL(`cyrvis-mark-${size}.png`, root).pathname);
}
console.log('Created Cyrvis v4 arcade logo assets.');
