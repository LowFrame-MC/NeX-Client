function asErrorMessage(error) {
  if (!error) {
    return 'Unknown authentication error';
  }

  if (typeof error === 'string') {
    return error;
  }

  return error.message || String(error);
}

function isCancelLike(error) {
  const message = asErrorMessage(error).toLowerCase();
  return message.includes('cancel') || message.includes('closed') || message.includes('aborted');
}

function ensureProfile(profile) {
  if (!profile?.username || !profile?.uuid || !profile?.accessToken) {
    throw new Error('Authentication succeeded but the Microsoft profile was incomplete.');
  }

  return normalizeAuthProfile(profile);
}

export function normalizeAuthProfile(profile) {
  if (!profile) {
    return null;
  }

  return {
    username: String(profile.username ?? profile.name ?? ''),
    uuid: String(profile.uuid ?? profile.id ?? '').replaceAll('-', ''),
    accessToken: String(profile.accessToken ?? profile.access_token ?? ''),
    userType: String(profile.userType ?? profile.user_type ?? 'msa'),
    refreshToken: profile.refreshToken ?? profile.refresh_token ?? null,
    expiresAt: profile.expiresAt ?? null,
    xuid: profile.xuid ? String(profile.xuid) : '',
    clientId: profile.clientId ? String(profile.clientId) : '',
    userProperties: profile.userProperties ?? profile.user_properties ?? {},
    demo: Boolean(profile.demo)
  };
}

export async function authenticateUser({ parentWindow } = {}) {
  try {
    const msmc = await import('msmc');
    const Auth = msmc.Auth || msmc.default?.Auth;

    if (typeof Auth !== 'function') {
      throw new Error('Installed msmc package does not expose Auth.');
    }

    const authManager = new Auth('select_account');
    const xboxManager = await authManager.launch('electron', {
      width: 520,
      height: 720,
      parent: parentWindow || undefined,
      modal: Boolean(parentWindow),
      show: true,
      title: 'NeX Client Microsoft Login',
      backgroundColor: '#0f0f11',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });
    const minecraft = await xboxManager.getMinecraft();
    const mclc = minecraft.mclc(true);
    const entitlements = await minecraft.entitlements().catch(() => []);
    const isDemo = typeof minecraft.isDemo === 'function' ? minecraft.isDemo() : Boolean(mclc.meta?.demo);

    if (isDemo || entitlements.length === 0) {
      throw new Error('This Microsoft account authenticated, but MSMC did not find Java Edition ownership. Sign into the account that owns Minecraft Java Edition.');
    }

    return ensureProfile({
      username: minecraft.profile?.name || mclc.name,
      uuid: minecraft.profile?.id || mclc.uuid,
      accessToken: minecraft.mcToken || mclc.access_token,
      userType: mclc.meta?.type || 'msa',
      refreshToken: mclc.meta?.refresh || null,
      expiresAt: mclc.meta?.exp ? mclc.meta.exp * 1000 : null,
      xuid: minecraft.xuid || mclc.meta?.xuid || '',
      clientId: mclc.client_token || '',
      userProperties: mclc.user_properties || {},
      demo: isDemo
    });
  } catch (error) {
    if (isCancelLike(error)) {
      throw new Error('Login cancelled by user.');
    }

    throw new Error(`Microsoft authentication failed: ${asErrorMessage(error)}`);
  }
}
