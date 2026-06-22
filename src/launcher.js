import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import mclc from 'minecraft-launcher-core';

const { Client: MinecraftClient } = mclc;

export const SUPPORTED_VERSIONS = Object.freeze([
  '1.8.9',
  '1.12.2',
  '1.16.5',
  '1.18.2',
  '1.19.2',
  '1.20.1',
  '1.20.4',
  '1.20.6',
  '1.21',
  '1.21.11'
]);

const DEFAULT_WINDOW = { width: 1280, height: 720 };
const RUNTIME_REQUIRED_MODULES = Object.freeze(['keystrokes', 'cps_counter', 'armor_status']);
const LEGACY_ASSET_INDEX = {
  '1.8.9': '1.8',
  '1.12.2': '1.12'
};

function platformKey() {
  if (process.platform === 'win32') {
    return 'windows';
  }

  if (process.platform === 'darwin') {
    return 'osx';
  }

  return 'linux';
}

export function getNexRootDirectory() {
  return path.join(os.homedir(), '.nex');
}

export function getInstanceDirectory(version = 'global') {
  return path.join(getNexRootDirectory(), 'instances', String(version || 'global'));
}

async function findWindowsJavaRoots(preferredMajor) {
  const roots = [];
  const baseDirs = [
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Java'
  ];

  for (const baseDir of baseDirs) {
    if (!existsSync(baseDir)) {
      continue;
    }

    const entries = await readdir(baseDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const match = entry.name.match(/(?:jdk|jre)-?(\d+)/i);
      if (!match) {
        continue;
      }

      roots.push({
        major: Number(match[1]),
        path: path.join(baseDir, entry.name)
      });
    }
  }

  return roots
    .sort((a, b) => {
      const aDistance = Math.abs(a.major - preferredMajor);
      const bDistance = Math.abs(b.major - preferredMajor);
      return aDistance - bDistance || b.major - a.major;
    })
    .map((root) => root.path);
}

function preferredJavaMajor(version) {
  if (['1.8.9', '1.12.2'].includes(version)) {
    return 8;
  }

  if (version.startsWith('1.21')) {
    return 21;
  }

  return 17;
}

async function getDefaultJavaCandidates(version) {
  const wantsJava8 = ['1.8.9', '1.12.2'].includes(version);
  const javaExe = process.platform === 'win32' ? 'javaw.exe' : 'java';
  const javaBin = process.platform === 'win32' ? 'java.exe' : 'java';

  if (process.platform === 'win32') {
    const discoveredRoots = await findWindowsJavaRoots(preferredJavaMajor(version));
    const configuredRoots = [process.env.JAVA_HOME, process.env.JDK_HOME].filter(Boolean);
    const roots = [...discoveredRoots, ...configuredRoots];

    return [
      ...roots.map((root) => path.join(root, 'bin', wantsJava8 ? javaBin : javaExe)),
      javaBin
    ];
  }

  return [
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : null,
    '/usr/lib/jvm/java-21-openjdk-amd64/bin/java',
    '/usr/lib/jvm/java-17-openjdk-amd64/bin/java',
    '/usr/lib/jvm/java-8-openjdk-amd64/bin/java',
    'java'
  ].filter(Boolean);
}

async function findJavaExecutable(version, clientConfig = {}) {
  const configured = clientConfig?.launcher?.javaPath;
  if (configured) {
    return configured;
  }

  for (const candidate of await getDefaultJavaCandidates(version)) {
    if (candidate === 'java' || candidate === 'java.exe') {
      return candidate;
    }

    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return process.platform === 'win32' ? 'java.exe' : 'java';
}

function checkRule(rule, features = {}) {
  let allowed = rule.action === 'allow';

  if (rule.os) {
    const current = platformKey();
    const osNameMatches = rule.os.name ? rule.os.name === current : true;
    const osArchMatches = rule.os.arch ? rule.os.arch === process.arch || (rule.os.arch === 'x86' && process.arch === 'ia32') : true;
    allowed = osNameMatches && osArchMatches ? allowed : !allowed;
  }

  if (rule.features) {
    const featureMatches = Object.entries(rule.features).every(([key, expected]) => {
      return Boolean(features[key]) === Boolean(expected);
    });
    allowed = featureMatches ? allowed : !allowed;
  }

  return allowed;
}

function isAllowedByRules(rules, features = {}) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return true;
  }

  return rules.reduce((allowed, rule) => checkRule(rule, features), false);
}

