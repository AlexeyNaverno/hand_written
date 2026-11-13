/** Things that differ between a browser tab and the Android wrapper: reading photos and saving files. */

export async function decodeImageFile(file: Blob, maxSide = 4096): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('Не удалось прочитать изображение. Подходят JPEG и PNG.');
  }
  const f = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * f));
  const h = Math.max(1, Math.round(bmp.height * f));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d', { willReadFrequently: true })!;
  c.fillStyle = '#fff';
  c.fillRect(0, 0, w, h);
  c.imageSmoothingQuality = 'high';
  c.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const data = c.getImageData(0, 0, w, h).data;
  return { rgba: new Uint8Array(data.buffer.slice(0)), width: w, height: h };
}

interface CapacitorLike {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const cap = (): CapacitorLike | undefined => (globalThis as unknown as { Capacitor?: CapacitorLike }).Capacitor;
export const isNative = () => !!cap()?.isNativePlatform?.();

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(s);
}

/** Saves a file: a normal download in the browser; in the Android app the file is handed to the system share sheet. */
export async function saveFile(name: string, bytes: Uint8Array, mime: string): Promise<string> {
  const c = cap();
  if (isNative() && c?.Plugins?.Filesystem) {
    const fsys = c.Plugins.Filesystem;
    const data = toBase64(bytes);
    // the cache folder is always writable; from there the share sheet can pass the file to any app or to "Files"
    const tmp = await fsys.writeFile({ path: name, data, directory: 'CACHE' });
    let note = '';
    try {
      await fsys.writeFile({ path: `Pocherk/${name}`, data, directory: 'DOCUMENTS', recursive: true });
      note = ` Копия: Документы/Pocherk/${name}.`;
    } catch {
      note = '';
    }
    if (c.Plugins.Share) await c.Plugins.Share.share({ title: name, files: [tmp.uri] }).catch(() => undefined);
    return `Файл ${name} готов.${note}`;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return `Файл ${name} сохранён в загрузки`;
}
