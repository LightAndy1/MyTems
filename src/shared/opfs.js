async function resolveSubdir(root, segments, create) {
  let dir = root;
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir;
}

export async function getLectureDir(id, create = false) {
  const root = await navigator.storage.getDirectory();
  return resolveSubdir(root, ['lectures', id], create);
}

export async function writeLectureFile(id, relPath, data) {
  const parts = relPath.split('/').filter(Boolean);
  const fileName = parts.pop();
  const baseDir = await getLectureDir(id, true);
  const dir = parts.length ? await resolveSubdir(baseDir, parts, true) : baseDir;
  const fh = await dir.getFileHandle(fileName, { create: true });
  const writable = await fh.createWritable();
  await writable.write(data);
  await writable.close();
}

export async function readLectureFile(id, relPath) {
  const parts = relPath.split('/').filter(Boolean);
  const fileName = parts.pop();
  const baseDir = await getLectureDir(id, false);
  const dir = parts.length ? await resolveSubdir(baseDir, parts, false) : baseDir;
  const fh = await dir.getFileHandle(fileName);
  return fh.getFile();
}

export async function readLectureJson(id, relPath) {
  try {
    const file = await readLectureFile(id, relPath);
    return JSON.parse(await file.text());
  } catch (err) {
    if (err?.name === 'NotFoundError') return null;
    throw err;
  }
}

export async function writeLectureJson(id, relPath, obj) {
  await writeLectureFile(id, relPath, JSON.stringify(obj, null, 2));
}

export async function listDirFiles(id, subDir) {
  try {
    const baseDir = await getLectureDir(id, false);
    const dir = subDir ? await baseDir.getDirectoryHandle(subDir) : baseDir;
    const files = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') files.push(name);
    }
    return files.sort();
  } catch (err) {
    if (err?.name === 'NotFoundError') return [];
    throw err;
  }
}

export async function freeLectureMedia(id) {
  let dir;
  try {
    dir = await getLectureDir(id, false);
  } catch (err) {
    if (err?.name === 'NotFoundError') return;
    throw err;
  }
  for (const target of [
    { name: 'video.webm', recursive: false },
    { name: 'audio', recursive: true },
  ]) {
    try {
      await dir.removeEntry(target.name, { recursive: target.recursive });
    } catch (err) {
      if (err?.name !== 'NotFoundError') throw err;
    }
  }
}

export async function deleteLectureDir(id) {
  try {
    const root = await navigator.storage.getDirectory();
    const lecturesDir = await root.getDirectoryHandle('lectures');
    await lecturesDir.removeEntry(id, { recursive: true });
  } catch (err) {
    if (err?.name !== 'NotFoundError') throw err;
  }
}

async function sumDirBytes(dir) {
  let total = 0;
  for await (const [, handle] of dir.entries()) {
    if (handle.kind === 'file') total += (await handle.getFile()).size;
    else if (handle.kind === 'directory') total += await sumDirBytes(handle);
  }
  return total;
}

export async function getLectureMediaBytes(id) {
  try {
    const dir = await getLectureDir(id, false);
    return await sumDirBytes(dir);
  } catch (err) {
    if (err?.name === 'NotFoundError') return 0;
    throw err;
  }
}
