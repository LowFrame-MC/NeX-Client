import axios from 'axios';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import electron from 'electron';

const MODRINTH_API = 'https://api.modrinth.com/v2';
const CURSEFORGE_API = 'https://api.curseforge.com/v1';
const PLANET_MINECRAFT_BASE = 'https://www.planetminecraft.com';
const MINECRAFT_GAME_ID = 432;
const CURSEFORGE_RESOURCE_PACK_CLASS_ID = 12;
const { app } = electron;
const { net } = electron;

const http = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': 'NeXClient/1.0.0 (support@nexclient.local)'
  }
});

function getModsDirectory(version = 'global') {
  return path.join(app.getPath('userData'), 'mods', version);
}

function getMinecraftDirectory() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(app.getPath('home'), 'AppData', 'Roaming'), '.minecraft');
  }

  if (process.platform === 'darwin') {
    return path.join(app.getPath('home'), 'Library', 'Application Support', 'minecraft');
  }

  return path.join(app.getPath('home'), '.minecraft');
}

function getResourcePacksDirectory(gameDirectory = '') {
  return path.join(gameDirectory || getMinecraftDirectory(), 'resourcepacks');
}

async function ensureModsDirectory(version) {
  const modsDir = getModsDirectory(version);
  await mkdir(modsDir, { recursive: true });
  return modsDir;
}

async function ensureResourcePacksDirectory(gameDirectory) {
  const resourcePacksDir = getResourcePacksDirectory(gameDirectory);
  await mkdir(resourcePacksDir, { recursive: true });
  return resourcePacksDir;
}

function normalizeProgress(source, fileName, downloaded, total, phase = 'downloading') {
  const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
  return {
    source,
    fileName,
    downloaded,
    total,
    percent,
    progress: percent,
    phase
  };
}

function selectPrimaryFile(files = []) {
  return files.find((file) => file.primary) || files.find((file) => file.url) || files[0];
}

async function streamToFile({ url, filePath, fileName, source, onProgress }) {
  const response = await http.get(url, {
    responseType: 'stream',
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 300
  });

  const total = Number(response.headers['content-length'] || 0);
  let downloaded = 0;

  onProgress?.(normalizeProgress(source, fileName, downloaded, total, 'starting'));

  await new Promise((resolve, reject) => {
    const output = createWriteStream(filePath);

    response.data.on('data', (chunk) => {
      downloaded += chunk.length;
      onProgress?.(normalizeProgress(source, fileName, downloaded, total));
    });

    response.data.on('error', reject);
    output.on('error', reject);
    output.on('finish', resolve);
    response.data.pipe(output);
  });

  onProgress?.(normalizeProgress(source, fileName, total || downloaded, total || downloaded, 'complete'));
  return filePath;
}

function curseForgeHeaders() {
  const apiKey = process.env.CURSEFORGE_API_KEY;

  if (!apiKey) {
    throw new Error('CurseForge requires CURSEFORGE_API_KEY to use the official public API.');
  }

  return {
    Accept: 'application/json',
    'x-api-key': apiKey
  };
}

async function curseForgeGetWithVersionFallback(url, options = {}) {
  const fallbackParamSets = [];

  if (options.params?.modLoaderType) {
    const withoutLoader = { ...options.params };
    delete withoutLoader.modLoaderType;
    fallbackParamSets.push(withoutLoader);
  }

  if (options.params?.gameVersion) {
    const withoutVersion = { ...options.params };
    delete withoutVersion.gameVersion;
    fallbackParamSets.push(withoutVersion);
  }

  if (options.params?.gameVersion && options.params?.modLoaderType) {
    const withoutVersionOrLoader = { ...options.params };
    delete withoutVersionOrLoader.gameVersion;
    delete withoutVersionOrLoader.modLoaderType;
    fallbackParamSets.push(withoutVersionOrLoader);
  }

  try {
    return await http.get(url, options);
  } catch (error) {
    const status = error.response?.status;

    if (status !== 403 || !fallbackParamSets.length) {
      throw error;
    }

    let lastError = error;
    for (const retryParams of fallbackParamSets) {
      try {
        return await http.get(url, {
          ...options,
          params: retryParams
        });
      } catch (retryError) {
        lastError = retryError;
      }
    }

    throw lastError;
  }
}

function decodeHtml(value = '') {
  return String(value)
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
}

