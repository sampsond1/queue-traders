# Queue Exchange page

This is the Stage 5 static page. It reads the public Supabase tables directly through the PostgREST API; the browser only needs the project's publishable (or legacy `anon`) key. Row Level Security grants read-only access to the pipeline tables.

## Connect the page to Supabase

1. In Supabase, open **Project Settings → API** (or **API Keys**) and copy the project URL and publishable key. A legacy `anon` key also works.
2. Put those values in `config.js`. That key is intended to be visible to browsers. Never use a `secret` or `service_role` key here.
3. Open `index.html` through a local static server or publish this repository's `docs/` directory with GitHub Pages.

The page queries `rides`, `ride_wait_observations`, `ride_best_times_snapshots`, and `ride_reliability_summary`. It limits its observation history to six hours and checks for new rows once per minute.

## Publish with GitHub Pages

In the repository's **Settings → Pages**, choose **Deploy from a branch**, select the branch containing this page, and choose the `/docs` folder. GitHub will provide the shareable `github.io` address. The project URL and publishable key are public client settings; access remains read-only under the database's RLS policies.

The two ride lists in `app.js` mirror the choices in `instructions/game_idea.md`. A choice that the source does not return for that park remains visible as unavailable instead of being replaced by another ride.
