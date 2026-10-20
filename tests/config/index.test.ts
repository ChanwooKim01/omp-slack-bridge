import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('config', () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'slack-bridge-config-'));
    delete process.env.PI_SLACK_BOT_TOKEN;
    delete process.env.PI_SLACK_APP_TOKEN;
    delete process.env.PI_SLACK_USER_TOKEN;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importConfig() {
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return { ...actual, homedir: () => tmpDir };
    });
    return await import('../../src/config/index');
  }

  it('returns empty config when no file exists', async () => {
    const { loadConfig } = await importConfig();
    expect(loadConfig()).toEqual({});
  });

  it('saves and loads config roundtrip', async () => {
    const { loadConfig, updateConfig } = await importConfig();

    updateConfig((config) => Object.assign(config, { slack: { botToken: 'xoxb-test', appToken: 'xapp-test' }, autoConnect: true, debug: false }));
    const loaded = loadConfig();

    expect(loaded.slack?.botToken).toBe('xoxb-test');
    expect(loaded.slack?.appToken).toBe('xapp-test');
    expect(loaded.autoConnect).toBe(true);
    expect(loaded.debug).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('restricts the configuration directory to its POSIX owner', async () => {
    const { updateConfig } = await importConfig();
    updateConfig((config) => Object.assign(config, { autoConnect: true }));

    const stats = statSync(join(tmpDir, '.omp', 'agent'));
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it.runIf(process.platform !== 'win32')('restricts the credential file to its POSIX owner', async () => {
    const { updateConfig } = await importConfig();
    updateConfig((config) => Object.assign(config, { autoConnect: true }));

    const stats = statSync(join(tmpDir, '.omp', 'agent', 'slk-bridge.json'));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('env vars override file values', async () => {
    const { loadConfig, updateConfig } = await importConfig();

    updateConfig((config) => Object.assign(config, { slack: { botToken: 'xoxb-file', appToken: 'xapp-file' }, autoConnect: true }));
    process.env.PI_SLACK_BOT_TOKEN = 'xoxb-env';
    process.env.PI_SLACK_APP_TOKEN = 'xapp-env';

    const loaded = loadConfig();
    expect(loaded.slack?.botToken).toBe('xoxb-env');
    expect(loaded.slack?.appToken).toBe('xapp-env');
    // Non-overridden fields survive
    expect(loaded.autoConnect).toBe(true);
  });

  it('loads Slack env vars', async () => {
    process.env.PI_SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.PI_SLACK_APP_TOKEN = 'xapp-test';

    const { loadConfig } = await importConfig();
    const config = loadConfig();

    expect(config.slack?.botToken).toBe('xoxb-test');
    expect(config.slack?.appToken).toBe('xapp-test');
  });

  it('handles corrupted config file gracefully', async () => {
    const piDir = join(tmpDir, '.omp', 'agent');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'slk-bridge.json'), '{invalid json!!!');

    const { loadConfig } = await importConfig();
    // Should not throw, returns empty config
    const config = loadConfig();
    expect(config).toEqual({});
  });

  it('still applies env vars when config file is corrupted', async () => {
    const piDir = join(tmpDir, '.omp', 'agent');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'slk-bridge.json'), 'not json');

    process.env.PI_SLACK_BOT_TOKEN = 'xoxb-env';
    process.env.PI_SLACK_APP_TOKEN = 'xapp-env';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.slack?.botToken).toBe('xoxb-env');
    expect(config.slack?.appToken).toBe('xapp-env');
  });

  it('requires both Slack tokens for slack config', async () => {
    // Only bot token — should not set slack
    process.env.PI_SLACK_BOT_TOKEN = 'xoxb-test';

    const { loadConfig } = await importConfig();
    expect(loadConfig().slack).toBeUndefined();
  });

  it('saves and loads hideToolCalls config', async () => {
    const { loadConfig, updateConfig } = await importConfig();

    updateConfig((config) => Object.assign(config, { hideToolCalls: true, autoConnect: true }));
    const loaded = loadConfig();

    expect(loaded.hideToolCalls).toBe(true);
    expect(loaded.autoConnect).toBe(true);
  });


  it('loads slk-bridge.json', async () => {
    const piDir = join(tmpDir, '.omp', 'agent');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'slk-bridge.json'), JSON.stringify({ slack: { botToken: 'xoxb-test', appToken: 'xapp-test' }, autoConnect: true }));

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.slack?.botToken).toBe('xoxb-test');
    expect(config.slack?.appToken).toBe('xapp-test');
    expect(config.autoConnect).toBe(true);
  });

  describe('user token', () => {
    const fileConfig = { slack: { botToken: 'xoxb-file', appToken: 'xapp-file', userToken: 'xoxp-file' } };
    const writeFileConfig = (config: unknown) => {
      const dir = join(tmpDir, '.omp', 'agent');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'slk-bridge.json'), JSON.stringify(config));
    };

    it('is read from the config file', async () => {
      writeFileConfig(fileConfig);
      const { loadConfig } = await importConfig();

      expect(loadConfig().slack).toEqual(fileConfig.slack);
    });

    it('is optional', async () => {
      writeFileConfig({ slack: { botToken: 'xoxb-file', appToken: 'xapp-file' } });
      const { loadConfig } = await importConfig();

      expect(loadConfig().slack?.userToken).toBeUndefined();
    });

    it('comes from PI_SLACK_USER_TOKEN, which wins over the file', async () => {
      writeFileConfig(fileConfig);
      process.env.PI_SLACK_USER_TOKEN = 'xoxp-env';
      const { loadConfig } = await importConfig();

      expect(loadConfig().slack).toEqual({ botToken: 'xoxb-file', appToken: 'xapp-file', userToken: 'xoxp-env' });
    });

    it('survives the bot and app tokens being overridden from the environment', async () => {
      writeFileConfig(fileConfig);
      process.env.PI_SLACK_BOT_TOKEN = 'xoxb-env';
      process.env.PI_SLACK_APP_TOKEN = 'xapp-env';
      const { loadConfig } = await importConfig();

      expect(loadConfig().slack).toEqual({ botToken: 'xoxb-env', appToken: 'xapp-env', userToken: 'xoxp-file' });
    });

    it('is accepted together with environment bot and app tokens', async () => {
      process.env.PI_SLACK_BOT_TOKEN = 'xoxb-env';
      process.env.PI_SLACK_APP_TOKEN = 'xapp-env';
      process.env.PI_SLACK_USER_TOKEN = 'xoxp-env';
      const { loadConfig } = await importConfig();

      expect(loadConfig().slack).toEqual({ botToken: 'xoxb-env', appToken: 'xapp-env', userToken: 'xoxp-env' });
    });

    it('alone does not make a Slack configuration', async () => {
      process.env.PI_SLACK_USER_TOKEN = 'xoxp-env';
      const { loadConfig } = await importConfig();

      expect(loadConfig().slack).toBeUndefined();
    });

    it('is never written to the file from the environment', async () => {
      writeFileConfig({ slack: { botToken: 'xoxb-file', appToken: 'xapp-file' } });
      process.env.PI_SLACK_USER_TOKEN = 'xoxp-env';
      const { updateConfig } = await importConfig();

      updateConfig((config) => {
        config.autoConnect = true;
      });

      const onDisk = JSON.parse(readFileSync(join(tmpDir, '.omp', 'agent', 'slk-bridge.json'), 'utf-8'));
      expect(onDisk.slack).toEqual({ botToken: 'xoxb-file', appToken: 'xapp-file' });
      expect(JSON.stringify(onDisk)).not.toContain('xoxp-env');
    });
  });

});
