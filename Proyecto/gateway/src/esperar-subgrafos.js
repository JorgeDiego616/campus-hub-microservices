// Espera a que los subgrafos contesten antes de que el Gateway arme el supergrafo.
//
// Por qué existe: IntrospectAndCompose le pide el esquema a cada subgrafo UNA
// sola vez al arrancar. Si alguno todavía no está prendido (en docker los
// contenedores arrancan casi al mismo tiempo), truena con
// "Couldn't load service definitions" y el Gateway se cae completo.
// Con esto el Gateway se queda esperando y me dice cuál falta.

const INTENTOS_POR_DEFECTO = 30;   // 30 intentos x 2 s = ~1 minuto de espera
const ESPERA_POR_DEFECTO_MS = 2000;
const TIMEOUT_PETICION_MS = 3000;  // si un subgrafo no contesta en 3 s, cuenta como caído

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Le mando la consulta más simple de GraphQL. No lleva token, pero no
// importa: los subgrafos solo dejan el actor en null, no rechazan la petición
// (igual que cuando el Gateway les pide el esquema).
export async function subgrafoResponde(url) {
  try {
    const respuesta = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
      signal: AbortSignal.timeout(TIMEOUT_PETICION_MS)
    });
    return respuesta.ok;
  } catch {
    // ECONNREFUSED, timeout, DNS que todavía no existe en docker, etc.
    return false;
  }
}

export async function esperarSubgrafos(
  subgraphs,
  {
    intentos = INTENTOS_POR_DEFECTO,
    esperaMs = ESPERA_POR_DEFECTO_MS,
    responde = subgrafoResponde // lo dejo inyectable para poder probarlo sin red
  } = {}
) {
  for (let intento = 1; intento <= intentos; intento++) {
    const pendientes = [];

    for (const subgraph of subgraphs) {
      if (!(await responde(subgraph.url))) pendientes.push(subgraph.name);
    }

    if (pendientes.length === 0) {
      console.log('[gateway] Todos los subgrafos responden. Componiendo supergrafo...');
      return;
    }

    console.warn(
      `[gateway] Esperando subgrafos (${intento}/${intentos}): ${pendientes.join(', ')}`
    );

    if (intento < intentos) await esperar(esperaMs);
  }

  // Si después de todos los intentos sigue faltando alguno, ahora sí truena,
  // pero con un mensaje claro. En docker el restart del compose lo vuelve a levantar.
  throw new Error(
    `[gateway] Subgrafos sin responder después de ${intentos} intentos. ` +
      'Revisa que estén prendidos y que las *_URL del .env sean correctas.'
  );
}
