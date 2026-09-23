import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { getDb } from './db/database.js';
import { createApiRouter } from './routes/api.js';
import { reviewService } from './services/reviewService.js';
import { guardRequest } from './security/localGuard.js';
import { sendError } from './lib/http.js';
import { logger } from './lib/logger.js';
import { AppError, ErrorKind } from './lib/errors.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(config.webDir, relative);
  if (!target.startsWith(path.resolve(config.webDir))) {
    throw new AppError(ErrorKind.PERMISSION, '非法的静态资源路径');
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new AppError(ErrorKind.NOT_FOUND, '资源不存在');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
  });
  fs.createReadStream(target).pipe(res);
}

export function createServer() {
  getDb();
  reviewService.reconcileOrphanRounds();
  reviewService.pruneHistory();
  const api = createApiRouter();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? config.host}`);
    try {
      guardRequest(req, res);

      if (url.pathname.startsWith('/api/')) {
        const route = api.match(req.method, url.pathname);
        if (!route) throw new AppError(ErrorKind.NOT_FOUND, `接口不存在：${url.pathname}`);
        await route.handler(req, res, route.params, url);
        return;
      }

      if (req.method !== 'GET') throw new AppError(ErrorKind.NOT_FOUND, '资源不存在');
      serveStatic(req, res, url.pathname);
    } catch (error) {
      if (!(error instanceof AppError)) {
        logger.error(`未处理的请求错误 ${url.pathname}`, { message: error?.message, stack: error?.stack });
      }
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, error);
    }
  });
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const server = createServer();
  /**
   * 端口被占用是最常见的「启动失败」，八成是上一个实例还在跑（Sakura 本就只应有一个本地实例）。
   * 默认的 EADDRINUSE 会抛一整屏 Node 栈，看不出该怎么办，所以这里换成可执行的提示。
   */
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(
        `端口 ${config.port} 已被占用，Sakura 未启动。` +
          `多半是已有一个实例在运行，直接访问 http://${config.host}:${config.port} 即可；` +
          '若要换端口，用 SAKURA_PORT=其它端口 启动。' +
          `查占用进程：PowerShell 执行 Get-NetTCPConnection -LocalPort ${config.port} -State Listen`,
      );
      process.exit(1);
    }
    throw error;
  });
  server.listen(config.port, config.host, () => {
    logger.info(`Sakura 本地服务已启动：http://${config.host}:${config.port}（模式 ${config.integrationMode}）`);
  });
  const shutdown = () => {
    logger.info('正在关闭 Sakura 本地服务');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
