import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { Request, RequestHandler } from "express";
import type { Config } from "../../config/index.js";
import { unauthorized } from "../../platform/errors.js";
import type { Logger } from "../../platform/logger.js";
import "../../platform/http/locals.js";

export type AuthUser = { userId: string; username: string };

/** Verifies a Cognito access token and returns its claims; throws when invalid. */
export type AccessTokenVerifier = (token: string) => Promise<{ sub: string; username?: unknown }>;

export const DEV_USER_HEADER = "x-dev-user";
const DEV_USER_PATTERN = /^[A-Za-z0-9._@-]{1,128}$/;

/** `x-dev-user: <id>[:<username>]` (AUTH_MODE=dev only, BE-043). */
export function parseDevUser(header: string | undefined): AuthUser | undefined {
  if (!header) return undefined;
  const [userId = "", username = userId, ...rest] = header.split(":");
  if (rest.length > 0 || !DEV_USER_PATTERN.test(userId) || !DEV_USER_PATTERN.test(username)) {
    return undefined;
  }
  return { userId, username };
}

function bearerToken(req: Request): string | undefined {
  const [scheme, token] = (req.get("authorization") ?? "").split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

export function createCognitoVerifier(
  config: Pick<Config, "COGNITO_USER_POOL_ID" | "COGNITO_CLIENT_ID">,
): AccessTokenVerifier {
  if (!config.COGNITO_USER_POOL_ID || !config.COGNITO_CLIENT_ID) {
    throw new Error(
      "COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID are required for AUTH_MODE=cognito",
    );
  }
  const verifier = CognitoJwtVerifier.create({
    userPoolId: config.COGNITO_USER_POOL_ID,
    clientId: config.COGNITO_CLIENT_ID,
    tokenUse: "access",
  });
  return (token) => verifier.verify(token);
}

/**
 * Sets `req.user` from the verified token (ARCHITECTURE §3.1). Identity never comes from the
 * body or query; the only header exception is `x-dev-user` in dev mode.
 */
export function createAuthMiddleware(deps: {
  mode: Config["AUTH_MODE"];
  logger: Logger;
  verifier?: AccessTokenVerifier;
}): RequestHandler {
  if (deps.mode === "dev") {
    deps.logger.warn("dev auth enabled: identity comes from the x-dev-user header");
    return (req, _res, next) => {
      const user = parseDevUser(req.get(DEV_USER_HEADER));
      if (!user) throw unauthorized(`Send ${DEV_USER_HEADER}: <id>[:<username>] (dev auth).`);
      req.user = user;
      next();
    };
  }

  const verify = deps.verifier;
  if (!verify) throw new Error("a token verifier is required for AUTH_MODE=cognito");
  return async (req, _res, next) => {
    const token = bearerToken(req);
    if (!token) throw unauthorized();
    let claims: Awaited<ReturnType<AccessTokenVerifier>>;
    try {
      claims = await verify(token);
    } catch (error) {
      deps.logger.debug({ err: error }, "access token rejected");
      throw unauthorized();
    }
    req.user = {
      userId: claims.sub,
      username: typeof claims.username === "string" ? claims.username : claims.sub,
    };
    next();
  };
}

/** The authenticated caller; routes behind the auth middleware always have one. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
