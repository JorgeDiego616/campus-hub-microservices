# Comprobación manual de la caché de Mapa

1. Desde la raíz del repositorio, levanta la infraestructura:

   ```powershell
   docker compose -f Docker/docker-compose.yml up -d mongodb redis-stack rabbitmq
   ```

2. En `Proyecto/node_modules-v2/services/mapa-service`, instala y arranca el servicio:

   ```powershell
   npm install
   npm start
   ```

   La configuración local usa `REDIS_URL=redis://default:password123@localhost:6380` y un TTL de 60 segundos. Para ejecutarlo en una red Docker, usa `INFRASTRUCTURE_MODE=docker`; allí se utiliza `redis-stack:6379`.

3. En Apollo Sandbox (`http://localhost:4002`) ejecuta dos veces la misma consulta:

   ```graphql
   query {
     espacios { id nombre tipo edificio piso descripcion activo coordenadas { latitud longitud } }
   }
   ```

   La primera salida de consola es `MISS` con `fuente=MongoDB`; la segunda es `HIT` con `fuente=Redis`. Para la consulta individual, sustituye el identificador real y repítela:

   ```graphql
   query {
     espacio(id: "ID_DEL_ESPACIO") { id nombre tipo edificio piso descripcion activo }
   }
   ```

4. Consulta las claves y su TTL sin usar `KEYS`:

   ```powershell
   docker exec ulsa-redis-stack redis-cli -a password123 --scan --pattern "cache:espacio*"
   docker exec ulsa-redis-stack redis-cli -a password123 TTL "cache:espacios:tipo:ausente:activo:ausente"
   ```

5. Crea un espacio o cambia su estado; después del éxito de MongoDB, las claves `cache:espacio*` se invalidan y la siguiente consulta vuelve a producir `MISS`.

   ```graphql
   mutation {
     crearEspacio(input: { nombre: "Sala de prueba", tipo: AULA, edificio: "A", piso: 1 }) { id nombre activo }
   }
   ```

6. Para comprobar la degradación, detén solo Redis (`docker compose -f Docker/docker-compose.yml stop redis-stack`) y consulta `espacios`. Debe responder desde MongoDB y registrar `resultado=UNAVAILABLE fuente=MongoDB`. Al volver a iniciar Redis, las nuevas consultas se rellenarán cuando el cliente recupere la conexión.

7. Ejecuta las pruebas automatizadas del servicio:

   ```powershell
   npm test
   ```

   Estas cubren la eliminación de cada lote devuelto por `SCAN` en `redis@5`, la degradación ante un error Redis y la publicación de los tres eventos de mutación aunque la invalidación no esté disponible.

Las mutaciones invalidan tanto la clave individual como todas las listas por el prefijo restringido `cache:espacio*`; si Redis está caído, el error queda como advertencia y MongoDB/RabbitMQ siguen completando la mutación. La información puede permanecer obsoleta como máximo el TTL configurado hasta que Redis vuelva a estar disponible y se pueda invalidar o recargar.
