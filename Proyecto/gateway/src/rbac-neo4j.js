import neo4j from 'neo4j-driver';
import { GraphQLError } from 'graphql';

// Este módulo es la "puerta" RBAC del Gateway.
// Antes de mandar una mutación a cualquier subgrafo le pregunto a Neo4j si el
// usuario la puede ejecutar. Si Neo4j dice que no, la corto aquí con un 403 y
// la mutación nunca llega al subgrafo, entonces tampoco toca MongoDB.

const GQL_PREFIX = 'gql:';

// Misma idea que validarAccesoRuta de seguridad-service:
// User -[:HAS_ROLE]-> Role -[:INHERITS*0..]-> Role -[:CAN_ACCESS]-> Route.
// El *0.. hace que cuente su propio rol (0 saltos) y todos los que hereda.
// Además regreso rt.public para saber si la mutación ni siquiera necesita rol.
// Si la ruta no existe en el catálogo, la consulta no regresa filas.
const PERMISO_CYPHER = `
  MATCH (rt:Route {path: $path})
  OPTIONAL MATCH (u:User {id: $userId})-[:HAS_ROLE]->(:Role)
                 -[:INHERITS*0..]->(:Role)-[:CAN_ACCESS]->(rt)
  RETURN rt.public AS publica, count(u) > 0 AS autorizado
`;

export function createRbacGraph({ uri, user, password }) {
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

  return {
    async consultarPermiso(userId, path) {
      const session = driver.session({ defaultAccessMode: neo4j.session.READ });
      try {
        const result = await session.run(PERMISO_CYPHER, {
          userId: userId ?? null,
          path
        });
        const record = result.records[0];

        // Sin registro = la mutación no está en el catálogo.
        if (!record) return { existe: false, publica: false, autorizado: false };

        return {
          existe: true,
          publica: record.get('publica') === true,
          autorizado: record.get('autorizado') === true
        };
      } finally {
        await session.close();
      }
    },

    async close() {
      await driver.close();
    }
  };
}

// Saco los nombres de los campos raíz de la mutación, por ejemplo
// mutation { registrarEquipo(...) { id } } -> ['registrarEquipo'].
// Uso el nombre real del campo y no el alias, para que nadie pueda
// "disfrazar" la mutación con otro nombre.
// También abro los fragmentos (...on Mutation y ...MiFragmento), porque si no,
// alguien podría esconder una mutación dentro de un fragmento y saltarse esto.
export function mutationFieldNames(operation, fragments = {}) {
  const names = [];
  const visitados = new Set();

  const recorrer = (selectionSet) => {
    for (const selection of selectionSet?.selections ?? []) {
      if (selection.kind === 'Field') {
        if (!selection.name.value.startsWith('__')) names.push(selection.name.value);
      } else if (selection.kind === 'InlineFragment') {
        recorrer(selection.selectionSet);
      } else if (selection.kind === 'FragmentSpread') {
        const nombre = selection.name.value;
        if (visitados.has(nombre)) continue;
        visitados.add(nombre);

        const fragment = fragments[nombre];
        // Si el fragmento no existe mejor fallo, no lo dejo pasar en silencio.
        if (!fragment) throw forbidden();
        recorrer(fragment.selectionSet);
      }
    }
  };

  recorrer(operation.selectionSet);
  return names;
}

function forbidden() {
  return new GraphQLError('No tienes permiso para realizar esta operación.', {
    extensions: { code: 'FORBIDDEN', http: { status: 403 } }
  });
}

function unauthenticated() {
  return new GraphQLError('Se requiere una identidad autenticada.', {
    extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } }
  });
}

function unavailable() {
  return new GraphQLError('No se pudo validar la autorización. Intenta más tarde.', {
    extensions: { code: 'SERVICE_UNAVAILABLE', http: { status: 503 } }
  });
}

// Plugin de Apollo Server. Uso didResolveOperation porque en ese momento la
// operación ya está parseada y validada, pero el Gateway todavía no la ha
// mandado a los subgrafos. Si lanzo un error aquí, la ejecución se cancela.
// onAccessDenied es opcional: sirve para avisar a auditoría (RabbitMQ).
export function rbacPlugin({ consultarPermiso, onAccessDenied = () => {} }) {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ operation, document, contextValue }) {
          // Las queries no escriben nada, entonces solo reviso mutaciones.
          if (operation?.operation !== 'mutation') return;

          const fragments = {};
          for (const definition of document?.definitions ?? []) {
            if (definition.kind === 'FragmentDefinition') {
              fragments[definition.name.value] = definition;
            }
          }

          const actor = contextValue?.authentication?.actor ?? null;

          for (const fieldName of mutationFieldNames(operation, fragments)) {
            const path = `${GQL_PREFIX}${fieldName}`;

            let permiso;
            try {
              permiso = await consultarPermiso(actor?.id, path);
            } catch (error) {
              // Fail-closed: si Neo4j está caído NO dejo pasar la mutación.
              // Al revés que RabbitMQ: la auditoría puede fallar, la autorización no.
              console.warn(`[gateway] Neo4j no disponible para RBAC: ${error.message}`);
              throw unavailable();
            }

            if (permiso.existe && permiso.publica) continue;

            if (!actor) throw unauthenticated();

            if (!permiso.existe || !permiso.autorizado) {
              // Una mutación que no está en el catálogo también se bloquea,
              // así si alguien agrega una nueva y olvida darla de alta, queda cerrada.
              onAccessDenied({
                actor,
                path,
                ip: contextValue?.ip,
                motivo: permiso.existe
                  ? 'Rol sin permiso en Neo4j'
                  : 'Operación no registrada en el catálogo RBAC'
              });
              throw forbidden();
            }
          }
        }
      };
    }
  };
}
