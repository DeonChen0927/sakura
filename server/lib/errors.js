/**
 * 错误分类：连接测试与运行流程必须区分网络异常、认证失效、权限不足和限流，
 * 不允许显示伪成功（FR-01）。
 */
export const ErrorKind = {
  NETWORK: 'network',
  AUTH: 'auth',
  PERMISSION: 'permission',
  RATE_LIMIT: 'rate_limit',
  NOT_FOUND: 'not_found',
  VALIDATION: 'validation',
  CONFLICT: 'conflict',
  PRECONDITION: 'precondition',
  UPSTREAM: 'upstream',
  INTERNAL: 'internal',
};

const STATUS_BY_KIND = {
  [ErrorKind.NETWORK]: 502,
  [ErrorKind.AUTH]: 401,
  [ErrorKind.PERMISSION]: 403,
  [ErrorKind.RATE_LIMIT]: 429,
  [ErrorKind.NOT_FOUND]: 404,
  [ErrorKind.VALIDATION]: 400,
  [ErrorKind.CONFLICT]: 409,
  [ErrorKind.PRECONDITION]: 412,
  [ErrorKind.UPSTREAM]: 502,
  [ErrorKind.INTERNAL]: 500,
};

export class AppError extends Error {
  constructor(kind, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.kind = kind;
    this.status = options.status ?? STATUS_BY_KIND[kind] ?? 500;
    this.details = options.details ?? null;
    this.remedy = options.remedy ?? null;
    if (options.cause) this.cause = options.cause;
  }

  toJSON() {
    return {
      error: {
        kind: this.kind,
        message: this.message,
        details: this.details,
        remedy: this.remedy,
      },
    };
  }
}

export const validationError = (message, details) =>
  new AppError(ErrorKind.VALIDATION, message, { details });

export const preconditionError = (message, options) =>
  new AppError(ErrorKind.PRECONDITION, message, options);

export const notFound = (message) => new AppError(ErrorKind.NOT_FOUND, message);

export const conflictError = (message, details) =>
  new AppError(ErrorKind.CONFLICT, message, { details });
