// Настройка Android-проекта после `npx cap add android`:
// версия из package.json (+ VERSION_CODE из окружения) и постоянная подпись.
//
// Подпись выбирается так:
//  1) секреты ANDROID_KEYSTORE_BASE64 / ANDROID_KEYSTORE_PASSWORD /
//     ANDROID_KEY_ALIAS / ANDROID_KEY_PASSWORD — личный keystore (JKS);
//  2) иначе общий ключ проекта android-signing/pocherk.p12 (PKCS12, пароль
//     «pocherk») — им подписываются все обычные сборки, поэтому APK ставится
//     обновлением поверх предыдущей версии и данные сохраняются.
//
// Пишет signed=true|false и signing в GITHUB_OUTPUT.
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

const applySigning = (block) => {
  if (gradle.includes('signingConfigs')) return false;
  // 1) подпись вешается на buildTypes.release (именно на него, не на signingConfigs)
  gradle = gradle.replace(
    /buildTypes\s*\{([\s\S]*?)release\s*\{/,
    (_m, head) => `buildTypes {${head}release {\n            signingConfig signingConfigs.release`,
  );
  // 2) сам блок signingConfigs добавляется перед buildTypes
  gradle = gradle.replace(/buildTypes\s*\{/, `signingConfigs {\n${block}\n    }\n    buildTypes {`);
  return true;
};

let signed = 'false';
let signing = 'debug';
const keystoreB64 = process.env.ANDROID_KEYSTORE_BASE64 || '';

if (keystoreB64) {
  // личный ключ из секретов репозитория
  const keystorePath = path.join(root, 'android', 'app', 'release.keystore');
  fs.writeFileSync(keystorePath, Buffer.from(keystoreB64, 'base64'));
  applySigning(`
        release {
            storeFile file("release.keystore")
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("ANDROID_KEY_ALIAS")
            keyPassword System.getenv("ANDROID_KEY_PASSWORD")
        }`);
  signed = 'true';
  signing = 'secret';
} else {
  // общий ключ проекта: одна подпись для всех сборок => обновление поверх
  const common = path.join(root, 'android-signing', 'pocherk.p12');
  if (fs.existsSync(common)) {
    fs.copyFileSync(common, path.join(root, 'android', 'app', 'pocherk.p12'));
    applySigning(`
        release {
            storeFile file("pocherk.p12")
            storeType "PKCS12"
            storePassword "pocherk"
            keyAlias "pocherk"
            keyPassword "pocherk"
        }`);
    signed = 'true';
    signing = 'common';
  }
}

fs.writeFileSync(gradlePath, gradle);
console.log(`versionName=${pkg.version} versionCode=${versionCode} signed=${signed} signing=${signing}`);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `signed=${signed}\nsigning=${signing}\nversionName=${pkg.version}\nversionCode=${versionCode}\n`,
  );
}
