// Builds public/ for static hosting (Vercel). It wraps index.html exactly like server.js does,
// and copies workshop.html and assets/. The API, the event log and music are proxied to your own
// server by the rewrites in vercel.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public');

const config = fs.readFileSync(path.join(root, 'vercel.json'), 'utf8');
if (/YOUR-BACKEND/.test(config)){
  console.error('vercel.json still points at YOUR-BACKEND. Replace it with the address of your running E-Kratong server (see README: "Deploy บน Vercel").');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// same wrapping as loadPage() in server.js
const raw = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const cut = raw.indexOf('<div lang="th">');
const head = cut > 0 ? raw.slice(0, cut) : '<meta charset="utf-8">';
const body = cut > 0 ? raw.slice(cut) : raw;
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html>\n<html lang="th">\n<head>\n' + head + '</head>\n<body>\n' + body + '\n</body>\n</html>\n');

fs.copyFileSync(path.join(root, 'workshop.html'), path.join(out, 'workshop.html'));
fs.cpSync(path.join(root, 'assets'), path.join(out, 'assets'), { recursive: true });

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log('built public/ (' + (size(out) / 1e6).toFixed(1) + ' MB): index.html, workshop.html, assets/');