function stripHtml(value = '') {
  return decodeHtml(String(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function slugifyTag(value = '') {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function planetMinecraftUrl(query = '', contentType = 'mods') {
  const trimmed = query.trim();
  const basePath = contentType === 'resourcepacks' ? 'texture-packs' : 'mods';

  if (!trimmed) {
    return `${PLANET_MINECRAFT_BASE}/${basePath}/`;
  }

  const tag = slugifyTag(trimmed);
  return tag ? `${PLANET_MINECRAFT_BASE}/${basePath}/tag/${tag}/` : `${PLANET_MINECRAFT_BASE}/${basePath}/`;
}

async function electronTextRequest(url) {
  if (!net?.request) {
    throw new Error('Electron net API is unavailable for Planet Minecraft requests.');
  }

  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'GET',
      url
    });
    const chunks = [];

    request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) NeXClient/1.0 Chrome Safari/537.36');
    request.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    request.setHeader('Accept-Language', 'en-US,en;q=0.9');

    request.on('response', (response) => {
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');

        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Planet Minecraft returned HTTP ${response.statusCode}.`));
          return;
        }

        resolve(body);
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function parsePlanetMinecraftProjects(html, pageUrl, contentType = 'mods') {
  const projects = [];
  const seen = new Set();
  const projectPath = contentType === 'resourcepacks' ? 'texture-pack' : 'mod';
  const anchorPattern = new RegExp(`<a\\b[^>]*href=["'](\\/${projectPath}\\/[^"']+\\/)["'][^>]*>([\\s\\S]*?)<\\/a>`, 'gi');
  let match;

  while ((match = anchorPattern.exec(html)) && projects.length < 24) {
    const href = match[1];
    const title = stripHtml(match[2]);

    if (!title || title.length < 2 || seen.has(href)) {
      continue;
    }

    seen.add(href);
    const url = new URL(href, pageUrl).toString();
    const surrounding = html.slice(Math.max(0, match.index - 900), Math.min(html.length, match.index + 1400));
    const typePattern = contentType === 'resourcepacks'
      ? /Minecraft\s+([0-9A-Za-z .+-]+)\s+([A-Za-z ]+(?:Texture Pack|Resource Pack))/i
      : /Minecraft\s+([0-9A-Za-z .+-]+)\s+([A-Za-z ]+ Mod)/i;
    const typeMatch = stripHtml(surrounding).match(typePattern);
    const imageMatch = surrounding.match(/<img\b[^>]*(?:src|data-src)=["']([^"']+)["'][^>]*>/i);

    projects.push({
      id: href.replace(new RegExp(`^/${projectPath}/`), '').replace(/\/$/, ''),
      slug: href,
      title,
      description: typeMatch ? `Planet Minecraft ${typeMatch[0]}` : `Planet Minecraft community ${contentType === 'resourcepacks' ? 'resource pack' : 'mod'}. Open the project page to review files, versions, and author notes.`,
      iconUrl: imageMatch ? new URL(decodeHtml(imageMatch[1]), pageUrl).toString() : '',
      downloads: 0,
      source: 'planetminecraft',
      websiteUrl: url,
      installMode: 'external'
    });
  }

  return projects;
}

function parsePlanetMinecraftMods(html, pageUrl) {
  return parsePlanetMinecraftProjects(html, pageUrl, 'mods');
}

function parsePlanetMinecraftResourcePacks(html, pageUrl) {
  return parsePlanetMinecraftProjects(html, pageUrl, 'resourcepacks');
}

export async function searchModrinthMods(query, gameVersion = '1.20.4', loader = 'fabric') {
  const facets = [
    ['project_type:mod'],
    [`versions:${gameVersion}`]
  ];

  if (loader && loader !== 'any') {
    facets.push([`categories:${loader}`]);
  }

  const { data } = await http.get(`${MODRINTH_API}/search`, {
    params: {
      query: query || undefined,
      facets: JSON.stringify(facets),
      index: query ? 'relevance' : 'downloads',
      limit: 24
    }
  });

  return data.hits.map((hit) => ({
    id: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description,
    iconUrl: hit.icon_url,
    downloads: hit.downloads,
    source: 'modrinth',
    latestVersions: hit.versions || [],
    clientSide: hit.client_side,
    serverSide: hit.server_side
  }));
}

export async function getModrinthVersions(projectId, gameVersion, loader = 'fabric') {
  const params = {
    game_versions: JSON.stringify([gameVersion])
  };

  if (loader && loader !== 'any') {
    params.loaders = JSON.stringify([loader]);
  }

  const { data } = await http.get(`${MODRINTH_API}/project/${projectId}/version`, { params });
  return data;
}

export async function searchModrinthResourcePacks(query, gameVersion = '1.20.4') {
  const facets = [
    ['project_type:resourcepack'],
    [`versions:${gameVersion}`]
  ];

  const { data } = await http.get(`${MODRINTH_API}/search`, {
    params: {
      query: query || undefined,
      facets: JSON.stringify(facets),
      index: query ? 'relevance' : 'downloads',
      limit: 24
    }
  });

  return data.hits.map((hit) => ({
    id: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description,
    iconUrl: hit.icon_url,
    downloads: hit.downloads,
    source: 'modrinth',
    latestVersions: hit.versions || [],
    clientSide: hit.client_side,
    serverSide: hit.server_side
  }));
}

export async function getModrinthResourcePackVersions(projectId, gameVersion) {
  const { data } = await http.get(`${MODRINTH_API}/project/${projectId}/version`, {
    params: {
      game_versions: JSON.stringify([gameVersion])
    }
  });
  return data;
}

export async function downloadModrinthMod({ projectId, versionId, gameVersion = 'global', loader = 'fabric' }, onProgress) {
  let version;

  if (versionId) {
    const response = await http.get(`${MODRINTH_API}/version/${versionId}`);
    version = response.data;
  } else {
    const versions = await getModrinthVersions(projectId, gameVersion, loader);
    version = versions[0];
  }

  if (!version) {
    throw new Error(`No Modrinth release was found for ${projectId} on Minecraft ${gameVersion}.`);
  }

  const file = selectPrimaryFile(version.files);

  if (!file?.url || !file?.filename) {
    throw new Error('The selected Modrinth version has no downloadable file.');
  }

  const modsDir = await ensureModsDirectory(gameVersion);
  const filePath = path.join(modsDir, file.filename);

  return streamToFile({
    url: file.url,
    filePath,
    fileName: file.filename,
    source: 'modrinth',
    onProgress
  });
}

export async function downloadModrinthResourcePack({ projectId, versionId, gameVersion = '1.20.4', gameDirectory = '' }, onProgress) {
  let version;

  if (versionId) {
    const response = await http.get(`${MODRINTH_API}/version/${versionId}`);
    version = response.data;
  } else {
    const versions = await getModrinthResourcePackVersions(projectId, gameVersion);
    version = versions[0];
  }

  if (!version) {
    throw new Error(`No Modrinth resource pack was found for ${projectId} on Minecraft ${gameVersion}.`);
  }

  const file = selectPrimaryFile(version.files);

  if (!file?.url || !file?.filename) {
    throw new Error('The selected Modrinth resource pack has no downloadable file.');
  }

  const resourcePacksDir = await ensureResourcePacksDirectory(gameDirectory);
  const filePath = path.join(resourcePacksDir, file.filename);

  return streamToFile({
    url: file.url,
    filePath,
    fileName: file.filename,
    source: 'modrinth-resourcepack',
    onProgress
  });
}

export async function searchCurseForgeMods(query, gameVersion = '1.20.4', loader = 'fabric') {
  const params = {
    gameId: MINECRAFT_GAME_ID,
    gameVersion,
    sortField: 2,
    sortOrder: 'desc',
    pageSize: 24
  };

  if (query) {
    params.searchFilter = query;
  }

  if (loader && loader !== 'any') {
    params.modLoaderType = loader.toLowerCase() === 'forge' ? 1 : 4;
  }

  const { data } = await curseForgeGetWithVersionFallback(`${CURSEFORGE_API}/mods/search`, {
    params,
    headers: curseForgeHeaders()
  });

  return data.data.map((mod) => ({
    id: mod.id,
    slug: mod.slug,
    title: mod.name,
    description: mod.summary,
    iconUrl: mod.logo?.thumbnailUrl || mod.logo?.url || '',
    downloads: mod.downloadCount,
    source: 'curseforge',
    latestFiles: mod.latestFilesIndexes || [],
    websiteUrl: mod.links?.websiteUrl || ''
  }));
}

export async function searchCurseForgeResourcePacks(query, gameVersion = '1.20.4') {
  const params = {
    gameId: MINECRAFT_GAME_ID,
    classId: CURSEFORGE_RESOURCE_PACK_CLASS_ID,
    gameVersion,
    sortField: 2,
    sortOrder: 'desc',
    pageSize: 24
  };

  if (query) {
    params.searchFilter = query;
  }

  const { data } = await curseForgeGetWithVersionFallback(`${CURSEFORGE_API}/mods/search`, {
    params,
    headers: curseForgeHeaders()
  });

  return data.data.map((pack) => ({
    id: pack.id,
    slug: pack.slug,
    title: pack.name,
    description: pack.summary,
    iconUrl: pack.logo?.thumbnailUrl || pack.logo?.url || '',
    downloads: pack.downloadCount,
    source: 'curseforge',
    latestFiles: pack.latestFilesIndexes || [],
    websiteUrl: pack.links?.websiteUrl || ''
  }));
}

export async function searchPlanetMinecraftMods(query = '') {
  const url = planetMinecraftUrl(query, 'mods');
  const html = await electronTextRequest(url);
  const mods = parsePlanetMinecraftMods(html, url);

  if (!mods.length && query) {
    const fallbackUrl = `${PLANET_MINECRAFT_BASE}/mods/`;
    const fallbackHtml = await electronTextRequest(fallbackUrl);
    return parsePlanetMinecraftMods(fallbackHtml, fallbackUrl).filter((mod) => {
      return mod.title.toLowerCase().includes(query.toLowerCase());
    });
  }

  return mods;
}

export async function searchPlanetMinecraftResourcePacks(query = '') {
  const url = planetMinecraftUrl(query, 'resourcepacks');
  const html = await electronTextRequest(url);
  const packs = parsePlanetMinecraftResourcePacks(html, url);

  if (!packs.length && query) {
    const fallbackUrl = `${PLANET_MINECRAFT_BASE}/texture-packs/`;
    const fallbackHtml = await electronTextRequest(fallbackUrl);
    return parsePlanetMinecraftResourcePacks(fallbackHtml, fallbackUrl).filter((pack) => {
      return pack.title.toLowerCase().includes(query.toLowerCase());
    });
  }

  return packs;
}

export async function getCurseForgeFiles(modId, gameVersion = '1.20.4', loader = 'fabric') {
  const params = {
    gameVersion,
    pageSize: 50
  };

  if (loader && loader !== 'any') {
    params.modLoaderType = loader.toLowerCase() === 'forge' ? 1 : 4;
  }

  const { data } = await curseForgeGetWithVersionFallback(`${CURSEFORGE_API}/mods/${modId}/files`, {
    params,
    headers: curseForgeHeaders()
  });

  return data.data;
}

export async function getCurseForgeResourcePackFiles(modId, gameVersion = '1.20.4') {
  const { data } = await curseForgeGetWithVersionFallback(`${CURSEFORGE_API}/mods/${modId}/files`, {
    params: {
      gameVersion,
      pageSize: 50
    },
    headers: curseForgeHeaders()
  });

  return data.data;
}

export async function downloadCurseForgeMod({ modId, fileId, gameVersion = 'global', loader = 'fabric' }, onProgress) {
  let selectedFileId = fileId;
  let fileName = null;

  if (!selectedFileId) {
    const files = await getCurseForgeFiles(modId, gameVersion, loader);
    const file = files[0];
    selectedFileId = file?.id;
    fileName = file?.fileName;
  }

  if (!selectedFileId) {
    throw new Error(`No CurseForge file was found for mod ${modId} on Minecraft ${gameVersion}.`);
  }

  const fileResponse = await http.get(`${CURSEFORGE_API}/mods/${modId}/files/${selectedFileId}`, {
    headers: curseForgeHeaders()
  });

  const file = fileResponse.data.data;
  fileName = fileName || file.fileName || `${modId}-${selectedFileId}.jar`;

  let downloadUrl = file.downloadUrl;
  if (!downloadUrl) {
    const downloadResponse = await http.get(`${CURSEFORGE_API}/mods/${modId}/files/${selectedFileId}/download-url`, {
      headers: curseForgeHeaders(),
      responseType: 'text'
    });
    downloadUrl = typeof downloadResponse.data === 'string' ? downloadResponse.data : downloadResponse.data?.data;
  }

  if (!downloadUrl) {
    throw new Error('CurseForge did not provide a download URL. The project may disable third-party distribution.');
  }

  const modsDir = await ensureModsDirectory(gameVersion);
  const filePath = path.join(modsDir, fileName);

  return streamToFile({
    url: downloadUrl,
    filePath,
    fileName,
    source: 'curseforge',
    onProgress
  });
}

async function resolveCurseForgeDownload({ modId, fileId, gameVersion = '1.20.4', loader = 'fabric', resourcePack = false }) {
  let selectedFileId = fileId;
  let fileName = null;

  if (!selectedFileId) {
    const files = resourcePack
      ? await getCurseForgeResourcePackFiles(modId, gameVersion)
      : await getCurseForgeFiles(modId, gameVersion, loader);
    const file = files[0];
    selectedFileId = file?.id;
    fileName = file?.fileName;
  }

  if (!selectedFileId) {
    throw new Error(`No CurseForge file was found for ${modId} on Minecraft ${gameVersion}.`);
  }

  const fileResponse = await http.get(`${CURSEFORGE_API}/mods/${modId}/files/${selectedFileId}`, {
    headers: curseForgeHeaders()
  });

  const file = fileResponse.data.data;
  fileName = fileName || file.fileName || `${modId}-${selectedFileId}${resourcePack ? '.zip' : '.jar'}`;

  let downloadUrl = file.downloadUrl;
  if (!downloadUrl) {
    const downloadResponse = await http.get(`${CURSEFORGE_API}/mods/${modId}/files/${selectedFileId}/download-url`, {
      headers: curseForgeHeaders(),
      responseType: 'text'
    });
    downloadUrl = typeof downloadResponse.data === 'string' ? downloadResponse.data : downloadResponse.data?.data;
  }

  if (!downloadUrl) {
    throw new Error('CurseForge did not provide a download URL. The project may disable third-party distribution.');
  }

  return { downloadUrl, fileName };
}

export async function downloadCurseForgeResourcePack({ modId, fileId, gameVersion = '1.20.4', gameDirectory = '' }, onProgress) {
  const { downloadUrl, fileName } = await resolveCurseForgeDownload({
    modId,
    fileId,
    gameVersion,
    resourcePack: true
  });
  const resourcePacksDir = await ensureResourcePacksDirectory(gameDirectory);
  const filePath = path.join(resourcePacksDir, fileName);

  return streamToFile({
    url: downloadUrl,
    filePath,
    fileName,
    source: 'curseforge-resourcepack',
    onProgress
  });
}

export async function downloadMod(payload, onProgress) {
  const source = payload?.source === 'curseforge' ? 'curseforge' : 'modrinth';

  if (payload?.source === 'planetminecraft') {
    throw new Error('Planet Minecraft projects open externally because PMC does not provide a stable direct download API.');
  }

  if (source === 'curseforge') {
    return downloadCurseForgeMod(payload, onProgress);
  }

  return downloadModrinthMod(payload, onProgress);
}

export async function downloadResourcePack(payload, onProgress) {
  const source = payload?.source === 'curseforge' ? 'curseforge' : 'modrinth';

  if (payload?.source === 'planetminecraft') {
    throw new Error('Planet Minecraft resource packs open externally because PMC does not provide a stable direct download API.');
  }

  if (source === 'curseforge') {
    return downloadCurseForgeResourcePack(payload, onProgress);
  }

  return downloadModrinthResourcePack(payload, onProgress);
}

export async function getInstalledMods(version = null) {
  const baseDir = version ? getModsDirectory(version) : path.join(app.getPath('userData'), 'mods');
  await mkdir(baseDir, { recursive: true });
  const mods = [];

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.jar')) {
        continue;
      }

      const fileStat = await stat(entryPath);
      mods.push({
        name: entry.name,
        path: entryPath,
        size: fileStat.size,
        updatedAt: fileStat.mtime.toISOString()
      });
    }
  }

  await walk(baseDir);

  return mods;
}

export async function getInstalledResourcePacks(gameDirectory = '') {
  const resourcePacksDir = await ensureResourcePacksDirectory(gameDirectory);
  const entries = await readdir(resourcePacksDir, { withFileTypes: true });
  const packs = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.zip')) {
      continue;
    }

    const filePath = path.join(resourcePacksDir, entry.name);
    const fileStat = await stat(filePath);
    packs.push({
      name: entry.name,
      path: filePath,
      size: fileStat.size,
      updatedAt: fileStat.mtime.toISOString()
    });
  }

  return packs;
}

export async function deleteInstalledMod(filePath) {
  if (!filePath.startsWith(path.join(app.getPath('userData'), 'mods'))) {
    throw new Error('Refusing to delete a file outside the NeX Client mods directory.');
  }

  await unlink(filePath);
}
