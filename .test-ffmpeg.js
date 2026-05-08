const f = require('ffmpeg-static');
const { execSync } = require('child_process');
console.log('path:', f);
try {
  const out = execSync(`"${f}" -version`).toString().split('\n')[0];
  console.log('version:', out);
} catch (e) {
  console.error('ERR:', e.message);
}
