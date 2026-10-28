# Fridge

Our weekly goals board: tally marks, voice notes, text notes and photo proof. Snap the fridge whiteboard and Claude fills in the week.

Live: https://fridge-board-fawn.vercel.app

## Stack

- Vite + plain JS, installable as a home-screen web app
- Supabase: Google sign-in, Postgres with row level security, private storage for media, realtime updates
- Claude (`claude-opus-5-5`) reads board photos, called from the browser with a key saved on that device

## Setup from scratch

1. Create a Supabase project and run `supabase/schema.sql` in the SQL editor.
2. Enable the Google provider in Supabase (client ID + secret from a Google Cloud OAuth web client whose redirect URI is `https://<project>.supabase.co/auth/v1/callback`).
3. In Supabase Auth URL configuration, set the site URL to your deployed URL and add `http://localhost:5179` as a redirect URL.
4. Copy `.env.example` to `.env.local` and fill in the Supabase URL and publishable key.
5. `npm install && npm run dev`

The first person to sign in joins without an invite. Everyone else joins from the invite link in Settings.

While the Google consent screen is in Testing mode, each person's Google account must be added as a test user in Google Cloud (Google Auth Platform, Audience).
