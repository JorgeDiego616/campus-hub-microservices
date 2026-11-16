import neo4j from 'neo4j-driver';
import { getDriver } from '../infrastructure/database.js';

function toNumber(value) {
  return neo4j.isInt(value) ? value.toNumber() : value;
}

export const rbacService = {
  async validarAccesoRuta(userId, path) {
    const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
    try {
      const cypher = `
        MATCH (u:User {id: $userId})-[:HAS_ROLE]->(r:Role)
        MATCH (r)-[:INHERITS*0..]->(effectiveRole:Role)-[:CAN_ACCESS]->(rt:Route {path: $path})
        RETURN count(rt) > 0 AS autorizado
      `;
      const result = await session.run(cypher, { userId, path });
      return result.records[0]?.get('autorizado') ?? false;
    } finally {
      await session.close();
    }
  },

  async obtenerMenuUsuario(userId) {
    const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
    try {
      const cypher = `
        MATCH (u:User {id: $userId})-[:HAS_ROLE]->(r:Role)
        MATCH (r)-[:INHERITS*0..]->(effectiveRole:Role)-[:CAN_VIEW_MENU]->(parent:MenuNode)
        WHERE NOT ()-[:HAS_CHILD]->(parent)
        OPTIONAL MATCH (parent)-[:NAVIGATES_TO]->(rtParent:Route)
        OPTIONAL MATCH (parent)-[:HAS_CHILD]->(child:MenuNode)
          WHERE (effectiveRole)-[:CAN_VIEW_MENU]->(child)
        OPTIONAL MATCH (child)-[:NAVIGATES_TO]->(rtChild:Route)
        RETURN parent.id AS id, parent.title AS title, parent.order AS order, rtParent.path AS path,
               collect(DISTINCT CASE WHEN child IS NOT NULL THEN {
                 id: child.id,
                 title: child.title,
                 order: child.order,
                 path: rtChild.path
               } END) AS children
        ORDER BY parent.order ASC
      `;
      const result = await session.run(cypher, { userId });

      return result.records.map(record => ({
        id: record.get('id'),
        title: record.get('title'),
        order: toNumber(record.get('order')),
        path: record.get('path'),
        children: record.get('children')
          .filter(Boolean)
          .map(child => ({ ...child, order: toNumber(child.order) }))
          .sort((a, b) => a.order - b.order)
      }));
    } finally {
      await session.close();
    }
  }
};
