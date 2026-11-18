import { appendFile, readFile, writeFile } from 'node:fs/promises';

const manifest = 'android/app/src/main/AndroidManifest.xml';
let xml = await readFile(manifest, 'utf8');
if (!xml.includes('android.permission.CAMERA')) {
  xml = xml.replace(/<manifest\b[^>]*>/, (tag) => `${tag}\n    <uses-permission android:name="android.permission.CAMERA" />`);
}
// The APK ships its OCR/model files. It needs the camera, but no internet permission or runtime network access.
xml = xml.replace(/^\s*<uses-permission android:name="android.permission.INTERNET"\s*\/>\s*$/m, '\n');
await writeFile(manifest, xml);

const gradle = 'android/app/build.gradle';
let build = await readFile(gradle, 'utf8');
const versionCode = String(Math.max(2, Number(process.env.GITHUB_RUN_NUMBER) || 2));
const versionName = JSON.parse(await readFile('package.json', 'utf8')).version;
build = build.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
build = build.replace(/versionName\s+["'][^"']+["']/, `versionName "${versionName}"`);

const required = ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'];
const signed = required.every((key) => Boolean(process.env[key]));
if (signed) {
  const store = Buffer.from(process.env.ANDROID_KEYSTORE_BASE64, 'base64');
  if (store.length < 1024) throw new Error('ANDROID_KEYSTORE_BASE64 is not a valid keystore');
  await writeFile('android/app/release-key.jks', store, { mode: 0o600 });
  build += `\n\n// Private signing key is injected from GitHub Actions secrets; never commit the keystore.\nandroid {\n    signingConfigs {\n        release {\n            storeFile file("release-key.jks")\n            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")\n            keyAlias System.getenv("ANDROID_KEY_ALIAS")\n            keyPassword System.getenv("ANDROID_KEY_PASSWORD")\n        }\n    }\n    buildTypes {\n        release { signingConfig signingConfigs.release }\n    }\n}\n`;
}
await writeFile(gradle, build);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `signed=${signed}\nversionCode=${versionCode}\nversionName=${versionName}\n`);
console.log(`Android setup complete; release signing ${signed ? 'configured' : 'not configured'}; versionCode ${versionCode}.`);
