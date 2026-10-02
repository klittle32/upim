# upim

`upim` is a command-line client for the [UnoPim 3.1 REST API](https://devdocs.unopim.com/3.1/api/). It is meant for people and for coding agents. The runtime dependency is [Effect 4](https://effect.website/). Node.js 24 or newer runs the TypeScript entrypoint directly.

## Install

From a checkout:

```bash
npm install
npm link
```

From GitHub:

```bash
npm install -g github:klittle32/upim
pnpm add -g github:klittle32/upim
bun add -g github:klittle32/upim
```

The binary is `upim`.

Install the agent skill into the project you are working in. Pi and other Agent Skills clients discover `.agents/skills/upim`.

```bash
upim skill install
upim skill install --user
upim skill install --path .letta/skills/upim
upim skill install --path ~/.claude/skills/upim
```

With no `--path`, the skill is written to `.agents/skills/upim` in the current project. `--user` writes `~/.agents/skills/upim`. `--path` is any other harness directory: a relative path starts at the current directory, and `~` is your home directory.

## Configure

UnoPim integrations use four values: base URL, OAuth client id, client secret, and the robot user's username and password. Create them under **Configuration → Integrations**, then generate the secret key. The robot password is shown once.

Interactive setup:

```bash
upim config init
```

Non-interactive setup:

```bash
upim config init --non-interactive \
  --base-url https://pim.example.com \
  --client-id "$UPIM_CLIENT_ID" \
  --client-secret "$UPIM_CLIENT_SECRET" \
  --username "$UPIM_USERNAME" \
  --password "$UPIM_PASSWORD" \
  --save-password
```

Or write the file yourself. The default location follows the XDG base directory spec:

- config: `$XDG_CONFIG_HOME/upim/config.json` or `~/.config/upim/config.json`
- tokens: `$XDG_STATE_HOME/upim/tokens.json` or `~/.local/state/upim/tokens.json`

Both files are written with mode `0600`. See [examples/config.json](examples/config.json).

```bash
upim config path
upim config example
upim config show
```

`--config path/to/config.json` stores tokens beside that file unless `UPIM_TOKEN_FILE` is set. Profiles live in one document. `upim config use staging` selects one, and `--profile staging` overrides it for a single command.

Environment variables override the selected profile and are not written back:

| Variable | Purpose |
| --- | --- |
| `UPIM_BASE_URL` | Base URL |
| `UPIM_CLIENT_ID` | OAuth client id |
| `UPIM_CLIENT_SECRET` | OAuth client secret |
| `UPIM_USERNAME` | Robot username |
| `UPIM_PASSWORD` | Robot password |
| `UPIM_PROFILE` | Profile name |
| `UPIM_CONFIG_FILE` | Config file, same as `--config` |
| `UPIM_CONFIG_HOME` | Directory that contains `config.json` |
| `UPIM_STATE_HOME` | Directory that contains `tokens.json` |
| `UPIM_TOKEN_FILE` | Exact token file path |

## Authentication

The API uses the OAuth 2.0 password grant. `POST /oauth/token` is called with HTTP Basic auth of `clientId:clientSecret` and a JSON body:

```json
{ "username": "robot", "password": "secret", "grant_type": "password" }
```

Refresh uses the same endpoint:

```json
{ "refresh_token": "...", "grant_type": "refresh_token" }
```

`upim` stores the access token, refresh token, and expiry. It refreshes about 60 seconds before `expires_in`, and again once if a call returns `401`. A failed refresh falls back to the password grant when a password is available. Token requests are not sent before every API call: the defaults are 10 token requests per minute and 120 API requests per minute. A `429` waits for `Retry-After` (or an exponential backoff) and retries up to 5 times.

```bash
upim auth login
upim auth status
upim auth refresh
upim auth logout
```

API commands log in on their own when a saved token is missing and credentials are available.

## Commands

Start with `upim endpoints --json`. Each action includes the `describe` command that prints its fields. Failures are one JSON object on stderr, with `error`, `message`, and `path`.

The base URL is the site root, for example `https://pim.example.com`, not a path ending in `/api/v1/rest`.

## Fields and validation

Command help stays a flag list. The field reference is separate, and the same record is what agents should read:

```bash
upim describe products create
upim describe products create --json
upim schema --json
```

`describe` prints the method, path, parameters, a static JSON Schema, and a copy-paste command. `--json` is the stable machine-readable form; its `example.command` uses the CLI flag names. `schema` prints one OpenAPI 3.1 document generated from those Effect schemas.

`upim describe products create --live --family default` reads the attribute dictionary from the configured server and fills the value buckets. It does not change what is rejected locally.

The schemas check the static envelope only. A product body must include `sku`, `family`, and `type`, and `values` must use the documented buckets, but attribute codes inside those buckets are not known until you ask the server:

```bash
upim attributes list --json
upim families get default --json
```

Unknown keys are sent through. A `422` from UnoPim is the real validation result. Measurement routes document the path and not the JSON body, so those payloads are not checked locally. `--help` for an action ends with `upim describe <resource> <action>`.

```bash
upim products list --limit 100 --pagination-type search_after --all
upim products list --filter 'updated_at:>=:2026-08-01 00:00:00' --pagination-type search_after
upim products get shirt-1 --with-completeness
upim products create --file product.json
upim attributes patch color --data '{"type":"select"}'
upim media product upload --file ./front.webp --sku shirt-1 --attribute image
upim passports publish shirt-1 --data '{"channel_id":1,"locale_ids":[1]}'
upim api GET /api/v1/rest/products --query limit=10
```

Filters accept either a raw JSON `--filters` object, as documented by UnoPim, or repeatable `--filter key:operator:value` clauses such as `sku:IN:a,b` and `status:=:true`. `--all` follows `links.next` until it is null. `304 Not Modified` is returned as `{ "notModified": true }` when you pass `--if-none-match`. `--meta` adds the status line and response headers.

Covered resources: attributes and options, attribute groups, families and variant structures, categories, category fields and options, products, configurable products, channels, locales, currencies, association types and fields, product/category/swatch media, digital product passports, and measurement families, units, and attribute bindings. `upim api` sends any other path with the same authentication.

## Development

```bash
npm test
npm run check
npm run journal -- "note about the current milestone"
```

`npm run journal` records development notes with `@earendil-works/pi-durable` (and Chord, pi-ai, and the built-in coding tools) in `.durable/`. Those packages are dev-only.
