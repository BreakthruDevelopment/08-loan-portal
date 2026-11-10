/** Typed domain errors. `errorResponse` maps `status` straight to the HTTP response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Sent as a Retry-After header when set (429 and 503). */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found") {
    super(404, message);
  }
}

/** The request is well formed but conflicts with the current state (a stale update, a cap reached). */
export class ConflictError extends HttpError {
  constructor(message = "That change isn't allowed from the current state.") {
    super(409, message);
  }
}

export class BadRequestError extends HttpError {
  constructor(message = "Bad request") {
    super(400, message);
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(limit: number) {
    super(413, `Body too large (limit ${limit} bytes)`);
  }
}

/** Too many attempts in a window (for example share attempts per hour). */
export class TooManyRequestsError extends HttpError {
  constructor(message = "Too many requests", retryAfterSeconds?: number) {
    super(429, message, retryAfterSeconds);
  }
}

/** The process is at a concurrency limit; try again shortly. */
export class ServiceBusyError extends HttpError {
  constructor(message = "The server is busy. Try again shortly.", retryAfterSeconds = 5) {
    super(503, message, retryAfterSeconds);
  }
}

/** The client took too long to send the request body. */
export class RequestTimeoutError extends HttpError {
  constructor(message = "The upload took too long.") {
    super(408, message);
  }
}

/** The request is well formed but the content is unacceptable (for example a file that isn't the image it claims to be). */
export class UnprocessableError extends HttpError {
  constructor(message = "Unprocessable") {
    super(422, message);
  }
}
