const state = {
  user: null,
  config: null,
  configPath: '',
  installedMods: [],
  installedResourcePacks: [],
  currentTab: 'dashboard',
  lastCommand: ''
};

const modules = ['keystrokes', 'fullbright', 'cps_counter', 'fps_boost', 'armor_status'];
const runtimeRequiredModules = new Set(['keystrokes', 'cps_counter', 'armor_status']);

const elements = {};

function $(selector) {
  return document.querySelector(selector);
}

function $all(selector) {
  return Array.from(document.querySelectorAll(selector));
}

function bindElements() {
  Object.assign(elements, {
    titlebarStatus: $('#titlebarStatus'),
    profileAvatar: $('#profileAvatar'),
    profileName: $('#profileName'),
    profileMeta: $('#profileMeta'),
    loginButton: $('#loginButton'),
    logoutButton: $('#logoutButton'),
    versionSelect: $('#versionSelect'),
    loaderSelect: $('#loaderSelect'),
    memorySelect: $('#memorySelect'),
    selectedVersionBadge: $('#selectedVersionBadge'),
    moduleVersionPill: $('#moduleVersionPill'),
    launchButton: $('#launchButton'),
    previewButton: $('#previewButton'),
    launchNote: $('#launchNote'),
    sessionAccount: $('#sessionAccount'),
    installedModsCount: $('#installedModsCount'),
    configState: $('#configState'),
    commandPanel: $('#commandPanel'),
    commandOutput: $('#commandOutput'),
    copyCommandButton: $('#copyCommandButton'),
    minecraftConsoleOutput: $('#minecraftConsoleOutput'),
    clearConsoleButton: $('#clearConsoleButton'),
    modSearchInput: $('#modSearchInput'),
    modSourceSelect: $('#modSourceSelect'),
    searchModsButton: $('#searchModsButton'),
    modGrid: $('#modGrid'),
    resourcePackSearchInput: $('#resourcePackSearchInput'),
    resourcePackSourceSelect: $('#resourcePackSourceSelect'),
    searchResourcePacksButton: $('#searchResourcePacksButton'),
    resourcePackGrid: $('#resourcePackGrid'),
    resourcePackDownloadProgressCard: $('#resourcePackDownloadProgressCard'),
    resourcePackDownloadFileName: $('#resourcePackDownloadFileName'),
    resourcePackDownloadProgressText: $('#resourcePackDownloadProgressText'),
    resourcePackDownloadProgress: $('#resourcePackDownloadProgress'),
    downloadProgressCard: $('#downloadProgressCard'),
    downloadFileName: $('#downloadFileName'),
    downloadProgressText: $('#downloadProgressText'),
    downloadProgress: $('#downloadProgress'),
    gameDirectoryInput: $('#gameDirectoryInput'),
    javaPathInput: $('#javaPathInput'),
    windowWidthInput: $('#windowWidthInput'),
    windowHeightInput: $('#windowHeightInput'),
    saveSettingsButton: $('#saveSettingsButton'),
    appVersion: $('#appVersion'),
    configPath: $('#configPath')
  });
}

async function init() {
  bindElements();
  bindEvents();
  restoreUser();
  await loadMeta();
  await loadVersions();
  await loadConfig();
  await loadInstalledMods();
  await loadInstalledResourcePacks();
  updateProfile();
  updateDashboard();
  updateModuleToggles();
  await searchMods({ allowEmpty: true });
  await searchResourcePacks({ allowEmpty: true });
}

