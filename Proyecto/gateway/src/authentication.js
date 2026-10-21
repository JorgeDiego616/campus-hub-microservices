import jwt from 'jsonwebtoken';

const ROLE_PATTERN = /^[A-ZÁÉÍÓÚÑ0-9_]{3,30}$/;

export function requireJwtSecret(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      'JWT_SECRET es obligatorio en Gateway y debe coincidir con Seguridad y Académico.'
    );
  }

  return value;
}

export function authenticateAuthorizationHeader(authorization, jwtSecret) {
  if (typeof authorization !== 'string') {
    return { actor: null, token: null };
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { actor: null, token: null };
  }

  const token = match[1].trim();

  try {
    const payload = jwt.verify(token, jwtSecret, {
      algorithms: ['HS256']
    });

    if (
      typeof payload === 'string' ||
      typeof payload.id !== 'string' ||
      payload.id.length === 0 ||
      typeof payload.rol !== 'string' ||
      !ROLE_PATTERN.test(payload.rol) ||
      typeof payload.jti !== 'string' ||
      payload.jti.length === 0
    ) {
      return { actor: null, token: null };
    }

    return {
      actor: {
        id: payload.id,
        rol: payload.rol
      },
      token,
      jti: payload.jti
    };
  } catch {
    return { actor: null, token: null };
  }
}

export async function authenticateActiveSession(
  authorization,
  jwtSecret,
  sessionStore
) {
  const authentication = authenticateAuthorizationHeader(
    authorization,
    jwtSecret
  );

  if (!authentication.actor) return authentication;

  const isActive = await sessionStore.hasMatchingSession({
    jti: authentication.jti,
    actor: authentication.actor
  });

  return isActive ? authentication : { actor: null, token: null, jti: null };
}

export function applyAuthenticatedHeaders(headers, authentication) {
  // Nunca se reenvían encabezados de identidad suministrados por el cliente.
  headers.delete('x-user-id');
  headers.delete('x-user-role');
  headers.delete('authorization');

  if (!authentication?.actor || !authentication.token) return;

  headers.set('authorization', `Bearer ${authentication.token}`);
  headers.set('x-user-id', authentication.actor.id);
  headers.set('x-user-role', authentication.actor.rol);
}
