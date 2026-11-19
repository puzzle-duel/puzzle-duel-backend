# PZD-42 Tournament UAT

This is a local playable slice. It is not production ranked HTTP, not a deployment, and not a passed manual UAT until the owner plays it.

The server listens only when `NODE_ENV` is not `production` or `prod`, `PZD_RUNTIME_PROFILE` is `development`, and `PZD_RANKED_HTTP_ENABLED` is exactly `true`. A production process environment still returns `RANKED_HTTP_DISABLED`.

New daily claims pin six distinct `gen-001.v1` boards as `core-001.v3` content `pzd-42-v4`: E1–E3 are Easy 5×5 with 15 moves and 1 obstacle (seeds 0, 1, 2), M1–M2 are Medium 6×6 with 12 moves and 2 obstacles (seeds 0, 1), and H1 is Hard 7×7 with 10 moves and 4 obstacles (seed 5). The generator algorithm is unchanged. The offers are wrapped into v3 piece slots. A claim already stored under `pzd-42-uat` keeps those older boards. Drop and recreate only `pzd_uat` before this physical session so today's play uses the new boards. Do not touch `pzd_ingress`. The client does not submit a score or a seal. A second device cannot take the writer; that recovery remains blocked.

## 1. Isolated PostgreSQL and backend

Use the existing local PostgreSQL 18. The UAT database is `pzd_uat`, created beside `pzd_ingress`. It is not a production database.

```bash
cd /Users/gokhanaydin/Desktop/workspace/puzzle-duel-backend-stage-f2
export PATH="$HOME/.nvm/versions/node/v26.13.1/bin:$PATH"
export NODE_ENV=development
export PZD_RUNTIME_PROFILE=development
export PZD_RANKED_HTTP_ENABLED=true
export PZD_INGRESS_DATABASE_URL='postgresql://pzd:pzd@127.0.0.1:55432/pzd_ingress'
export PZD_UAT_DATABASE=pzd_uat
export PZD_UAT_APPLY_MIGRATIONS=1
export PZD_UAT_HOST=0.0.0.0
export PZD_UAT_PORT=8787
export PZD_F2B_PROVENANCE_KEY='local-uat-provenance-key-at-least-32-chars'
npm run uat:server
```

`PZD_F2B_PROVENANCE_KEY` is a local HMAC key. Do not commit it or reuse it outside this machine. The signing key is created in `~/.pzd-uat` and is not in the repository.

## 2. Migrations

`PZD_UAT_APPLY_MIGRATIONS=1` applies `migrations/stage_f2/sql` to `pzd_uat` and then runs the startup guard. Identity session tables are created by the existing session store because they are not part of that versioned manifest.

## 3. Two UAT players

In a second terminal, with the same `PATH`:

```bash
cd /Users/gokhanaydin/Desktop/workspace/puzzle-duel-backend-stage-f2
npm run uat:issue
```

The command prints `PZD_UAT_BEARER_A` and `PZD_UAT_BEARER_B`. Those are the only two subjects the local issuer will sign.

## 4. iPhone Simulator

`127.0.0.1` on the simulator is the Mac, so the simulator can use port 8787 on localhost.

```bash
cd /Users/gokhanaydin/Desktop/workspace/puzzle-duel-client-core001v3-dart/apps/mobile
flutter run -d "iPhone 16" \
  --dart-define=PZD_UAT_BASE_URL=http://127.0.0.1:8787 \
  --dart-define=PZD_UAT_BEARER="$PZD_UAT_BEARER_A" \
  --dart-define=PZD_UAT_PLAYER="Player A"
```

Use the simulator name from `flutter devices` if `iPhone 16` is not listed.

## 5. Physical iPhone

`127.0.0.1` on the phone is the phone, not the Mac. Use the Mac's LAN address. The phone and the Mac must be on the same network. The server is bound to `0.0.0.0`.

```bash
ipconfig getifaddr en0
cd /Users/gokhanaydin/Desktop/workspace/puzzle-duel-client-core001v3-dart/apps/mobile
flutter run -d <device-id> \
  --dart-define=PZD_UAT_BASE_URL=http://<mac-lan-ip>:8787 \
  --dart-define=PZD_UAT_BEARER="$PZD_UAT_BEARER_A" \
  --dart-define=PZD_UAT_PLAYER="Player A"
```

If no physical device is configured, `flutter devices` will not list one. That launch is NOT_RUN until a device is paired.

## 6. Switch players

Stop the app and run the same command with `PZD_UAT_BEARER_B` and `PZD_UAT_PLAYER="Player B"`. Each player keeps a separate session file in the app temp directory. Relaunching the same player reuses that session. A second session for the same player cannot take the series writer.

## 7. Logs

Backend errors print in the `npm run uat:server` terminal. Flutter errors print in the `flutter run` terminal. The automated two-player proof is:

```bash
cd /Users/gokhanaydin/Desktop/workspace/puzzle-duel-backend-stage-f2
export PZD_INGRESS_DATABASE_URL='postgresql://pzd:pzd@127.0.0.1:55432/pzd_ingress'
npm run test:uat
```

It uses the disposable database `pzd_pzd42_uat` and drops it afterward.

## Manual checklist

Do not mark this passed until you have played it.

- Player A opens Tournament Home and can start today's challenge.
- E1 through H1 show the server board, tray, score, and remaining server time.
- A rejected tap does not change the board.
- After each of E1–M2, the transition screen advances to the next game.
- After H1, verified Easy, Medium, Hard, All, and the On-Time badge appear.
- Player B completes a second series on the same day.
- Daily and weekly boards show both players, category chips, and PROVISIONAL for the current week.
- A higher score ranks above a lower score. Equal scores share a competition rank.
- Claiming the same day again continues the same series.
- Quitting and relaunching the same player returns to that series.
- Turning the network off during a move shows an unknown outcome. The next action retries that same move and does not submit a different one.
- A second launch of the same player while the first session is the writer is rejected and does not change the board.
