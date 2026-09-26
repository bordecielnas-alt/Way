# Way sur Unraid

Un seul conteneur.

## Option A — à la main (le plus simple)

**Docker → Add Container**, puis :

| Champ | Valeur |
|---|---|
| Name | `way` |
| Repository | `ghcr.io/bordecielnas-alt/way:latest` |
| Port | container `8080` → host `8080` (ou un port libre) |
| Path | container `/data` → host `/mnt/user/appdata/way` |
| Variable (optionnel) | `WAY_CONTACT` = ton email |

**Apply**, puis ouvrir `http://<ip-unraid>:8080`.

## Option B — template

Copier [`my-way.xml`](my-way.xml) dans `/boot/config/plugins/dockerMan/templates-user/`,
puis **Docker → Add Container → Template : way**.

## Notes

- Premier démarrage : les frontières historiques (~66 Mo) se téléchargent en arrière-plan ;
  la carte les affiche dès qu'elles sont prêtes.
- Mise à jour : **Docker → Check for Updates → Update**.
