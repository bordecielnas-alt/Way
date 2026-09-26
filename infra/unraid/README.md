# Way sur Unraid

1. **Apps** → installer le plugin **Docker Compose Manager**.
2. **Docker** → en bas, **Add New Stack**, nom `way`.
3. Sur la stack : **Edit Stack → Compose File**, coller [`docker-compose.yml`](docker-compose.yml).
4. **Edit Stack → Env File**, coller [`.env.example`](.env.example) et renseigner au moins
   `POSTGRES_PASSWORD` et `WAY_CONTACT`.
5. **Compose Up**. Au premier démarrage, `way-borders` télécharge les frontières (~66 Mo) puis s'arrête :
   c'est normal qu'il reste « stopped ».
6. Ouvrir `http://<ip-unraid>:8088` (ou l'icône WebUI de `way-front` dans l'onglet Docker).

Mise à jour : **Update Stack** (pull des nouvelles images), puis **Compose Up**.

Données dans `APPDATA` (défaut `/mnt/user/appdata/way`) : `postgres/`, `redis/`, `borders/`.
Si tu as un pool cache, préfère `/mnt/cache/appdata/way` pour Postgres (évite la couche FUSE de `/mnt/user`).