function bindEvents() {
  $('#windowClose').addEventListener('click', () => window.nex.window.close());
  $('#windowMinimize').addEventListener('click', () => window.nex.window.minimize());
  $('#windowMaximize').addEventListener('click', () => window.nex.window.maximize());

  $all('[data-tab-target]').forEach((button) => {
    button.addEventListener('click', () => switchTab(button.dataset.tabTarget));
  });

  elements.loginButton.addEventListener('click', login);
  elements.logoutButton.addEventListener('click', logout);
  elements.versionSelect.addEventListener('change', () => {
    elements.selectedVersionBadge.textContent = elements.versionSelect.value;
    elements.moduleVersionPill.textContent = elements.versionSelect.value;
    updateModuleToggles();
    updateDashboard();
    loadInstalledMods();
    searchMods({ allowEmpty: true });
    searchResourcePacks({ allowEmpty: true });
  });

  elements.memorySelect.addEventListener('change', () => {
    if (!state.config) return;
    state.config.launcher.memory.max = elements.memorySelect.value;
    saveConfig(false);
  });

  elements.launchButton.addEventListener('click', launchGame);
  elements.previewButton.addEventListener('click', previewCommand);
  elements.copyCommandButton.addEventListener('click', copyCommand);
  elements.clearConsoleButton.addEventListener('click', clearMinecraftConsole);
  elements.searchModsButton.addEventListener('click', searchMods);
  elements.searchResourcePacksButton.addEventListener('click', searchResourcePacks);
  elements.modSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      searchMods();
    }
  });
  elements.resourcePackSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      searchResourcePacks();
    }
  });

  $all('[data-source-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      $all('[data-source-tab]').forEach((tab) => tab.classList.toggle('active', tab === button));
      elements.modSourceSelect.value = button.dataset.sourceTab;
      searchMods({ allowEmpty: true });
    });
  });

  $all('[data-resource-source-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      $all('[data-resource-source-tab]').forEach((tab) => tab.classList.toggle('active', tab === button));
      elements.resourcePackSourceSelect.value = button.dataset.resourceSourceTab;
      searchResourcePacks({ allowEmpty: true });
    });
  });

  $all('[data-module-toggle]').forEach((toggle) => {
    toggle.addEventListener('change', () => updateModule(toggle.dataset.moduleToggle, toggle.checked));
  });

  elements.saveSettingsButton.addEventListener('click', () => saveSettings());

  window.nex.mods.onProgress((progress) => {
    updateDownloadProgress(progress);
  });

  window.nex.app.onError((error) => {
    toast(error.message || 'Application error', 'error');
  });

  window.nex.launcher.onLog((entry) => {
    appendMinecraftLog(entry);
  });
}

function restoreUser() {
  const saved = localStorage.getItem('nex.profile');
  if (!saved) {
    return;
  }

  try {
    state.user = JSON.parse(saved);
  } catch {
    localStorage.removeItem('nex.profile');
  }
}

async function loadMeta() {
  const result = await window.nex.app.meta();
  if (result.ok) {
    elements.appVersion.textContent = `v${result.version}`;
    elements.configPath.textContent = result.configPath;
    state.configPath = result.configPath;
  }
}

async function loadVersions() {
  const result = await window.nex.launcher.supportedVersions();
  const versions = result.ok ? result.versions : ['1.20.4'];
  const defaultVersion = versions.includes('1.21.11') ? '1.21.11' : versions.at(-1);
  elements.versionSelect.innerHTML = versions.map((version) => {
    const selected = version === defaultVersion ? 'selected' : '';
    return `<option value="${escapeHtml(version)}" ${selected}>${escapeHtml(version)}</option>`;
  }).join('');
  elements.selectedVersionBadge.textContent = elements.versionSelect.value;
  elements.moduleVersionPill.textContent = elements.versionSelect.value;
}

async function loadConfig() {
  try {
    const result = await window.nex.config.read();
    if (!result.ok) {
      throw new Error('Could not read config');
    }

    state.config = result.config;
    elements.configState.textContent = 'Loaded';
    hydrateSettings();
  } catch (error) {
    elements.configState.textContent = 'Error';
    toast(error.message, 'error');
  }
}

async function loadInstalledMods() {
  const result = await window.nex.mods.installed({ version: elements.versionSelect.value });
  if (result.ok) {
    state.installedMods = result.mods;
    elements.installedModsCount.textContent = String(result.mods.length);
  }
}

async function loadInstalledResourcePacks() {
  const result = await window.nex.resourcePacks.installed({
    gameDirectory: state.config?.launcher?.gameDirectory || ''
  });

  if (result.ok) {
    state.installedResourcePacks = result.resourcePacks;
  }
}

function hydrateSettings() {
  const launcher = state.config?.launcher || {};
  elements.gameDirectoryInput.value = launcher.gameDirectory || '';
  elements.javaPathInput.value = launcher.javaPath || '';
  elements.windowWidthInput.value = launcher.window?.width || 1280;
  elements.windowHeightInput.value = launcher.window?.height || 720;
  elements.memorySelect.value = launcher.memory?.max || '4G';
}

function switchTab(tab) {
  state.currentTab = tab;
  $all('[data-tab-target]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tabTarget === tab);
  });
  $all('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === tab);
  });
}

