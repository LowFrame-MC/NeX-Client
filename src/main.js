import 'dotenv/config';
import electron from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { authenticateUser, normalizeAuthProfile } from './auth.js';
import {
  downloadMod,
  downloadResourcePack,
  getInstalledMods,
  getInstalledResourcePacks,
  searchCurseForgeMods,
  searchCurseForgeResourcePacks,
  searchModrinthMods,
  searchModrinthResourcePacks,
  searchPlanetMinecraftMods,
  searchPlanetMinecraftResourcePacks
} from './downloader.js';
import {
  getLaunchPreview,
  getSupportedVersions,
  launchMinecraft
} from './launcher.js';

const { app, BrowserWindow, ipcMain, Menu, shell } = electron;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.argv.includes('--dev');

let mainWindow = null;
const runningGames = new Map();

function sendMinecraftLog(payload) {
  const entry = {
    timestamp: new Date().toISOString(),
    ...payload
  };

  const prefix = `[minecraft:${entry.version ?? 'unknown'}:${entry.stream ?? 'launcher'}]`;
  if (entry.level === 'error') {
    console.error(prefix, entry.message);
  } else {
    console.log(prefix, entry.message);
  }

  mainWindow?.webContents.send('minecraft-log', entry);
}

function resolveResourcePath(...segments) {
  if (app.isPackaged) {
    const resourcePath = path.join(process.resourcesPath, ...segments);
    if (existsSync(resourcePath)) {
      return resourcePath;
    }
  }

  return path.join(app.getAppPath(), ...segments);
}

function getUserConfigPath() {
  return path.join(app.getPath('userData'), 'client-mod', 'config-injector.json');
}

function getBundledConfigPath() {
  return resolveResourcePath('client-mod', 'config-injector.json');
}

async function ensureUserConfig() {
  const userConfigPath = getUserConfigPath();
  await mkdir(path.dirname(userConfigPath), { recursive: true });

  if (!existsSync(userConfigPath)) {
    const bundled = await readFile(getBundledConfigPath(), 'utf8');
    await writeFile(userConfigPath, bundled, 'utf8');
  }

  return userConfigPath;
}

async function readClientConfig() {
  const configPath = await ensureUserConfig();
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  return normalizeClientConfig(config);
}