function artifactPathFromName(librariesDir, name) {
  const [group, artifact, version] = name.split(':');
  const groupPath = group.replaceAll('.', path.sep);
  const fileName = `${artifact}-${version}.jar`;
  return path.join(librariesDir, groupPath, artifact, version, fileName);
}

function nativeClassifierKey() {
  if (process.platform === 'win32') {
    return 'natives-windows';
  }

  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'natives-macos-arm64' : 'natives-macos';
  }

  return 'natives-linux';
}

function resolveLibraryPath(library, librariesDir) {
  const artifact = library.downloads?.artifact;
  if (artifact?.path) {
    return path.join(librariesDir, artifact.path);
  }

  return artifactPathFromName(librariesDir, library.name);
}

function resolveNativePath(library, librariesDir) {
  const classifiers = library.downloads?.classifiers || {};
  const natives = library.natives || {};
  const osKey = platformKey();
  const classifierName = natives[osKey]?.replace('${arch}', process.arch === 'x64' ? '64' : '32') || nativeClassifierKey();
  const classifier = classifiers[classifierName];

  if (!classifier?.path) {
    return null;
  }

  return path.join(librariesDir, classifier.path);
}

function getMainClass(versionJson) {
  return versionJson.mainClass || 'net.minecraft.client.main.Main';
}

async function readVersionJson(version, minecraftDir) {
  const versionJsonPath = path.join(minecraftDir, 'versions', version, `${version}.json`);

  if (!existsSync(versionJsonPath)) {
    throw new Error(`Minecraft ${version} is not installed. Missing ${versionJsonPath}`);
  }

  return JSON.parse(await readFile(versionJsonPath, 'utf8'));
}

function flattenArguments(argumentList, variables, features = {}) {
  const flattened = [];

  for (const entry of argumentList || []) {
    if (typeof entry === 'string') {
      flattened.push(replaceVariables(entry, variables));
      continue;
    }

    if (entry?.rules && !isAllowedByRules(entry.rules, features)) {
      continue;
    }

    const value = Array.isArray(entry.value) ? entry.value : [entry.value];
    for (const item of value.filter(Boolean)) {
      const replaced = replaceVariables(item, variables);
      if (replaced !== '') {
        flattened.push(replaced);
      }
    }
  }

  return flattened;
}

function replaceVariables(value, variables) {
  return String(value).replace(/\$\{([^}]+)\}/g, (_match, key) => {
    return variables[key] ?? '';
  });
}

function versionNeedsVariable(versionJson, variableName) {
  const serialized = JSON.stringify(versionJson.arguments?.game || versionJson.minecraftArguments || '');
  return serialized.includes(`\${${variableName}}`);
}

function legacyGameArguments(versionJson, variables) {
  const template = versionJson.minecraftArguments || [
    '--username',
    '${auth_player_name}',
    '--version',
    '${version_name}',
    '--gameDir',
    '${game_directory}',
    '--assetsDir',
    '${assets_root}',
    '--assetIndex',
    '${assets_index_name}',
    '--uuid',
    '${auth_uuid}',
    '--accessToken',
    '${auth_access_token}',
    '--userType',
    '${user_type}',
    '--versionType',
    '${version_type}'
  ].join(' ');

  return template.split(/\s+/).filter(Boolean).map((arg) => replaceVariables(arg, variables));
}

function buildFeatureFlags(profile, clientConfig = {}) {
  const quickPlay = clientConfig.launcher?.quickPlay || {};

  return {
    is_demo_user: Boolean(profile.demo),
    has_custom_resolution: Boolean(clientConfig.launcher?.window),
    has_quick_plays_support: Boolean(quickPlay.path),
    is_quick_play_singleplayer: Boolean(quickPlay.singleplayer),
    is_quick_play_multiplayer: Boolean(quickPlay.multiplayer),
    is_quick_play_realms: Boolean(quickPlay.realms)
  };
}