async function login() {
  setBusy('Opening Microsoft login');
  elements.loginButton.disabled = true;

  try {
    const result = await window.nex.auth.login();
    if (!result.ok) {
      throw new Error(result.error || 'Login failed');
    }

    state.user = result.profile;
    localStorage.setItem('nex.profile', JSON.stringify(state.user));
    updateProfile();
    updateDashboard();
    toast(`Signed in as ${state.user.username}`, 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    elements.loginButton.disabled = false;
    setBusy('Ready');
  }
}

function logout() {
  state.user = null;
  localStorage.removeItem('nex.profile');
  updateProfile();
  updateDashboard();
  toast('Signed out', 'success');
}

function updateProfile() {
  if (!state.user) {
    elements.profileAvatar.textContent = '?';
    elements.profileName.textContent = 'Signed out';
    elements.profileMeta.textContent = 'Microsoft account required';
    elements.loginButton.classList.remove('hidden');
    elements.logoutButton.classList.add('hidden');
    return;
  }

  elements.profileAvatar.innerHTML = `<img src="https://crafatar.com/avatars/${encodeURIComponent(state.user.uuid)}?size=84&overlay" alt="">`;
  elements.profileName.textContent = state.user.username;
  elements.profileMeta.textContent = state.user.userType.toUpperCase();
  elements.loginButton.classList.add('hidden');
  elements.logoutButton.classList.remove('hidden');
}

function updateDashboard() {
  elements.sessionAccount.textContent = state.user?.username || 'Offline';
}

function getCurrentVersionConfig() {
  const version = elements.versionSelect.value;
  return state.config?.versions?.[version] || null;
}

function updateModuleToggles() {
  const versionConfig = getCurrentVersionConfig();
  const versionModules = versionConfig?.modules || {};

  for (const name of modules) {
    const toggle = $(`[data-module-toggle="${name}"]`);
    if (toggle) {
      toggle.checked = Boolean(versionModules[name]);
    }
  }
}

async function updateModule(moduleName, enabled) {
  const version = elements.versionSelect.value;

  try {
    const result = await window.nex.config.setModule({ version, moduleName, enabled });
    if (!result.ok) {
      throw new Error('Could not update module config');
    }

    state.config = result.config;
    elements.configState.textContent = 'Saved';
    if (enabled && runtimeRequiredModules.has(moduleName)) {
      toast(`${formatModuleName(moduleName)} saved for ${version}. It needs the NeX runtime mod in-game.`, 'success', 3600);
    } else {
      toast(`${formatModuleName(moduleName)} ${enabled ? 'enabled' : 'disabled'} for ${version}`, 'success', 1800);
    }
  } catch (error) {
    toast(error.message, 'error');
    updateModuleToggles();
  }
}

async function saveSettings() {
  if (!state.config) return;

  state.config.launcher.gameDirectory = elements.gameDirectoryInput.value.trim();
  state.config.launcher.javaPath = elements.javaPathInput.value.trim();
  state.config.launcher.memory.max = elements.memorySelect.value;
  state.config.launcher.window.width = Number(elements.windowWidthInput.value || 1280);
  state.config.launcher.window.height = Number(elements.windowHeightInput.value || 720);
  state.config.updatedAt = new Date().toISOString();

  await saveConfig(true);
}

async function saveConfig(showToast) {
  const result = await window.nex.config.save(state.config);
  if (result.ok) {
    state.config = result.config;
    elements.configState.textContent = 'Saved';
    if (showToast) {
      toast('Settings saved', 'success');
    }
  }
}

async function launchGame() {
  if (!state.user) {
    toast('Login before launching Minecraft.', 'error');
    return;
  }

  setBusy('Launching');
  elements.launchButton.disabled = true;

  try {
    clearMinecraftConsole();
    appendMinecraftLog({
      timestamp: new Date().toISOString(),
      level: 'info',
      stream: 'renderer',
      version: elements.versionSelect.value,
      message: 'Launch requested from NeX Client.'
    });

    const result = await window.nex.launcher.launch({
      version: elements.versionSelect.value,
      profile: state.user,
      clientConfig: state.config,
      mods: state.installedMods.map((mod) => mod.path)
    });

    if (!result.ok) {
      throw new Error(result.error || 'Launch failed');
    }

    elements.launchNote.textContent = `Minecraft process started with PID ${result.pid}.`;
    toast('Minecraft launched', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    elements.launchButton.disabled = false;
    setBusy('Ready');
  }
}

function clearMinecraftConsole() {
  elements.minecraftConsoleOutput.textContent = 'Waiting for launch...';
}

function appendMinecraftLog(entry) {
  const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
  const stream = entry.stream || 'launcher';
  const level = entry.level || 'info';
  const version = entry.version || elements.versionSelect.value;
  const line = `[${time}] [${version}] [${stream}/${level}] ${entry.message}`;

  if (elements.minecraftConsoleOutput.textContent === 'Waiting for launch...') {
    elements.minecraftConsoleOutput.textContent = line;
  } else {
    elements.minecraftConsoleOutput.textContent += `\n${line}`;
  }

  elements.minecraftConsoleOutput.scrollTop = elements.minecraftConsoleOutput.scrollHeight;
  console[level === 'error' ? 'error' : 'log'](`[minecraft:${stream}]`, entry.message);
}

async function previewCommand() {
  if (!state.user) {
    toast('Login first so the command can include profile tokens.', 'error');
    return;
  }

  try {
    const result = await window.nex.launcher.preview({
      version: elements.versionSelect.value,
      profile: state.user,
      clientConfig: state.config,
      mods: state.installedMods.map((mod) => mod.path)
    });

    if (!result.ok) {
      throw new Error('Preview failed');
    }

    state.lastCommand = result.preview.commandLine;
    elements.commandOutput.textContent = state.lastCommand;
    elements.commandPanel.classList.remove('hidden');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function copyCommand() {
  if (!state.lastCommand) {
    return;
  }

  await navigator.clipboard.writeText(state.lastCommand);
  toast('Command copied', 'success', 1600);
}

async function searchMods(options = {}) {
  const query = elements.modSearchInput.value.trim();
  if (!options.allowEmpty && query.length > 0 && query.length < 2) {
    toast('Enter at least two characters.', 'error');
    return;
  }

  setBusy(query ? 'Searching mods' : 'Loading featured mods');
  elements.searchModsButton.disabled = true;
  elements.modGrid.innerHTML = '<div class="empty-state"><strong>Searching...</strong><span>Please wait.</span></div>';

  try {
    const result = await window.nex.mods.search({
      query,
      source: elements.modSourceSelect.value,
      gameVersion: elements.versionSelect.value,
      loader: elements.loaderSelect.value
    });

    if (!result.ok) {
      throw new Error(result.error || 'Search failed');
    }

    renderMods(result.mods);
  } catch (error) {
    elements.modGrid.innerHTML = `<div class="empty-state"><strong>Search failed.</strong><span>${escapeHtml(error.message)}</span></div>`;
    toast(error.message, 'error');
  } finally {
    elements.searchModsButton.disabled = false;
    setBusy('Ready');
  }
}

function renderMods(mods) {
  if (!mods.length) {
    elements.modGrid.innerHTML = '<div class="empty-state"><strong>No matching mods found.</strong><span>Try a different search.</span></div>';
    return;
  }

  elements.modGrid.innerHTML = mods.map((mod, index) => `
    <article class="mod-card">
      <div class="mod-art">
        ${mod.iconUrl ? `<img src="${escapeAttribute(mod.iconUrl)}" alt="">` : '<strong>MOD</strong>'}
      </div>
      <div class="mod-body">
        <h3>${escapeHtml(mod.title)}</h3>
        <p>${escapeHtml(mod.description || 'No description provided.')}</p>
      </div>
      <div class="mod-meta">↓ ${formatDownloads(mod.downloads)}</div>
      <button class="btn primary" data-download-index="${index}">${mod.source === 'planetminecraft' ? 'Open' : 'Install'}</button>
    </article>
  `).join('');

  $all('[data-download-index]').forEach((button) => {
    button.addEventListener('click', () => downloadMod(mods[Number(button.dataset.downloadIndex)]));
  });
}

async function searchResourcePacks(options = {}) {
  const query = elements.resourcePackSearchInput.value.trim();
  if (!options.allowEmpty && query.length > 0 && query.length < 2) {
    toast('Enter at least two characters.', 'error');
    return;
  }

  setBusy(query ? 'Searching resource packs' : 'Loading featured resource packs');
  elements.searchResourcePacksButton.disabled = true;
  elements.resourcePackGrid.innerHTML = '<div class="empty-state"><strong>Searching...</strong><span>Please wait.</span></div>';

  try {
    const result = await window.nex.resourcePacks.search({
      query,
      source: elements.resourcePackSourceSelect.value,
      gameVersion: elements.versionSelect.value
    });

    if (!result.ok) {
      throw new Error(result.error || 'Search failed');
    }

    renderResourcePacks(result.resourcePacks);
  } catch (error) {
    elements.resourcePackGrid.innerHTML = `<div class="empty-state"><strong>Search failed.</strong><span>${escapeHtml(error.message)}</span></div>`;
    toast(error.message, 'error');
  } finally {
    elements.searchResourcePacksButton.disabled = false;
    setBusy('Ready');
  }
}

function renderResourcePacks(resourcePacks) {
  if (!resourcePacks.length) {
    elements.resourcePackGrid.innerHTML = '<div class="empty-state"><strong>No matching resource packs found.</strong><span>Try a different search.</span></div>';
    return;
  }

  elements.resourcePackGrid.innerHTML = resourcePacks.map((pack, index) => `
    <article class="mod-card">
      <div class="mod-art resource-pack-art">
        ${pack.iconUrl ? `<img src="${escapeAttribute(pack.iconUrl)}" alt="">` : '<strong>PACK</strong>'}
      </div>
      <div class="mod-body">
        <h3>${escapeHtml(pack.title)}</h3>
        <p>${escapeHtml(pack.description || 'No description provided.')}</p>
      </div>
      <div class="mod-meta">↓ ${formatDownloads(pack.downloads)}</div>
      <button class="btn primary" data-resource-pack-index="${index}">${pack.source === 'planetminecraft' ? 'Open' : 'Install'}</button>
    </article>
  `).join('');

  $all('[data-resource-pack-index]').forEach((button) => {
    button.addEventListener('click', () => downloadResourcePack(resourcePacks[Number(button.dataset.resourcePackIndex)]));
  });
}

async function downloadMod(mod) {
  if (mod.source === 'planetminecraft') {
    if (!mod.websiteUrl) {
      toast('Planet Minecraft did not provide a project URL.', 'error');
      return;
    }

    await window.nex.app.openExternal(mod.websiteUrl);
    toast('Opened Planet Minecraft project page', 'success');
    return;
  }

  const payload = {
    source: mod.source,
    gameVersion: elements.versionSelect.value,
    loader: elements.loaderSelect.value
  };

  if (mod.source === 'curseforge') {
    payload.modId = mod.id;
  } else {
    payload.projectId = mod.id;
  }

  try {
    setBusy('Downloading mod');
    const result = await window.nex.mods.download(payload);
    if (!result.ok) {
      throw new Error(result.error || 'Download failed');
    }

    await loadInstalledMods();
    toast('Mod downloaded', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy('Ready');
  }
}

async function downloadResourcePack(pack) {
  if (pack.source === 'planetminecraft') {
    if (!pack.websiteUrl) {
      toast('Planet Minecraft did not provide a project URL.', 'error');
      return;
    }

    await window.nex.app.openExternal(pack.websiteUrl);
    toast('Opened Planet Minecraft resource pack page', 'success');
    return;
  }

  const payload = {
    source: pack.source,
    gameVersion: elements.versionSelect.value,
    gameDirectory: state.config?.launcher?.gameDirectory || ''
  };

  if (pack.source === 'curseforge') {
    payload.modId = pack.id;
  } else {
    payload.projectId = pack.id;
  }

  try {
    setBusy('Downloading resource pack');
    const result = await window.nex.resourcePacks.download(payload);
    if (!result.ok) {
      throw new Error(result.error || 'Download failed');
    }

    await loadInstalledResourcePacks();
    toast('Resource pack installed into Minecraft', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy('Ready');
  }
}

function updateDownloadProgress(progress) {
  const percent = progress.percent || progress.progress || 0;
  const targets = [
    {
      card: elements.downloadProgressCard,
      fileName: elements.downloadFileName,
      progressText: elements.downloadProgressText,
      progressBar: elements.downloadProgress
    },
    {
      card: elements.resourcePackDownloadProgressCard,
      fileName: elements.resourcePackDownloadFileName,
      progressText: elements.resourcePackDownloadProgressText,
      progressBar: elements.resourcePackDownloadProgress
    }
  ];

  for (const target of targets) {
    target.card.classList.remove('hidden');
    target.fileName.textContent = progress.fileName || 'Downloading';
    target.progressBar.value = percent;
    target.progressText.textContent = `${percent}%`;
  }

  if (progress.phase === 'complete' || percent === 100) {
    setTimeout(() => {
      elements.downloadProgressCard.classList.add('hidden');
      elements.resourcePackDownloadProgressCard.classList.add('hidden');
    }, 1600);
  }
}

function setBusy(text) {
  elements.titlebarStatus.textContent = text;
}

function toast(message, type = 'success', duration = 3200) {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  $('#toastRegion').appendChild(node);
  setTimeout(() => node.remove(), duration);
}

function formatModuleName(name) {
  return name.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function formatDownloads(value) {
  const downloads = Number(value || 0);

  if (downloads >= 1000000) {
    return `${(downloads / 1000000).toFixed(1)}M`;
  }

  if (downloads >= 1000) {
    return `${(downloads / 1000).toFixed(1)}K`;
  }

  return downloads.toLocaleString();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[char]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => {
    toast(error.message, 'error');
  });
});
