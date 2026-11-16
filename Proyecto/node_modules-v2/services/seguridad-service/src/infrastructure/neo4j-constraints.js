const CONSTRAINTS = [
    `CREATE CONSTRAINT unique_user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE`,
    `CREATE CONSTRAINT unique_role_name IF NOT EXISTS FOR (r:Role) REQUIRE r.name IS UNIQUE`,
    `CREATE CONSTRAINT unique_route_path IF NOT EXISTS FOR (rt:Route) REQUIRE rt.path IS UNIQUE`,
    `CREATE CONSTRAINT unique_menu_id IF NOT EXISTS FOR (m:MenuNode) REQUIRE m.id IS UNIQUE`
];

export async function ensureRbacConstraints(driver) {
  const session = driver.session();
  try {
    // Cada constraint es una sentencia de esquema: se ejecuta por separado.
    for (const cypher of CONSTRAINTS) {
      await session.run(cypher);
    }

    const result = await session.run(
      `SHOW CONSTRAINTS YIELD name RETURN name ORDER BY name`
    );
    return result.records.map((record) => record.get('name'));
  } finally {
    await session.close();
  }
}