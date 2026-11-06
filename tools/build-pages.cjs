const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.pages-dist');
const textFiles = ['index.html', 'style.css', 'media.js', 'fonts/inter.css'];
const fixedFiles = ['CNAME', 'index.html', 'style.css', 'media.js', 'fonts/inter.css'];
const references = new Set(fixedFiles);

function requireFile(name) {
  if (!/^(?:images|video|fonts)\/[\w./-]+$/.test(name) || name.includes('..')) {
    throw new Error(`Invalid asset path: ${name}`);
  }
  if (!fs.statSync(path.join(root, name), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Missing asset: ${name}`);
  }
  references.add(name);
}

for (const file of textFiles) {
  const content = fs.readFileSync(path.join(root, file), 'utf8');
  // Includes srcset, data-variants, posters, preload, noscript, and CSS url().
  for (const match of content.matchAll(/(?:images|video|fonts)\/[\w./-]+\.(?:webp|mp4|woff2)/g)) {
    requireFile(match[0]);
  }
  if (file === 'fonts/inter.css') {
    for (const match of content.matchAll(/url\(["']?([\w.-]+\.woff2)/g)) {
      requireFile(`fonts/${match[1]}`);
    }
  }
}

const originalVideo = [...references].filter(p => /^video\/[^/]+\.mp4$/.test(p));
if (originalVideo.length) throw new Error(`Original videos still referenced: ${originalVideo.join(', ')}`);
if (fs.existsSync(output)) fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const name of references) {
  const destination = path.join(output, name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, name), destination);
}
fs.writeFileSync(path.join(output, '.nojekyll'), '');
const bytes = [...references].reduce((sum, name) => sum + fs.statSync(path.join(output, name)).size, 0);
const maxBytes = 280_000_000;
if (bytes > maxBytes) throw new Error(`Publish set exceeds ${maxBytes} bytes: ${bytes}`);
console.log(JSON.stringify({ files: references.size + 1, bytes, mb: +(bytes / 1e6).toFixed(2) }));