function createClasspath(versionJson, version, minecraftDir, mods = []) {
  const librariesDir = path.join(minecraftDir, 'libraries');
  const classpathEntries = [];
  const nativeEntries = [];

  for (const library of versionJson.libraries || []) {
    if (!isAllowedByRules(library.rules)) {
      continue;
    }

    const libraryPath = resolveLibraryPath(library, librariesDir);
    if (existsSync(libraryPath)) {
      classpathEntries.push(libraryPath);
    }

    const nativePath = resolveNativePath(library, librariesDir);
    if (nativePath && existsSync(nativePath)) {
      nativeEntries.push(nativePath);
    }
  }

  classpathEntries.push(path.join(minecraftDir, 'versions', version, `${version}.jar`));

  for (const modPath of mods || []) {
    if (modPath && existsSync(modPath)) {
      classpathEntries.push(modPath);
    }
  }

  return {
    classpath: classpathEntries.join(path.delimiter),
    nativeEntries
  };
}

function extractVersionConfig(config, version) {
  if (config?.versions?.[version]) {
    return config.versions[version];
  }

  if (config?.[version]) {
    return { modules: config[version] };
  }

  return { modules: {} };
}

function buildModuleJvmArgs(versionConfig) {
  const modules = versionConfig.modules || {};
  const args = [];

  for (const [name, enabled] of Object.entries(modules)) {
    args.push(`-Dnex.module.${name}=${Boolean(enabled)}`);
  }

  if (modules.fullbright) {
    args.push('-Dnex.gamma.override=1000');
  }

  if (modules.fps_boost) {
    args.push('-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=50');
  }

  return args;
}

async function patchOptionsFileForFullbright(minecraftDir) {
  const optionsPath = path.join(minecraftDir, 'options.txt');
  let contents = '';

  try {
    contents = await readFile(optionsPath, 'utf8');
  } catch {
    contents = '';
  }

  const lines = contents.split(/\r?\n/).filter((line, index, list) => line.length > 0 || index < list.length - 1);
  const gammaIndex = lines.findIndex((line) => line.startsWith('gamma:'));

  if (gammaIndex >= 0) {
    lines[gammaIndex] = 'gamma:1000.0';
  } else {
    lines.push('gamma:1000.0');
  }

  await writeFile(optionsPath, `${lines.join('\n')}\n`, 'utf8');
  return optionsPath;
}

async function writeRuntimeModuleConfig({ minecraftDir, version, modules }) {
  const runtimeDir = path.join(minecraftDir, 'config');
  await mkdir(runtimeDir, { recursive: true });

  const runtimeConfigPath = path.join(runtimeDir, 'nex-client-modules.json');
  const runtimeConfig = {
    schemaVersion: 1,
    launcher: 'NeX Client',
    version,
    updatedAt: new Date().toISOString(),
    modules: {
      keystrokes: Boolean(modules.keystrokes),
      fullbright: Boolean(modules.fullbright),
      cps_counter: Boolean(modules.cps_counter),
      fps_boost: Boolean(modules.fps_boost),
      armor_status: Boolean(modules.armor_status)
    }
  };

  await writeFile(runtimeConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, 'utf8');
  return runtimeConfigPath;
}

async function applyClientSideSettings({ command, onLog }) {
  const modules = command.modules || {};
  const minecraftDir = command.instanceDir || command.cwd;
  const runtimeConfigPath = await writeRuntimeModuleConfig({
    minecraftDir,
    version: command.version,
    modules
  });

  onLog({
    level: 'info',
    stream: 'launcher',
    version: command.version,
    message: `Wrote NeX module runtime config: ${runtimeConfigPath}`
  });

  if (modules.fullbright) {
    const optionsPath = await patchOptionsFileForFullbright(minecraftDir);
    onLog({
      level: 'info',
      stream: 'launcher',
      version: command.version,
      message: `Fullbright applied by setting gamma:1000.0 in ${optionsPath}`
    });
  }

  if (modules.fps_boost) {
    onLog({
      level: 'info',
      stream: 'launcher',
      version: command.version,
      message: 'FPS Boost JVM tuning is enabled for this launch.'
    });
  }

  for (const moduleName of RUNTIME_REQUIRED_MODULES) {
    if (!modules[moduleName]) {
      continue;
    }

    onLog({
      level: 'warn',
      stream: 'launcher',
      version: command.version,
      message: `${moduleName} is saved in the NeX runtime config, but it needs a compatible in-game NeX/Fabric runtime mod to render in Minecraft.`
    });
  }
}

