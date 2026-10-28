---
name: upim
description: Operate a UnoPim 3.1 catalog with the upim CLI. Use when the user mentions UnoPim, upim, PIM products, attributes, families, categories, media, or digital product passports, or when this skill is installed in the project.
compatibility: Requires the upim command on PATH and Node.js 24 or newer.
allowed-tools:
  - Bash(upim *)
---

# upim

Use the `upim` command for UnoPim. Do not invent REST calls, flag names, or product fields.

## Loop

1. `upim endpoints --json` lists every action. Each entry has a `describe` command.
2. `upim describe <resource> <action> --json` is the contract for that one action. Read `example.command` and run it. Do not translate flag names yourself.
3. Success is JSON on stdout. Failure is a non-zero exit, and the error is the last JSON line on stderr, with `error`, `message`, and `path`. Read it before retrying.
4. stderr may also carry one-line `{"warning": "..."}` objects on success or failure, for example when a torn token file was recovered or a lock was left to another process. Warnings are informational. They are never a reason to retry.

Do not load `upim schema --json`. It is the whole API and is too large.

## Setup

The base URL is the site root, such as `https://pim.example.com`. Never append `/api/v1/rest` or `/oauth/token`.

If a command says the profile is not configured, run `upim config init` or `upim config init --non-interactive` with `--base-url`, `--client-id`, `--client-secret`, `--username`, and `--password`. `upim` logs in and refreshes tokens itself. Do not call `/oauth/token` directly.

## Environment

- Environment variables override the selected profile and are never written back: `UPIM_PROFILE`, `UPIM_CONFIG_FILE`, `UPIM_CONFIG_HOME`, `UPIM_STATE_HOME`, `UPIM_TOKEN_FILE`, `UPIM_EXTENSIONS`, and the credential variables `UPIM_BASE_URL`, `UPIM_CLIENT_ID`, `UPIM_CLIENT_SECRET`, `UPIM_USERNAME`, and `UPIM_PASSWORD`. The README table is the full list.
- A variable that is unset or blank is ignored. Blank does not mean an empty value.
- Running many `upim` processes in parallel against one profile is safe. They share a lock on the token file, and only one of them logs in or refreshes.
- For experiments, point `UPIM_CONFIG_HOME` and `UPIM_STATE_HOME` at a scratch directory and create a profile there. Do not edit the user's real config or token file.

## Contracts

- Path arguments are positional: `upim products get shirt-1`.
- Query flags use the spelling in `example.command`. List calls use `--limit`, `--pagination-type search_after`, `--search-after`, and `--filter key:operator:value`.
- Send a JSON body with `--data` or `--file`. `--file -` reads stdin.
- A `path` such as `/sku` is the field to fix. Unknown keys are allowed. A `422` from UnoPim is the authority for attribute rules.
- For a large catalog, use `--pagination-type search_after` and `--all`. `--all` fails, rather than returning a partial catalog, if it hits `--max-pages` (default 1000) or a repeated `links.next`. Raise `--max-pages`, or resume from the `page` or `search_after` in the reported URL. A finished walk has `links.next` null.

## Extensions

Optional packages such as DAM are extension catalogs that a profile enables. `upim endpoints --json` is still the truth: extension actions appear there, tagged `"extension": "<name>"`, only when the active profile enables them, and are called as `upim ext <extension> <resource> <action>`.

- `upim extensions list --json` shows installed extensions and whether this profile enables them. Do not call an extension that is not enabled; the CLI refuses with a `ConfigError` that names the fix.
- If the user says the host has a package installed, run `upim extensions probe <name> --json` (GET only). `present` means the host serves it; then `upim extensions enable <name>` turns it on for the profile. A probe never enables anything.
- `UPIM_EXTENSIONS=dam` enables an extension for one command without changing the config.
- Extension bodies are not checked locally. Read `upim describe ext <extension> <resource> <action> --json` for the path and flags, and treat a `422` as the field reference.

## Product values

The static schema only checks the envelope: `sku`, `family`, `type`, and the buckets `common`, `categories`, `channel_specific`, and `channel_locale_specific`.

For real attribute codes, run:

```bash
upim describe products create --live --family <code> --json
```

Place each returned field in the bucket where it appears. `--live` changes the documentation only. It does not make the local check stricter.

## Install

This skill is already installed when you can read it. Refresh it with `upim skill install`, `upim skill install --user`, or `upim skill install --path <directory>`. Relative paths start at the current directory. A leading `~` is the home directory, for example `~/.claude/skills/upim`.
