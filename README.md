# go-pmtiles

The single-file utility for creating and working with [PMTiles](https://github.com/protomaps/PMTiles) archives.

## Installation

See [Releases](https://github.com/protomaps/go-pmtiles/releases) for your OS and architecture.

## Docs

See [docs.protomaps.com/pmtiles/cli](https://docs.protomaps.com/pmtiles/cli) for usage.

See [Go package docs](https://pkg.go.dev/github.com/protomaps/go-pmtiles/pmtiles) for API usage.

## Development

Run the program in development:

```sh
go run main.go
```

Run the test suite:

```sh
go test ./pmtiles
```

## Kaliventure admin API

This server keeps the Supabase and Groq secret keys out of the Expo app. It serves published destinations, the Kaliventure chatbot, and admin-only user and destination endpoints.

## Setup

1. In the Supabase Dashboard, open **SQL Editor** and run your existing `setup.sql`, followed by [`supabase-migration.sql`](supabase-migration.sql). The migration creates reviews, ratings, map coordinates, and the `place-images` storage bucket.
2. Copy `.env.example` to `.env` and set the project's URL and server-only secret key. Find the secret key in **Project Settings → API Keys**. A legacy `service_role` key also works. Never put this key in `kaliventure/.env.local` or any `EXPO_PUBLIC_` variable.
3. Add a Groq API key to `GROQ_API_KEY` in `.env`. The default model is `llama-3.1-8b-instant`; you can override it with `GROQ_MODEL`.
4. From this directory run `npm install`, then `npm start`.
5. Run the Expo app separately with `cd ../kaliventure` and `npm start`. For Expo Go, your phone and computer must be on the same network; the API binds to all local interfaces.
6. In Supabase SQL Editor, grant your account the admin role by running the commented SQL at the bottom of `setup.sql` with your account email. Sign out and back in afterward so the app gets a fresh session.

The admin console is available from the app menu only for users with `app_metadata.role = 'admin'`. User monitoring shows the latest 100 accounts, their join date, last sign-in date, and email confirmation status.
For a deployed API, set `EXPO_PUBLIC_ADMIN_API_URL` in the Expo app environment to the server's HTTPS base URL.
For a deployed API, set `EXPO_PUBLIC_ADMIN_API_URL` in the Expo app environment to the server's HTTPS base URL.
