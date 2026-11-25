// Datos del cliente real (IP y user-agent) para la auditoría.
//
// Problema que resuelve: los subgrafos solo ven la conexión que les abre el
// Gateway, así que en ScyllaDB todos los eventos quedaban con ip_origen "::1".
// En la nube iba a ser peor: con Caddy delante, el Gateway también vería
// siempre la IP de Caddy. Aquí saco la IP buena una vez y se la paso a los
// subgrafos en headers.

const SIN_DATO = 'UNKNOWN';

// "::ffff:192.168.1.5" es una IPv4 escrita como IPv6; la dejo como IPv4
// para que en auditoría se lea igual venga por donde venga.
export function normalizarIp(ip) {
  if (typeof ip !== 'string' || ip.trim().length === 0) return SIN_DATO;
  const limpia = ip.trim();
  return limpia.startsWith('::ffff:') ? limpia.slice(7) : limpia;
}

// confiarEnProxy = true SOLO cuando hay un proxy nuestro delante (Caddy en la
// nube). Si lo dejo en true sin proxy, cualquiera podría mandar un
// X-Forwarded-For inventado y falsificar su IP en la auditoría.
//
// Tomo el ÚLTIMO valor de la lista, no el primero: el último lo agrega el
// proxy que está pegado al Gateway (Caddy); los de antes los pudo escribir
// el propio cliente.
export function obtenerIpCliente(req, confiarEnProxy = false) {
  if (confiarEnProxy) {
    const cabecera = req?.headers?.['x-forwarded-for'];
    if (typeof cabecera === 'string' && cabecera.trim().length > 0) {
      const ips = cabecera.split(',').map((ip) => ip.trim()).filter(Boolean);
      if (ips.length > 0) return normalizarIp(ips[ips.length - 1]);
    }
  }

  return normalizarIp(req?.socket?.remoteAddress);
}

export function obtenerClienteInfo(req, confiarEnProxy = false) {
  const userAgent = req?.headers?.['user-agent'];
  return {
    ip: obtenerIpCliente(req, confiarEnProxy),
    userAgent: typeof userAgent === 'string' && userAgent.length > 0
      // Lo corto para que nadie meta un texto gigante en la auditoría.
      ? userAgent.slice(0, 256)
      : null
  };
}

// Igual que applyAuthenticatedHeaders: primero borro lo que haya mandado el
// cliente (para que no pueda inventarse la IP hablándole al subgrafo a
// través del Gateway) y luego pongo los valores que calculé yo.
export function aplicarHeadersCliente(headers, cliente) {
  headers.delete('x-forwarded-for');
  headers.delete('x-client-user-agent');

  if (!cliente) return;

  if (cliente.ip && cliente.ip !== SIN_DATO) {
    headers.set('x-forwarded-for', cliente.ip);
  }
  if (cliente.userAgent) {
    headers.set('x-client-user-agent', cliente.userAgent);
  }
}
