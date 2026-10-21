import jwt from 'jsonwebtoken';

const ROLE_PATTERN = /^[A-ZÁÉÍÓÚÑ0-9_]{3,30}$/;

function bearerToken(authorization) {
  if (typeof authorization !== 'string') return null;

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Académico solo acepta los encabezados de identidad si coinciden con un JWT
 * válido. Así, llamar el subgrafo directamente con x-user-* no permite
 * suplantar a otro usuario.
 */
export function actorFromGatewayRequest(request, jwtSecret) {
  const headers = request.headers ?? {};
  const userId = headers['x-user-id'];
  const userRole = headers['x-user-role'];
  const token = bearerToken(headers.authorization);

  if (
    typeof userId !== 'string' ||
    typeof userRole !== 'string' ||
    !ROLE_PATTERN.test(userRole) ||
    !token
  ) {
    return null;
  }

  try {
    const payload = jwt.verify(token, jwtSecret, {
      algorithms: ['HS256']
    });

    if (
      typeof payload === 'string' ||
      payload.id !== userId ||
      payload.rol !== userRole ||
      typeof payload.jti !== 'string' ||
      payload.jti.length === 0
    ) {
      return null;
    }

    return {
      id: userId,
      rol: userRole
    };
  } catch {
    return null;
  }
}
