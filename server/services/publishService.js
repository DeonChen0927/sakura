import { getClients } from '../integrations/registry.js';
import { reviewService } from './reviewService.js';
import { roundRepo, PUBLISHABLE_STATUSES } from '../db/repositories/roundRepo.js';
import { prRepo } from '../db/repositories/prRepo.js';
import { publishRepo, BatchStatus, ItemStatus } from '../db/repositories/publishRepo.js';
import { auditRepo } from '../db/repositories/auditRepo.js';
import { settingsService, SettingKey } from './settingsService.js';
import {
  buildEnglishSignature,
  composeBody,
  hasSubstantiveBody,
  SignatureContext,
} from '../domain/signature.js';
import { idempotencyKey } from '../lib/ids.js';
import { AppError, ErrorKind, notFound, preconditionError, validationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export const PublishAction = {
  APPROVE: 'approve',
  REQUEST_CHANGES: 'request_changes',
  COMMENT_ONLY: 'comment_only',
};

const inFlight = new Set();

async function buildPlan(roundId, action, { publisherName }) {
  const detail = reviewService.detail(roundId);
  const { round, pullRequest } = detail;
  const demo = detail.demo;

  const signature = buildEnglishSignature(round, {
    context: SignatureContext.PUBLISH,
    publisherName,
    demo,
  });

  const selected = detail.findings.filter((finding) => finding.selected && !finding.deleted);

  const items = selected.map((finding) => ({
    kind: 'comment',
    findingId: finding.id,
    findingKey: finding.key,
    severity: finding.severity,
    filePath: finding.anchorKind === 'line' ? finding.filePath : null,
    line: finding.anchorKind === 'line' ? finding.newLine ?? finding.oldLine : null,
    lineSide: finding.anchorKind === 'line' && !finding.newLine ? 'old' : 'new',
    rawBody: finding.effectiveCommentEn,
    body: composeBody(finding.effectiveCommentEn, signature),
  }));

  const summaryParts = [detail.summary.effectiveEn?.trim()].filter(Boolean);
  if (action === PublishAction.APPROVE && detail.summary.overrideReasonEn?.trim()) {
    summaryParts.push(`Override reason: ${detail.summary.overrideReasonEn.trim()}`);
  }
  const summaryRaw = summaryParts.join('\n\n');
  const summaryItem = summaryRaw
    ? {
        kind: 'summary',
        findingId: null,
        filePath: null,
        line: null,
        rawBody: summaryRaw,
        body: composeBody(summaryRaw, signature),
      }
    : null;

  const plan = summaryItem ? [summaryItem, ...items] : items;
  return { detail, plan, signature, pullRequest, round, demo };
}

function validatePlan({ detail, plan, round, pullRequest }, action) {
  const errors = [];

  if (!PUBLISHABLE_STATUSES.has(round.status)) {
    errors.push(`本轮状态为「${round.status}」，不是可发布的完整报告。`);
  }
  if (!detail.freshness.fresh) errors.push(detail.freshness.reason);

  if (!Object.values(PublishAction).includes(action)) errors.push('必须由人工明确选择评审动作。');

  const draftPolicy = settingsService.get(SettingKey.DRAFT_POLICY);
  if (pullRequest.isDraft && action !== PublishAction.COMMENT_ONLY && !draftPolicy.allowStatefulPublish) {
    errors.push('Draft PR 不允许发布状态性评审结果，请等待转为正式 PR。');
  }

  for (const item of plan) {
    if (!hasSubstantiveBody(item.rawBody)) {
      errors.push('存在只有署名、没有实质正文的内容，不能发布。');
      break;
    }
  }

  const comments = plan.filter((item) => item.kind === 'comment');
  if (action === PublishAction.REQUEST_CHANGES && !comments.length && !detail.summary.effectiveEn?.trim()) {
    errors.push('Request changes 至少需要一条问题评论或非空英文理由。');
  }
  if (action === PublishAction.COMMENT_ONLY && !plan.length) {
    errors.push('仅评论必须有可发布内容。');
  }
  if (
    action === PublishAction.APPROVE &&
    detail.suggestedAction === 'request_changes' &&
    !detail.summary.overrideReasonEn?.trim()
  ) {
    errors.push('AI 建议请求修改，选择 Approve 需要填写英文覆盖理由。');
  }

  for (const item of comments) {
    if (item.filePath && !Number.isInteger(item.line)) {
      errors.push(`评论 ${item.findingKey} 缺少合法行号锚点。`);
    }
  }

  return errors;
}

export const publishService = {
  /** 发布预览：显示实际将要发送的带署名全文，点击确认前不产生任何远端写入（AC07 / AC08）。 */
  async preview(roundId, action) {
    const clients = getClients();
    const publisher = await clients.bitbucket.getCurrentUser();
    const context = await buildPlan(roundId, action, { publisherName: publisher.displayName });
    const errors = validatePlan(context, action);

    return {
      action,
      publisher: { name: publisher.displayName, id: publisher.id },
      demo: context.demo,
      pullRequest: context.pullRequest,
      round: {
        id: context.round.id,
        roundNumber: context.round.roundNumber,
        model: context.round.model,
        sourceCommit: context.round.sourceCommit,
        targetCommit: context.round.targetCommit,
      },
      signature: context.signature,
      suggestedAction: context.detail.suggestedAction,
      items: context.plan.map((item) => ({
        kind: item.kind,
        findingKey: item.findingKey ?? null,
        severity: item.severity ?? null,
        filePath: item.filePath,
        line: item.line,
        body: item.body,
      })),
      canPublish: errors.length === 0,
      errors,
    };
  },

  /**
   * 发布：先评论与总结，全部成功后再更新评审状态；
   * 中途失败显示「部分成功」，不更新最终评审状态（FR-07 / AC11）。
   */
  async publish(roundId, action) {
    if (inFlight.has(roundId)) {
      throw new AppError(ErrorKind.CONFLICT, '该轮次正在发布中，请勿重复提交');
    }
    inFlight.add(roundId);
    try {
      return await this.runPublish(roundId, action);
    } finally {
      inFlight.delete(roundId);
    }
  },

  async runPublish(roundId, action) {
    const clients = getClients();
    const round = roundRepo.byId(roundId);
    if (!round) throw notFound('评审轮次不存在');

    // 确认后重新读取 PR 状态、版本与需求指纹，变化则取消本次发布（AC10）
    const verified = await reviewService.verifyFreshnessAgainstRemote(round);
    if (!verified.fresh) {
      auditRepo.record('system', 'publish.aborted', roundId, { reason: verified.reason });
      throw preconditionError(verified.reason, { details: { expired: true } });
    }

    const publisher = await clients.bitbucket.getCurrentUser();
    const context = await buildPlan(roundId, action, { publisherName: publisher.displayName });
    const errors = validatePlan(context, action);
    if (errors.length) throw validationError('发布前校验未通过', { errors });

    const pullRequest = prRepo.byId(round.pullRequestId);
    const key = idempotencyKey(
      roundId,
      action,
      round.inputFingerprint,
      ...context.plan.map((item) => item.body),
    );

    let batch = publishRepo.findByIdempotencyKey(key);
    if (batch?.status === BatchStatus.SUCCEEDED) {
      return this.result(batch.id);
    }
    if (!batch) {
      batch = publishRepo.createBatch({
        roundId,
        idempotencyKey: key,
        action,
        publisher: { name: publisher.displayName, id: publisher.id },
        inputFingerprint: round.inputFingerprint,
      });
      for (const item of context.plan) {
        publishRepo.addItem(batch.id, {
          kind: item.kind,
          findingId: item.findingId,
          body: item.body,
          dedupeKey: idempotencyKey(roundId, item.kind, item.findingId ?? 'summary', item.body),
        });
      }
    }

    publishRepo.setStatus(batch.id, BatchStatus.RUNNING);
    auditRepo.record('user', 'publish.start', batch.id, { action, pr: pullRequest.number });

    const succeeded = publishRepo.succeededDedupeKeys(roundId);
    const stored = publishRepo.items(batch.id);
    const planByDedupe = new Map(
      context.plan.map((item) => [
        idempotencyKey(roundId, item.kind, item.findingId ?? 'summary', item.body),
        item,
      ]),
    );

    let failed = false;
    for (const item of stored) {
      if (item.status === ItemStatus.SUCCEEDED) continue;
      if (succeeded.has(item.dedupeKey)) {
        publishRepo.setItemResult(item.id, ItemStatus.SUCCEEDED, {
          remoteCommentId: item.remoteCommentId,
        });
        continue;
      }
      const planned = planByDedupe.get(item.dedupeKey);
      try {
        // 重试前先核实远端是否已经写入，避免重复评论（FR-07）
        const existing = await clients.bitbucket.findOwnCommentByBody({
          repository: pullRequest.repository,
          number: pullRequest.number,
          body: item.body,
        });
        if (existing) {
          publishRepo.setItemResult(item.id, ItemStatus.SUCCEEDED, { remoteCommentId: existing.id });
          continue;
        }
        const created = await clients.bitbucket.createComment({
          repository: pullRequest.repository,
          number: pullRequest.number,
          body: item.body,
          filePath: planned?.filePath ?? null,
          line: planned?.line ?? null,
          lineSide: planned?.lineSide ?? 'new',
        });
        publishRepo.setItemResult(item.id, ItemStatus.SUCCEEDED, { remoteCommentId: created.id });
      } catch (error) {
        failed = true;
        const unknown = error?.kind === ErrorKind.NETWORK;
        publishRepo.setItemResult(item.id, unknown ? ItemStatus.UNKNOWN : ItemStatus.FAILED, {
          errorMessage: error.message,
        });
        logger.warn('发布评论失败', { batch: batch.id, message: error.message });
        break;
      }
    }

    if (failed) {
      const anySuccess = publishRepo
        .items(batch.id)
        .some((item) => item.status === ItemStatus.SUCCEEDED);
      publishRepo.setStatus(
        batch.id,
        anySuccess ? BatchStatus.PARTIAL : BatchStatus.FAILED,
        '部分内容未成功发布，评审状态未更新',
      );
      auditRepo.record('system', 'publish.partial', batch.id, { action });
      return this.result(batch.id);
    }

    // 全部评论成功后才更新评审状态；仅评论保留原有远端状态（FR-07 / AC09）
    if (action !== PublishAction.COMMENT_ONLY) {
      try {
        const state = await clients.bitbucket.setReviewState({
          repository: pullRequest.repository,
          number: pullRequest.number,
          action,
        });
        prRepo.upsert({ ...pullRequest, myReviewState: state.state });
      } catch (error) {
        publishRepo.setStatus(batch.id, BatchStatus.PARTIAL, `评论已发布，但评审状态更新失败：${error.message}`);
        auditRepo.record('system', 'publish.state_failed', batch.id, { message: error.message });
        return this.result(batch.id);
      }
    }

    publishRepo.setStatus(batch.id, BatchStatus.SUCCEEDED);
    auditRepo.record('user', 'publish.succeeded', batch.id, { action, pr: pullRequest.number });
    return this.result(batch.id);
  },

  result(batchId) {
    const batch = publishRepo.byId(batchId);
    if (!batch) throw notFound('发布批次不存在');
    const items = publishRepo.items(batchId);
    return {
      batch,
      items,
      receipts: items.map((item) => ({
        kind: item.kind,
        status: item.status,
        remoteCommentId: item.remoteCommentId,
        error: item.errorMessage,
      })),
    };
  },
};