async function writeClientConfig(config) {
  const configPath = await ensureUserConfig();
  const normalized = normalizeClientConfig(config);
  await writeFile(configPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

function normalizeClientConfig(config) {
  const normalized = structuredClone(config || {});
  normalized.versions ||= {};

  if (normalized.versions['1.21.1'] && !normalized.versions['1.21.11']) {
    normalized.versions['1.21.11'] = normalized.versions['1.21.1'];
  }

  delete normalized.versions['1.21.1'];
  return normalized;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: 'NeX Client',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    backgroundColor: '#0f0f11',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      devTools: isDev
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (isDev) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' });
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }

    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerApplicationMenu() {
  const template = [
    {
      label: 'NeX Client',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  ipcMain.handle('auth-login', async () => {
    const profile = await authenticateUser({ parentWindow: mainWindow });
    return { ok: true, profile: normalizeAuthProfile(profile) };
  });

  ipcMain.handle('search-mods', async (_event, payload = {}) => {
    const query = String(payload.query ?? '').trim();
    const source = ['curseforge', 'planetminecraft'].includes(payload.source) ? payload.source : 'modrinth';
    const gameVersion = String(payload.gameVersion ?? '1.20.4');
    const loader = String(payload.loader ?? 'fabric');

    let mods;
    if (source === 'curseforge') {
      mods = await searchCurseForgeMods(query, gameVersion, loader);
    } else if (source === 'planetminecraft') {
      mods = await searchPlanetMinecraftMods(query, gameVersion, loader);
    } else {
      mods = await searchModrinthMods(query, gameVersion, loader);
    }

    return { ok: true, mods };
  });

  ipcMain.handle('download-mod', async (event, payload = {}) => {
    const filePath = await downloadMod(payload, (progress) => {
      event.sender.send('download-progress', progress);
    });

    return { ok: true, filePath };
  });

  ipcMain.handle('installed-mods', async (_event, payload = {}) => {
    const mods = await getInstalledMods(payload.version || null);
    return { ok: true, mods };
  });

  ipcMain.handle('search-resource-packs', async (_event, payload = {}) => {
    const query = String(payload.query ?? '').trim();
    const source = ['curseforge', 'planetminecraft'].includes(payload.source) ? payload.source : 'modrinth';
    const gameVersion = String(payload.gameVersion ?? '1.20.4');

    let resourcePacks;
    if (source === 'curseforge') {
      resourcePacks = await searchCurseForgeResourcePacks(query, gameVersion);
    } else if (source === 'planetminecraft') {
      resourcePacks = await searchPlanetMinecraftResourcePacks(query);
    } else {
      resourcePacks = await searchModrinthResourcePacks(query, gameVersion);
    }

    return { ok: true, resourcePacks };
  });

  ipcMain.handle('download-resource-pack', async (event, payload = {}) => {
    const config = await readClientConfig();
    const filePath = await downloadResourcePack({
      ...payload,
      gameDirectory: payload.gameDirectory || config.launcher?.gameDirectory || ''
    }, (progress) => {
      event.sender.send('download-progress', progress);
    });

    return { ok: true, filePath };
  });

  ipcMain.handle('installed-resource-packs', async (_event, payload = {}) => {
    const config = await readClientConfig();
    const resourcePacks = await getInstalledResourcePacks(payload.gameDirectory || config.launcher?.gameDirectory || '');
    return { ok: true, resourcePacks };
  });

  ipcMain.handle('get-client-config', async () => {
    const config = await readClientConfig();
    return { ok: true, config, configPath: getUserConfigPath() };
  });

  ipcMain.handle('save-client-config', async (_event, config) => {
    const saved = await writeClientConfig(config);
    return { ok: true, config: saved, configPath: getUserConfigPath() };
  });

  ipcMain.handle('set-module-toggle', async (_event, payload = {}) => {
    const version = String(payload.version ?? '1.20.4');
    const moduleName = String(payload.moduleName ?? '');
    const enabled = Boolean(payload.enabled);
    const config = await readClientConfig();

    if (!config.versions?.[version]?.modules || !(moduleName in config.versions[version].modules)) {
      throw new Error(`Unknown module "${moduleName}" for Minecraft ${version}`);
    }

    config.versions[version].modules[moduleName] = enabled;
    config.updatedAt = new Date().toISOString();

    const saved = await writeClientConfig(config);
    return { ok: true, config: saved };
  });

  ipcMain.handle('launch-preview', async (_event, payload = {}) => {
    const config = await readClientConfig();
    const preview = await getLaunchPreview({
      version: payload.version,
      profile: normalizeAuthProfile(payload.profile),
      clientConfig: payload.clientConfig ?? config,
      mods: payload.mods ?? []
    });

    return { ok: true, preview };
  });

  ipcMain.handle('launch-game', async (_event, payload = {}) => {
    const config = await readClientConfig();
    const child = await launchMinecraft({
      version: payload.version,
      profile: normalizeAuthProfile(payload.profile),
      clientConfig: payload.clientConfig ?? config,
      mods: payload.mods ?? [],
      onLog: sendMinecraftLog
    });

    runningGames.set(child.pid, child);
    child.once('exit', () => runningGames.delete(child.pid));

    return { ok: true, pid: child.pid };
  });

  ipcMain.handle('supported-versions', () => {
    return { ok: true, versions: getSupportedVersions() };
  });

  ipcMain.handle('window-minimize', () => {
    mainWindow?.minimize();
    return { ok: true };
  });

  ipcMain.handle('window-maximize', () => {
    if (!mainWindow) {
      return { ok: false };
    }

    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }

    return { ok: true, maximized: mainWindow.isMaximized() };
  });

  ipcMain.handle('window-close', () => {
    mainWindow?.close();
    return { ok: true };
  });

  ipcMain.handle('app-meta', async () => {
    return {
      ok: true,
      version: app.getVersion(),
      userData: app.getPath('userData'),
      configPath: getUserConfigPath()
    };
  });

  ipcMain.handle('open-external', async (_event, url) => {
    const target = String(url || '');
    if (!target.startsWith('https://')) {
      throw new Error('Only HTTPS links can be opened externally.');
    }

    await shell.openExternal(target);
    return { ok: true };
  });
}

app.whenReady().then(async () => {
  await ensureUserConfig();
  registerApplicationMenu();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  for (const child of runningGames.values()) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
});

process.on('uncaughtException', (error) => {
  console.error('[main] uncaught exception', error);
  mainWindow?.webContents.send('app-error', {
    message: error.message,
    stack: isDev ? error.stack : undefined
  });
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error('[main] unhandled rejection', reason);
  mainWindow?.webContents.send('app-error', { message });
});
