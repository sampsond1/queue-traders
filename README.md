# Queue Exchange page

This is the Stage 5 static page. It reads the public Supabase tables directly through the PostgREST API; the browser only needs the project's publishable (or legacy `anon`) key. Row Level Security grants read-only access to the pipeline tables.

## Connect the page to Supabase

1. In Supabase, open **Project Settings → API** (or **API Keys**) and copy the project URL and publishable key. A legacy `anon` key also works.
2. Put those values in `config.js`. That key is intended to be visible to browsers. Never use a `secret` or `service_role` key here.
3. Open `index.html` through a local static server or publish this repository's `docs/` directory with GitHub Pages.

The page queries `rides`, `ride_wait_observations`, `ride_best_times_snapshots`, and `ride_reliability_summary`. It limits its observation history to six hours and checks for new rows once per minute.

The ten selected Disneyland Resort rides share one graph. Legend tags identify Disneyland (`DL`) and California Adventure (`DCA`), and each ride can be toggled independently. Selecting a ride in the watchlist opens its current and historical details.

## Game setup

The game uses Supabase Auth, the `game-api` Edge Function, and the migrations in `supabase/migrations/`. Apply them in timestamp order in the Supabase SQL Editor. If you already applied `20261111170000_add_wait_trading_game.sql`, apply the follow-up `20261111180000_add_game_display_usernames.sql`; do not rerun or edit an already-applied migration. Deploy `supabase/functions/game-api/index.ts`, enable the email sign-in provider, and add the published GitHub Pages URL to Supabase Auth's allowed redirect URLs. New accounts receive 1,000 credits; an authenticated visit claims at most 100 daily credits. Players choose a unique display username for the leaderboard; their email remains private. Trades are validated and recorded atomically in Postgres. The Edge Function checks the user's session before making privileged database calls. When deploying in the Dashboard, turn off the platform JWT pre-check for this function; `withSupabase` still enforces its user-or-publishable-key authentication modes in the handler.

The page loads `supabase-js` from jsDelivr. The browser uses the publishable/anon key in `config.js`. Never add a secret/service-role key to the page or repository.

## Publish with GitHub Pages

In the repository's **Settings → Pages**, choose **Deploy from a branch**, select the branch containing this page, and choose the `/docs` folder. GitHub will provide the shareable `github.io` address. The project URL and publishable key are public client settings; access remains read-only under the database's RLS policies.

The two ride lists in `app.js` mirror the choices in `instructions/game_idea.md`. A choice that the source does not return for that park remains visible as unavailable instead of being replaced by another ride.