function buildJvmArgs(versionJson, variables, versionConfig, clientConfig) {
  const memory = clientConfig?.launcher?.memory || {};
  const minMemory = memory.min || '1G';
  const maxMemory = memory.max || '4G';
  const configured = clientConfig?.launcher?.extraJvmArgs || [];
  const moduleArgs = buildModuleJvmArgs(versionConfig);
  const nativeDir = variables.natives_directory;

  const base = [
    `-Xms${minMemory}`,
    `-Xmx${maxMemory}`,
    `-Djava.library.path=${nativeDir}`,
    '-Dminecraft.launcher.brand=NeXClient',
    '-Dminecraft.launcher.version=1.0.0'
  ];

  if (versionJson.arguments?.jvm) {
    return [
      ...base,
      ...flattenArguments(versionJson.arguments.jvm, variables).filter((arg) => {
        return !arg.startsWith('-Xmx') &&
          !arg.startsWith('-Xms') &&
          !arg.startsWith('-Djava.library.path=') &&
          !arg.startsWith('-Dminecraft.launcher.brand=') &&
          !arg.startsWith('-Dminecraft.launcher.version=');
      }),
      ...moduleArgs,
      ...configured
    ];
  }

  return [
    ...base,
    '-Dlog4j.configurationFile=${path_to_asset_index}',
    ...moduleArgs,
    ...configured
  ];
}

async function collectVersionMods(version) {
  const modsDir = path.join(getInstanceDirectory(version), 'mods');

  if (!existsSync(modsDir)) {
    return [];
  }

  const files = await readdir(modsDir);
  return files.filter((file) => file.endsWith('.jar')).map((file) => path.join(modsDir, file));
}

export function getSupportedVersions() {
  return [...SUPPORTED_VERSIONS];
}

function normalizeMclcAuth(profile) {
  return {
    access_token: profile.accessToken,
    client_token: profile.clientId || profile.uuid,
    uuid: profile.uuid,
    name: profile.username,
    user_properties: JSON.stringify(profile.userProperties || {}),
    meta: {
      type: profile.userType || 'msa',
      demo: Boolean(profile.demo),
      xuid: profile.xuid || '',
      clientId: profile.clientId || ''
    }
  };
}

async function buildMclcOptions({ version, profile, clientConfig = {}, mods = [] }) {
  if (!SUPPORTED_VERSIONS.includes(version)) {
    throw new Error(`Unsupported version "${version}". Supported versions: ${SUPPORTED_VERSIONS.join(', ')}`);
  }

  if (!profile?.username || !profile?.uuid || !profile?.accessToken) {
    throw new Error('A valid Microsoft Minecraft profile is required before launch.');
  }

  const instanceDir = getInstanceDirectory(version);
  await mkdir(path.join(instanceDir, 'mods'), { recursive: true });
  await mkdir(path.join(instanceDir, 'resourcepacks'), { recursive: true });
  await mkdir(path.join(instanceDir, 'natives'), { recursive: true });

  const memory = clientConfig?.launcher?.memory || {};
  const launcherWindow = clientConfig?.launcher?.window || DEFAULT_WINDOW;
  const versionConfig = extractVersionConfig(clientConfig, version);
  const javaExecutable = await findJavaExecutable(version, clientConfig);
  const moduleArgs = buildModuleJvmArgs(versionConfig);
  const extraJvmArgs = clientConfig?.launcher?.extraJvmArgs || [];
  const customArgs = [...moduleArgs, ...extraJvmArgs];
  const mergedMods = [...mods, ...(await collectVersionMods(version))].filter(Boolean);

  return {
    version,
    instanceDir,
    options: {
      authorization: normalizeMclcAuth(profile),
      root: instanceDir,
      cache: path.join(getNexRootDirectory(), 'cache'),
      version: {
        number: version,
        type: 'release'
      },
      memory: {
        min: memory.min || '1G',
        max: memory.max || '4G'
      },
      javaPath: javaExecutable,
      customArgs,
      window: {
        width: Number(launcherWindow.width || DEFAULT_WINDOW.width),
        height: Number(launcherWindow.height || DEFAULT_WINDOW.height)
      },
      overrides: {
        gameDirectory: instanceDir,
        cwd: instanceDir,
        natives: path.join(instanceDir, 'natives', version),
        detached: false
      }
    },
    javaExecutable,
    mods: mergedMods,
    modules: versionConfig.modules || {},
    commandLine: `MCLC launch ${version} from ${quoteCommandPart(instanceDir)} using ${quoteCommandPart(javaExecutable)}`
  };
}

