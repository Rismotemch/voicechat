const fs = require('fs');
const path = require('path');

// Копируем RNNoise WASM файлы в web/js/
const srcDir = path.join(__dirname, 'node_modules', 'rnnoise-wasm', 'dist');
const destDir = path.join(__dirname, 'web', 'js', 'rnnoise');

if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
}

// Копируем все файлы из dist
fs.readdirSync(srcDir).forEach(file => {
    fs.copyFileSync(
        path.join(srcDir, file),
        path.join(destDir, file)
    );
});

console.log('RNNoise WASM files copied to web/js/rnnoise/');