/** Сохранение файла: загрузка в браузере, системный шаринг в Android-приложении. */

interface CapacitorLike {
  isNativePlatform?: () => boolean;
}

export const isNative = () =>
  !!(globalThis as unknown as { Capacitor?: CapacitorLike }).Capacitor?.isNativePlatform?.();

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(s);
}

export async function saveFile(name: string, bytes: Uint8Array, mime: string): Promise<string> {
  if (isNative()) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const data = toBase64(bytes);
    const tmp = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache });
    let note = '';
    try {
      await Filesystem.writeFile({ path: `Pocherk/${name}`, data, directory: Directory.Documents, recursive: true });
      note = ` Копия: Документы/Pocherk/${name}.`;
    } catch {
      note = '';
    }
    await Share.share({ title: name, files: [tmp.uri] }).catch(() => undefined);
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
