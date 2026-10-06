# outbrief-server

[中文](README.md)

OutBrief server. It only relays. [outbrief-daemon](https://github.com/outbriefapp/outbrief-daemon) sends an encrypted report (including the spoken brief). The server holds that ciphertext in MySQL and pushes a call to clients over SSE. After hang-up it queues the client's encrypted reply back to the daemon. The server has no key, so it cannot read the report, the brief, or the reply. There is no login. An account is anonymous. Each device has its own token. Later devices join that account with a pairing code.

The long API reference, protocol notes, and ADRs stay in the [Chinese README](README.md) and in [`docs/adr/`](docs/adr/). This page is the deploy, install-order, and pairing guide.

| Repo | Role |
|---|---|
| `outbrief-server` (this repo) | Hono server + MySQL |
| [`outbrief-app`](https://github.com/outbriefapp/outbrief-app) | Tauri 2 + React 19 client (desktop and mobile) |
| [`outbrief-daemon`](https://github.com/outbriefapp/outbrief-daemon) | One resident process per agent computer. Claude Code / Codex stop hooks live here |

## Install order

Calls stay inside one anonymous account. Let the daemon on the computer that runs the agents create the account. The desktop app and the phone app join that account.

1. **Deploy this repo.** Run exactly one process. On a private deploy (the default), every start prints a one-time claim code while the server has no owner yet: `Claim code: XXXX-XXXX-XXXX`. Write down the server URL. Phones and other computers must be able to open that URL. `http://127.0.0.1:8787` works only on the machine that runs the server. When a phone will pair, put a LAN IP or a public `https://` URL in the daemon and the app. Commands are under [Deploy](#deploy).
2. **Install [outbrief-daemon](https://github.com/outbriefapp/outbrief-daemon)** on the computer that runs the agents. After `pnpm install`, run `node src/cli.ts login --server <server-url>` and enter the claim code. The terminal prints a QR code and a 6-digit code. On macOS, then run `node src/cli.ts install` (start at login, and write the Claude Code / Codex Stop hooks). `install` stores the absolute path of node and `src/cli.ts` in launchd, so leave the checkout where it is.
3. **Install the desktop app ([outbrief-app](https://github.com/outbriefapp/outbrief-app))** on that same computer. `pnpm tauri build` writes installers to `src-tauri/target/release/bundle/`. For development, `pnpm tauri dev`. When the daemon is already running, the desktop app joins that daemon's account the first time it opens.
4. **Install the mobile app.** Same repo. Generate the Android or iOS project locally, then compile: `pnpm tauri android init`, then `pnpm tauri android dev` or `pnpm tauri android build`. For iOS: `pnpm tauri ios init`, then `pnpm tauri ios dev` or `pnpm tauri ios build`. You need the [Tauri mobile prerequisites](https://tauri.app/start/prerequisites/). This repo does not ship a store binary. On a device that is already paired, open Settings → Devices → Add a device, or run `node src/cli.ts pair` on the computer, and scan the QR code with the phone camera.

### Pairing

There is no login and no shared password. The first device creates the account. Later devices join with a 6-digit code. The code lasts 10 minutes and works once. The QR code and the link look like `outbrief://pair?server=<server-url>&code=<6 digits>&key=obk1_…`. The server URL and the end-to-end key go from device to device. The server never sees the key.

| Already in the account | Device joining | What to do |
|---|---|---|
| Daemon running on this computer | Desktop app on the same computer | Automatic. The app reads `~/.outbrief/local-api.key` and asks `127.0.0.1:8790` for a pairing code and the key |
| Desktop app, or the daemon (`node src/cli.ts pair`) | Phone app | Scan the QR code from Settings → Devices → Add a device, or the QR code in the terminal |
| Phone, or an app on another computer | Daemon on a computer | Copy the command from Add a device and run `node src/cli.ts login 'outbrief://pair?…'` on that computer |
| Any paired device | Desktop app on another computer | Paste the pairing link into the welcome screen. The desktop app does not open the camera |
| 6 digits only | Daemon or app | Also enter the same sentence from Settings → Encryption (at least 12 characters). When that sentence was never set, use the QR code or the link that carries `key=` |

The app can create the account instead. On the welcome screen, enter the server URL and the claim code, then choose Create a new account. Copy the link from Add a device and `login` the computer with it. After the daemon on that computer is paired and running, the desktop app on that computer joins the daemon's account.

Phone only, no desktop app: finish steps 1 and 2, then scan the QR code the daemon printed at login. Multica, the LLM, and the report language on the phone are encrypted and relayed through the server to that computer's daemon. The computer has to be online.

On a public server, set `OUTBRIEF_OPEN_SIGNUP=true`. The first device creates an account with no claim code.

## Deploy

Run **one instance**. Presence, SSE, settings relay, and rate limits live in process memory ([ADR 0009](docs/adr/0009-single-instance-first.md)). Keep the replica count at 1. Publish by stopping the old process and then starting the new one (Kubernetes `strategy: Recreate`). A rolling update or a blue-green deploy runs two versions at once and drops calls. Back up MySQL.

### Run it directly

Node ≥ 22.18, pnpm 9, MySQL 8. Migrations in `db/migrations/` run when the process starts.

```bash
pnpm install
OUTBRIEF_DATABASE_URL='mysql://USER:PASSWORD@HOST:3306/outbrief' PORT=8787 pnpm start
```

The deployment environment injects `OUTBRIEF_DATABASE_URL`. The user and password above are placeholders. Use your own account in production and keep the connection string out of the repo. The local-development password lives only in [`db/bootstrap.sql`](db/bootstrap.sql).

Until someone claims the server, the log prints `Claim code: XXXX-XXXX-XXXX`. The first device (the app welcome screen, or `outbrief-daemon login`) enters that code. After the claim, signup is closed and other devices join with a pairing code. A public server sets `OUTBRIEF_OPEN_SIGNUP=true`.

Health check: `GET /healthz`.

### Environment

Nothing is required. The process starts with no `.env`. [`.env.example`](.env.example) only lists the defaults you can override.

| Variable | Default | Meaning |
|---|---|---|
| `OUTBRIEF_DATABASE_URL` | `mysql://outbrief:outbrief_local@127.0.0.1:3306/outbrief` | Injected by the platform. The default is the local docker database `outbrief` |
| `PORT` | `8787` | Listen port |
| `OUTBRIEF_OPEN_SIGNUP` | `false` | `true`: anyone may create an account (public server, rate limited). `false`: the first account needs the claim code from the log, then signup closes |
| `OUTBRIEF_TEST_DATABASE_URL` | `…/outbrief_test` | Test database. The name must end in `_test` |

### Railway

[`railway.json`](railway.json) sets the health check and the restart policy. The rest is configured in Railway:

- Add a MySQL 8 service (image `mysql:8.4`, volume on `/var/lib/mysql`). Private network only. Leave the public TCP proxy off.
- On the server service, set `OUTBRIEF_DATABASE_URL` to the MySQL service's `MYSQL_URL` (`${{MySQL.MYSQL_URL}}`). Keep that connection string out of the repo and out of docs. Set `PORT=8787`.
- One replica. Attach a volume to the server (for example `/data`; the code does not read or write it). Railway then stops the old deployment before starting the new one, and it will not scale past one replica.
- Add the CNAME and `_railway-verify` TXT records Railway shows. With Cloudflare, use DNS only (grey cloud) until Railway has issued the certificate.

### Local development

Node ≥ 22.18, pnpm 9, and a local MySQL 8 (docker container `some-mysql`).

```bash
pnpm install
# 1. Create the database and user once, as root
docker exec -i some-mysql mysql -uroot -p < db/bootstrap.sql
# 2. Create tables (startup does this too)
pnpm db:migrate
# 3. Start. The log prints a claim code while the server has no owner
pnpm dev
```

Schema changes are new files `db/migrations/NNN_*.sql`, applied once in filename order. Applied versions are recorded in `schema_migrations`. Add a new file. Leave a file that has already been applied alone.

## Commands

| Command | What it does |
|---|---|
| `pnpm lint` / `pnpm format` | Biome check / write |
| `pnpm typecheck` | `tsc` |
| `pnpm test` | Vitest against `OUTBRIEF_TEST_DATABASE_URL` (must be a `*_test` database; the tests truncate it) |
| `pnpm db:migrate` | Apply migrations that have not run |
| `pnpm start` | Run the server |

## License

[OutBrief License](LICENSE) (Apache License 2.0 plus extra terms, following the [Multica License](https://github.com/multica-ai/multica/blob/main/LICENSE)).
