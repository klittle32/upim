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
3. Success is JSON on stdout. Failure is one JSON object on stderr with `error`, `message`, and `path`, and a non-zero exit. Read stderr before retrying.

Do not load `upim schema --json`. It is the whole API and is too large.

## Setup

The base URL is the site root, such as `https://pim.example.com`. Never append `/api/v1/rest` or `/oauth/token`.

If a command says the profile is not configured, run `upim config init` or `upim config init --non-interactive` with `--base-url`, `--client-id`, `--client-secret`, `--username`, and `--password`. `upim` logs in and refreshes tokens itself. Do not call `/oauth/token` directly.

## Contracts

- Path arguments are positional: `upim products get shirt-1`.
- Query flags use the spelling in `example.command`. List calls use `--limit`, `--pagination-type search_after`, `--search-after`, and `--filter key:operator:value`.
- Send a JSON body with `--data` or `--file`. `--file -` reads stdin.
- A `path` such as `/sku` is the field to fix. Unknown keys are allowed. A `422` from UnoPim is the authority for attribute rules.
- For a large catalog, use `--pagination-type search_after` and `--all`.

## Product values

The static schema only checks the envelope: `sku`, `family`, `type`, and the buckets `common`, `categories`, `channel_specific`, and `channel_locale_specific`.

For real attribute codes, run:

```bash
upim describe products create --live --family <code> --json
```

Place each returned field in the bucket where it appears. `--live` changes the documentation only. It does not make the local check stricter.

## Install

This skill is already installed when you can read it. Refresh it with `upim skill install`, `upim skill install --user`, or `upim skill install --path <directory>`. Relative paths start at the current directory. A leading `~` is the home directory, for example `~/.claude/skills/upim`.
