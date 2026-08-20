# Frontend source

TypeScript source and Vite build configuration live here. Runtime bundles are emitted to `backend/public/`, which remains the static directory served by Express.

Use `npm run typecheck:frontend --prefix backend` to type-check the source and `npm run build:frontend --prefix backend` to rebuild a browser bundle. The first migrated shared module is the API client; remaining public scripts are migrated incrementally to preserve page behaviour.
