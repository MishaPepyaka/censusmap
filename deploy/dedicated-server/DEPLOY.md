# Dedicated Server Deploy

## 1. Copy project

```bash
git clone <YOUR_GITHUB_REPO_URL> selfhost-map-cmp
cd selfhost-map-cmp
cp .env.example .env
```

## 2. Configure

Edit `.env`:

```env
USE_FILE_STORE=false
POSTGRES_DB=maps
POSTGRES_USER=maps
POSTGRES_PASSWORD=change-me
EDIT_USERNAME=admin
EDIT_PASSWORD=change-me
APP_PORT=8080
```

If needed, also configure `CMP_*` values.

## 3. Start app

```bash
docker compose up --build -d
```

## 4. Import existing CLD files into Postgres

```bash
docker compose exec app npm run import:cld:db
```

## 5. Reverse proxy

Copy `deploy/dedicated-server/nginx.conf` to your nginx site config, then reload nginx.

## 6. Backups

Run:

```bash
./scripts/backup-cld-data.sh
```

Archive output is written to `data/backups/`.

## 7. Publish CLD data

From the local project:

```bash
./scripts/sync-cld-data-to-server.sh root@your-server /opt/censusmap
```
