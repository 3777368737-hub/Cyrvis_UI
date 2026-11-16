import { copyFile, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

// Keep every desktop brand asset derived from the approved v3 artwork.
const source = new URL('../../design/cyrvis-logo/v3/', import.meta.url);
const target = new URL('../../apps/ui-tars/resources/', import.meta.url);
const asset = (name) => new URL(name, target);
const appIcon = await readFile(new URL('cyrvis-app-icon.png', source));
const lockup = await readFile(new URL('cyrvis-lockup.svg', source), 'utf8');

for (const [from, to] of [
  ['cyrvis-app-icon.png', 'icon.png'],
  ['cyrvis-mark.png', 'logo-vector.png'],
  ['cyrvis-mark.svg', 'logo-vector.svg'],
  ['cyrvis-mark-32.png', 'favicon-32x32.png'],
  ['cyrvis-lockup.svg', 'logo-full.svg'],
]) {
  await copyFile(new URL(from, source), asset(to));
}
await writeFile(
  asset('logo-full-dark.svg'),
  lockup.replaceAll('#1C2C45', '#FFFFFF'),
);
await sharp(Buffer.from(lockup)).png().toFile(asset('logo-full.png').pathname);

// Electron recognizes Template images and adapts their tint to the macOS menu bar.
const mono = await readFile(new URL('cyrvis-mark-mono.svg', source));
for (const [size, name] of [
  [16, 'trayTemplate.png'],
  [32, 'trayTemplate@2x.png'],
]) {
  await sharp(mono).resize(size).png().toFile(asset(name).pathname);
}

// ICO directory entries point to PNG payloads, including the 256px Windows icon.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(
  sizes.map((size) => sharp(appIcon).resize(size).png().toBuffer()),
);
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
for (let i = 0; i < sizes.length; i++) {
  const entry = 6 + i * 16;
  directory[entry] = directory[entry + 1] = sizes[i] % 256;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(pngs[i].length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += pngs[i].length;
}
await writeFile(asset('icon.ico'), Buffer.concat([directory, ...pngs]));

// Modern macOS ICNS stores PNG representations, including Retina sizes.
const chunks = [];
for (const [type, size] of [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
]) {
  const png = await sharp(appIcon).resize(size).png().toBuffer();
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32BE(png.length + 8, 4);
  chunks.push(header, png);
}
const header = Buffer.alloc(8);
header.write('icns');
header.writeUInt32BE(
  8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  4,
);
await writeFile(asset('icon.icns'), Buffer.concat([header, ...chunks]));
console.log('Synced Cyrvis v3 logos, tray images, favicon, ICO and ICNS.');
