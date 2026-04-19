/**
 * Resizes a source PNG into Android mipmap launcher icons.
 * Usage: node scripts/generate-launcher-icons.js [path-to-source.png]
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const defaultSource = path.join(__dirname, '..', 'assets', 'app-icon-source.png');

const resRoot = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

const DENSITIES = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192],
];

async function main() {
  const src = process.argv[2] ? path.resolve(process.argv[2]) : defaultSource;
  if (!fs.existsSync(src)) {
    console.error('Source image not found:', src);
    process.exit(1);
  }

  for (const [folder, size] of DENSITIES) {
    const outDir = path.join(resRoot, folder);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const resizeOpts = {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    };

    await sharp(src)
      .resize(size, size, resizeOpts)
      .png()
      .toFile(path.join(outDir, 'ic_launcher.png'));
    await sharp(src)
      .resize(size, size, resizeOpts)
      .png()
      .toFile(path.join(outDir, 'ic_launcher_round.png'));
  }

  console.log('Wrote ic_launcher.png and ic_launcher_round.png for all densities from', src);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
