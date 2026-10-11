# SwingDelay — Supabase setup (one time)

## 1. Create the project
1. Go to https://supabase.com and create a free account + project.
2. Wait for the project to finish provisioning.

## 2. Run the schema
1. Open **SQL Editor** → **New query**.
2. Paste the entire contents of `schema.sql` and run it.
3. You should see "Success. No rows returned" (it creates tables, the
   `swing-videos` storage bucket, invite-code function, and all RLS policies).

## 3. Get the keys
1. Go to **Project Settings → API**.
2. Copy the **Project URL** and the **anon public** key.

## 4. Connect the app
Open https://atkinsonhitting-lab.github.io/swing-delay/ — the setup screen
asks for the Project URL and anon key once, then saves them on that device.
(You can also hard-code them in `js/config.js`.)

## 5. Accounts
- **Coach:** sign up in the app with role "Coach".
- **Hitter:** coach adds the hitter on the Roster screen and shares the
  invite code (e.g. `SD-X7K2P9`). The hitter signs up with role "Hitter"
  and enters the code — their login links to the hitter profile.

## Tip: turn off email confirmation
**Authentication → Providers → Email → Confirm email: OFF.**
Otherwise new accounts can't log in until they click the email link.

## Notes
- Videos are stored in the private `swing-videos` bucket; the app uses
  1-hour signed URLs for playback.
- Row-level security: coaches see only their own hitters; hitters see only
  their own swings.
