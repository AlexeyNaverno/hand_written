// Настройка Android-проекта после `npx cap add android`:
// версия из package.json (+ VERSION_CODE из окружения) и, если заданы секреты
// ANDROID_KEYSTORE_BASE64 / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS /
// ANDROID_KEY_PASSWORD, — постоянная подпись release-сборки.
// Пишет `signed=true|false` в GITHUB_OUTPUT.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

if (!fs.existsSync(gradlePath)) {
  console.error('android/app/build.gradle not found — run `npx cap add android` first');
  process.exit(1);
}

let gradle = fs.readFileSync(gradlePath, 'utf8');

const versionCode = parseInt(process.env.VERSION_CODE || '1', 10) || 1;
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${pkg.version}"`);

let signed = 'false';
const keystoreB64 = process.env.ANDROID_KEYSTORE_BASE64 || '';
if (keystoreB64) {
  const keystorePath = path.join(root, 'android', 'app', 'release.keystore');
  fs.writeFileSync(keystorePath, Buffer.from(keystoreB64, 'base64'));
  const signing = `
    signingConfigs {
        release {
            storeFile file("release.keystore")
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("ANDROID_KEY_ALIAS")
            keyPassword System.getenv("ANDROID_KEY_PASSWORD")
        }
    }
`;
  if (!gradle.includes('signingConfigs')) {
    gradle = gradle.replace(/buildTypes\s*\{/, `${signing}    buildTypes {`);
    gradle = gradle.replace(/(release\s*\{)/, `$1\n            signingConfig signingConfigs.release`);
    signed = 'true';
  }
}

fs.writeFileSync(gradlePath, gradle);
console.log(`versionName=${pkg.version} versionCode=${versionCode} signed=${signed}`);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `signed=${signed}\nversionName=${pkg.version}\nversionCode=${versionCode}\n`);
}
