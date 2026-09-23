import { Router, readJsonBody, sendJson } from '../lib/http.js';
import { connectionService } from '../services/connectionService.js';
import { settingsService } from '../services/settingsService.js';
import { prService } from '../services/prService.js';
import { teamRosterService } from '../services/teamRosterService.js';
import { knowledgeBaseService } from '../services/knowledgeBaseService.js';
import { reviewService } from '../services/reviewService.js';
import { publishService } from '../services/publishService.js';
import { gitCacheService } from '../services/gitCacheService.js';
import { auditRepo } from '../db/repositories/auditRepo.js';
import { resetClients } from '../integrations/registry.js';
import { validationError } from '../lib/errors.js';

export function createApiRouter() {
  const router = new Router();

  router.get('/api/bootstrap', async (req, res) => {
    sendJson(res, 200, {
      connection: await connectionService.status(),
      prs: prService.list(),
    });
  });

  router.get('/api/connection/status', async (req, res) => {
    sendJson(res, 200, await connectionService.status());
  });

  router.get('/api/connection/identities', async (req, res) => {
    sendJson(res, 200, await connectionService.identities());
  });

  router.get('/api/connection/models', async (req, res) => {
    sendJson(res, 200, await connectionService.models());
  });

  router.post('/api/connection/models', async (req, res) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, await connectionService.addModel(body));
  });

  router.post('/api/connection/models/verify', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body.id) throw validationError('模型 ID 不能为空');
    sendJson(res, 200, await connectionService.verifyModel(body.id));
  });

  router.delete('/api/connection/models/:id', async (req, res, params) => {
    sendJson(res, 200, connectionService.removeModel(decodeURIComponent(params.id)));
  });

  router.post('/api/connection/test', async (req, res) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, await connectionService.test(body.target));
  });

  router.post('/api/connection/credential', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body.token) throw validationError('凭据不能为空');
    sendJson(res, 200, await connectionService.saveCredential(body.name, body.token));
  });

  router.delete('/api/connection/credential/:name', async (req, res, params) => {
    sendJson(res, 200, connectionService.removeCredential(params.name));
  });

  router.put('/api/settings', async (req, res) => {
    const body = await readJsonBody(req);
    settingsService.set(body.key, body.value);
    teamRosterService.invalidate();
    knowledgeBaseService.invalidate();
    resetClients();
    sendJson(res, 200, await connectionService.status());
  });

  /** 知识库状态；缺 checkout 时这里会自动克隆一次（FR-12）。 */
  router.get('/api/knowledge-base', async (req, res) => {
    sendJson(res, 200, await knowledgeBaseService.ensure());
  });

  /** 显式刷新：清掉失败冷却，必要时重新克隆，已有 checkout 则 fetch 并尝试快进。 */
  router.post('/api/knowledge-base/refresh', async (req, res) => {
    knowledgeBaseService.invalidate();
    knowledgeBaseService.resetProvisionCooldown();
    sendJson(res, 200, await knowledgeBaseService.ensure({ refresh: true }));
  });

  router.put('/api/settings/model', async (req, res) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, settingsService.setReviewModel(body));
  });

  router.get('/api/prs', async (req, res) => {
    sendJson(res, 200, prService.list());
  });

  router.post('/api/prs/sync', async (req, res) => {
    prService.invalidateDiffCache();
    sendJson(res, 200, await prService.sync());
  });

  router.get('/api/prs/:id/preflight', async (req, res, params) => {
    sendJson(res, 200, await prService.preflight(params.id));
  });

  router.put('/api/prs/:id/jira-keys', async (req, res, params) => {
    const body = await readJsonBody(req);
    settingsService.setManualJiraKeys(params.id, body.keys ?? []);
    sendJson(res, 200, await prService.preflight(params.id));
  });

  router.get('/api/prs/:id/diff', async (req, res, params) => {
    sendJson(res, 200, await prService.diff(params.id));
  });

  router.get('/api/prs/:id/rounds', async (req, res, params) => {
    sendJson(res, 200, reviewService.listByPr(params.id));
  });

  router.post('/api/prs/:id/review', async (req, res, params) => {
    const body = await readJsonBody(req);
    sendJson(res, 202, await reviewService.start(params.id, {
      manualJiraKeys: body.manualJiraKeys ?? [],
    }));
  });

  router.get('/api/rounds/:id', async (req, res, params) => {
    sendJson(res, 200, reviewService.detail(params.id));
  });

  router.post('/api/rounds/:id/cancel', async (req, res, params) => {
    sendJson(res, 200, reviewService.cancel(params.id));
  });

  router.patch('/api/rounds/:id/summary', async (req, res, params) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, reviewService.updateSummary(params.id, body));
  });

  router.patch('/api/findings/:id', async (req, res, params) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, reviewService.updateFinding(params.id, body));
  });

  router.patch('/api/carryover/:id', async (req, res, params) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, reviewService.setCarryoverVerdict(params.id, body.verdict, body.note));
  });

  router.get('/api/git-cache', async (req, res) => {
    sendJson(res, 200, {
      ...gitCacheService.status(),
      git: await gitCacheService.available(),
    });
  });

  router.post('/api/git-cache/clear', async (req, res) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, gitCacheService.clear({ confirm: body.confirm === true }));
  });

  router.post('/api/rounds/:id/publish/preview', async (req, res, params) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, await publishService.preview(params.id, body.action));
  });

  router.post('/api/rounds/:id/publish', async (req, res, params) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, await publishService.publish(params.id, body.action));
  });

  router.get('/api/history', async (req, res) => {
    sendJson(res, 200, { rounds: reviewService.history() });
  });

  router.get('/api/audit', async (req, res) => {
    sendJson(res, 200, { events: auditRepo.list() });
  });

  return router;
}
