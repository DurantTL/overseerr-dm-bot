'use strict';

const hasControlCharacter = value => [...String(value)].some(character => {
  const code = character.charCodeAt(0);
  return code < 32 || code === 127;
});

// Avoid a backtracking expression on dashboard input. Keep the filesystem root intact while
// removing redundant trailing separators from every other path in one linear pass.
function trimTrailingSlashes(value) {
  const path = String(value);
  let end = path.length;
  while (end > 1 && path.charCodeAt(end - 1) === 47) end -= 1;
  return path.slice(0, end);
}

// One validation contract shared by the dashboard endpoint and command renderer. Syncthing folder
// ids are user-defined, so keep the character policy broad while refusing control characters that
// would corrupt the root-only env file or generated systemd unit.
function normalizeTierFolders(input, { max = 16 } = {}) {
  if (!Array.isArray(input)) throw new Error('Folders must be an array.');
  const folders = input.map((folder, index) => ({
    id: String(folder?.id ?? folder?.folderId ?? '').trim(),
    path: trimTrailingSlashes(String(folder?.path ?? folder?.folderRoot ?? '').trim()),
    index: index + 1,
  })).filter(folder => folder.id || folder.path);
  if (!folders.length) throw new Error('Add at least one Syncthing folder ID and path.');
  if (folders.length > max) throw new Error(`At most ${max} Syncthing folders are supported per node.`);
  for (const folder of folders) {
    if (!folder.id || !folder.path) throw new Error(`Folder ${folder.index} needs both a Syncthing folder ID and a local path.`);
    if (folder.id.length > 128 || hasControlCharacter(folder.id)) throw new Error(`Folder ${folder.index} has an invalid Syncthing folder ID.`);
    if (!folder.path.startsWith('/') || hasControlCharacter(folder.path)) throw new Error(`Folder ${folder.index} path must be an absolute Linux path.`);
  }
  const ids = new Set();
  const paths = new Set();
  for (const folder of folders) {
    if (ids.has(folder.id)) throw new Error(`Syncthing folder ID '${folder.id}' is listed more than once.`);
    if (paths.has(folder.path)) throw new Error(`Folder path '${folder.path}' is listed more than once.`);
    ids.add(folder.id);
    paths.add(folder.path);
  }
  return folders.map(({ id, path }) => ({ id, path }));
}

const serializeTierFolders = folders => JSON.stringify(normalizeTierFolders(folders));

function prepareTierNodeInstall(input = {}) {
  const syncthingApiKey = String(input.syncthingApiKey || '').trim();
  const rawMountRoot = String(input.mountRoot || '').trim();
  const mountRoot = trimTrailingSlashes(rawMountRoot);
  const mountMarker = String(input.mountMarker || '').trim();
  if (!syncthingApiKey) throw new Error('Syncthing API key is required.');
  if ((mountRoot || mountMarker) && !(mountRoot && mountMarker)) throw new Error('Mount root and marker must be supplied together.');
  const folders = normalizeTierFolders(input.folders);
  if (mountRoot && (!mountRoot.startsWith('/') || hasControlCharacter(mountRoot)
    || folders.some(folder => folder.path !== mountRoot && !folder.path.startsWith(`${mountRoot === '/' ? '' : mountRoot}/`)))) {
    throw new Error('Mount root must be an absolute parent of every configured folder path.');
  }
  if (mountMarker && (mountMarker.startsWith('/') || hasControlCharacter(mountMarker) || mountMarker.split('/').includes('..'))) {
    throw new Error('Mount marker must be a relative path inside the mount root.');
  }
  return { folders, syncthingApiKey, mountRoot, mountMarker };
}

module.exports = { trimTrailingSlashes, normalizeTierFolders, serializeTierFolders, prepareTierNodeInstall };
