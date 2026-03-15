const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const wmDir = path.join(__dirname, '..', 'worldmonitor');
const viteBin = path.join(wmDir, 'node_modules', '.bin', 'vite');

// Install dependencies if not present
if (!fs.existsSync(viteBin)) {
  console.log('📦 Installing WorldMonitor dependencies...');
  execSync('npm install', { cwd: wmDir, stdio: 'inherit', shell: true });
}

console.log('🔨 Building WorldMonitor...');
execSync(`"${viteBin}" build`, { cwd: wmDir, stdio: 'inherit', shell: true });
console.log('✅ WorldMonitor build complete.');
