import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(serverDir, '..');

/**
 * 本地运行配置。所有数据都留在本机 data 目录，不部署云端服务。
 */
export const config = {
  host: '127.0.0.1',
  port: Number(process.env.SAKURA_PORT ?? 7420),
  dataDir: process.env.SAKURA_DATA_DIR ?? path.join(projectRoot, 'data'),
  webDir: path.join(projectRoot, 'web'),
  /** mock | live —— live 需要真实凭据与实例信息（见 requirements.md 第 9 章） */
  integrationMode: process.env.SAKURA_INTEGRATION_MODE ?? 'mock',
  defaultModel: { id: 'claude-opus-5', name: 'Claude Opus 5' },
  /**
   * 仅用于演示数据与首次启动的占位；真实仓库请在「连接设置」里填写，
   * 或用 SAKURA_REPOSITORY 覆盖。不要把真实仓库写死在源码里。
   */
  defaultRepository: process.env.SAKURA_REPOSITORY ?? 'example-org/example-repo',
};

export const paths = {
  db: path.join(config.dataDir, 'sakura.db'),
  secrets: path.join(config.dataDir, 'secrets'),
  repoCache: path.join(config.dataDir, 'repo-cache'),
  logs: path.join(config.dataDir, 'logs'),
};

export const isDemo = () => config.integrationMode !== 'live';