export async function buildLaunchCommand(options) {
  const mclcLaunch = await buildMclcOptions(options);
  return {
    version: mclcLaunch.version,
    javaExecutable: mclcLaunch.javaExecutable,
    args: [],
    commandLine: mclcLaunch.commandLine,
    cwd: mclcLaunch.instanceDir,
    classpath: '',
    nativeEntries: [],
    modules: mclcLaunch.modules
  };
}

function quoteCommandPart(part) {
  const value = String(part);
  if (!/[\s"]/u.test(value)) {
    return value;
  }

  return `"${value.replaceAll('"', '\\"')}"`;
}

export async function getLaunchPreview(options) {
  const command = await buildLaunchCommand(options);
  return {
    version: command.version,
    commandLine: command.commandLine,
    cwd: command.cwd,
    modules: command.modules
  };
}

export async function launchMinecraft(options) {
  const command = await buildMclcOptions(options);
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};

  await applyClientSideSettings({ command, onLog });

  onLog({
    level: 'info',
    stream: 'launcher',
    version: command.version,
    message: `Launching Minecraft ${command.version}`
  });
  onLog({
    level: 'debug',
    stream: 'launcher',
    version: command.version,
    message: `Instance directory: ${command.instanceDir}`
  });
  onLog({
    level: 'debug',
    stream: 'launcher',
    version: command.version,
    message: `Java executable: ${command.javaExecutable}`
  });
  onLog({
    level: 'debug',
    stream: 'launcher',
    version: command.version,
    message: 'MCLC will download missing Minecraft files into this NeX instance before launch.'
  });

  const launcher = new MinecraftClient();

  launcher.on('debug', (message) => {
    onLog({
      level: 'debug',
      stream: 'mclc',
      version: command.version,
      message: String(message)
    });
  });

  launcher.on('data', (message) => {
    onLog({
      level: 'info',
      stream: 'stdout',
      version: command.version,
      message: String(message).trim()
    });
  });

  launcher.on('download', (message) => {
    onLog({
      level: 'info',
      stream: 'download',
      version: command.version,
      message: String(message)
    });
  });

  launcher.on('progress', (progress) => {
    onLog({
      level: 'info',
      stream: 'download',
      version: command.version,
      message: `${progress.type || 'files'} ${progress.task || 0}/${progress.total || 0}`
    });
  });

  launcher.on('arguments', (launchArguments) => {
    onLog({
      level: 'debug',
      stream: 'launcher',
      version: command.version,
      message: Array.isArray(launchArguments) ? launchArguments.map(quoteCommandPart).join(' ') : String(launchArguments)
    });
  });

  const child = await launcher.launch(command.options);

  if (!child) {
    throw new Error('MCLC did not return a Minecraft process.');
  }

  onLog({
    level: 'info',
    stream: 'launcher',
    version: command.version,
    pid: child.pid,
    message: `Minecraft process started with PID ${child.pid}`
  });

  child.on('error', (error) => {
    console.error(`[minecraft:${command.version}] failed to start`, error);
    onLog({
      level: 'error',
      stream: 'launcher',
      version: command.version,
      pid: child.pid,
      message: `Failed to start Minecraft: ${error.message}`
    });
  });

  child.on('exit', (code, signal) => {
    console.log(`[minecraft:${command.version}] exited with code=${code} signal=${signal}`);
    onLog({
      level: code === 0 ? 'info' : 'error',
      stream: 'launcher',
      version: command.version,
      pid: child.pid,
      message: `Minecraft exited with code=${code} signal=${signal ?? 'none'}`
    });
  });

  return child;
}
