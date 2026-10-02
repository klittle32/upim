import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import type { AppError } from "./errors.ts"
import type { HttpClientEnv } from "./client.ts"
import { flatten, resources, type Action, type FlatAction, type Resource } from "./catalog.ts"
import { describe, openApiDocument, renderText, type OperationDocument } from "./contract/document.ts"
import { applyLiveDictionary, attributesFromBody, familyAttributeCodes } from "./contract/live.ts"
import { checkBody, checkFilters } from "./contract/validate.ts"
import { call, login, logout, type CallInput, type Session } from "./client.ts"
import {
  activeProfile,
  loadConfig,
  locationsFrom,
  maskProfile,
  normalizeBaseUrl,
  profileName,
  saveConfig,
  type ConfigFile,
  type Profile
} from "./config.ts"
import { ConfigError, UsageError } from "./errors.ts"
import { emit } from "./output.ts"
import { ask, confirm } from "./prompt.ts"
import { fillPath, mergeFilters, parsePair } from "./query.ts"
import { installSkill, skillSource } from "./skill.ts"
import { readProfileTokens, tokenIsFresh, writeProfileTokens } from "./tokens.ts"

const version = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")
).version as string

const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.optional, Flag.withDescription(description))

const bool = (name: string, description: string) =>
  Flag.Boolean(name).pipe(Flag.withDefault(false), Flag.withDescription(description))

const repeated = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.atLeast(0), Flag.withDescription(description))

const sharedFlags = {
  profile: optionalString("profile", "Profile name. Defaults to UPIM_PROFILE, then the config's current profile"),
  json: bool("json", "Print compact JSON even on a terminal"),
  meta: bool("meta", "Include HTTP status and headers in the output"),
  baseUrl: optionalString("base-url", "Site root, for example https://pim.example.com. Do not include /api/v1/rest."),
  config: optionalString("config", "Config file path. Tokens are stored next to it unless UPIM_TOKEN_FILE is set")
}

export const root = Command.make("upim").pipe(
  Command.withDescription("UnoPim 3.1 REST API for people and coding agents. Start with `upim endpoints --json`, then `upim describe products create --json`, then the printed example command. Errors are JSON on stderr. The base URL is the site root, not /api/v1/rest."),
  Command.withSharedFlags(sharedFlags)
)

const globals = () => root

const optionValue = (value: Option.Option<string> | undefined) =>
  value !== undefined && Option.isSome(value) ? value.value : undefined

const strings = (value: readonly string[] | undefined) => value ?? []

const readText = (file: string) =>
  Effect.tryPromise({
    try: async () => {
      if (file === "-") {
        const chunks: Buffer[] = []
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
        return Buffer.concat(chunks).toString("utf8")
      }
      return await readFile(file, "utf8")
    },
    catch: (error) => new UsageError({ message: `Could not read ${file}: ${String(error)}` })
  })

const readJsonBody = (data: string | undefined, file: string | undefined, required: boolean) =>
  Effect.gen(function*() {
    if (data !== undefined && file !== undefined) {
      return yield* Effect.fail(new UsageError({ message: "Pass only one of --data or --file" }))
    }
    if (data === undefined && file === undefined) {
      if (!required) return undefined
      return yield* Effect.fail(new UsageError({ message: "Pass JSON with --data or --file" }))
    }
    const text = data ?? (yield* readText(file!))
    return yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (error) => new UsageError({ message: `Invalid JSON body: ${String(error)}` })
    })
  })

type Globals = {
  readonly profile: Option.Option<string>
  readonly json: boolean
  readonly meta: boolean
  readonly baseUrl: Option.Option<string>
  readonly config: Option.Option<string>
}

const requireBaseUrl = (value: string) => Effect.try({
  try: () => normalizeBaseUrl(value),
  catch: (error) => new UsageError({ message: error instanceof Error ? error.message : String(error) })
})

const openSession = (flags: Globals) =>
  Effect.gen(function*() {
    const locations = locationsFrom(optionValue(flags.config))
    const config = yield* loadConfig(locations)
    const name = profileName(config, optionValue(flags.profile))
    const loaded = yield* Effect.try({
      try: () => activeProfile(config, optionValue(flags.profile)),
      catch: (error) => error instanceof ConfigError ? error : new ConfigError({ message: String(error) })
    })
    const override = optionValue(flags.baseUrl)
    const profile: Profile = override === undefined
      ? loaded
      : { ...loaded, baseUrl: yield* requireBaseUrl(override) }
    const tokens = yield* readProfileTokens(locations, name)
    const session: Session = {
      profile,
      profileName: name,
      tokens,
      save: (next) => writeProfileTokens(locations, name, next)
    }
    return { locations, config, name, session }
  })

const present = (result: { readonly status: number; readonly headers: Record<string, string>; readonly body: unknown }, meta: boolean) =>
  meta ? { status: result.status, headers: result.headers, body: result.body } : result.body

const runCall = (input: CallInput) =>
  Effect.gen(function*() {
    const flags = yield* globals()
    const { session } = yield* openSession(flags)
    const result = yield* call(session, input)
    emit(present(result, flags.meta), flags.json)
  })

const listQuery = (flags: Record<string, unknown>) => {
  const query: Record<string, string | undefined> = {}
  const limit = flags.limit as Option.Option<number>
  const page = flags.page as Option.Option<number>
  const pagination = flags.paginationType as Option.Option<string>
  const searchAfter = flags.searchAfter as Option.Option<number>
  const ifNoneMatch = flags.ifNoneMatch as Option.Option<string>
  if (Option.isSome(limit)) query.limit = String(limit.value)
  if (Option.isSome(page)) query.page = String(page.value)
  if (Option.isSome(pagination)) query.pagination_type = pagination.value
  if (Option.isSome(searchAfter)) query.search_after = String(searchAfter.value)
  const filters = mergeFilters(optionValue(flags.filters as Option.Option<string>), strings(flags.filter as string[]))
  if (Object.keys(filters).length > 0) query.filters = JSON.stringify(filters)
  for (const pair of strings(flags.query as string[])) {
    const [key, value] = parsePair(pair, "--query")
    query[key] = value
  }
  return {
    query,
    headers: Option.isSome(ifNoneMatch) ? { "if-none-match": ifNoneMatch.value } : undefined,
    followPages: Boolean(flags.all),
    maxPages: Option.isSome(flags.maxPages as Option.Option<number>) ? (flags.maxPages as Option.Some<number>).value : undefined
  }
}

const actionConfig = (action: Action) => {
  const config: Record<string, unknown> = {}
  for (const name of action.args ?? []) {
    config[name] = Argument.String(name).pipe(Argument.withDescription(`Path parameter {${name}}`))
  }
  if (action.list) {
    config.limit = Flag.Int("limit").pipe(Flag.optional, Flag.withDescription("Page size, clamped to 100 by UnoPim"))
    config.page = Flag.Int("page").pipe(Flag.optional, Flag.withDescription("Page number for page pagination"))
    config.paginationType = Flag.Literals("pagination-type", ["page", "search_after"]).pipe(
      Flag.optional,
      Flag.withDescription("page or search_after cursor pagination")
    )
    config.searchAfter = Flag.Int("search-after").pipe(Flag.optional, Flag.withDescription("Cursor from the previous page"))
    config.filters = optionalString("filters", "Filter JSON object, for example {\"sku\":[{\"operator\":\"IN\",\"value\":[\"a\"]}]}")
    config.filter = repeated("filter", "Repeatable key:operator:value filter, for example sku:IN:a,b")
    config.all = bool("all", "Follow links.next and concatenate data. Fails instead of returning a partial catalog")
    config.maxPages = Flag.Int("max-pages").pipe(
      Flag.optional,
      Flag.withDescription("Safety cap for --all (default 1000). A remaining links.next fails the command")
    )
  }
  if (action.body) {
    config.data = optionalString("data", "JSON request body")
    config.file = optionalString("file", "JSON file, or - to read stdin")
  }
  if (action.upload) {
    config.file = Flag.String("file").pipe(Flag.withDescription("Media file to upload"))
  }
  config.ifNoneMatch = optionalString("if-none-match", "Send If-None-Match and return { notModified: true } on 304")
  if (!action.list) {
    config.query = repeated("query", "Extra query parameter as key=value")
  }
  for (const query of action.query ?? []) {
    config[query.name] = query.kind === "boolean"
      ? bool(query.name, query.description)
      : query.required
        ? Flag.String(query.name).pipe(Flag.withDescription(query.description))
        : optionalString(query.name, query.description)
  }
  return config
}

const runAction = (action: Action, flags: Record<string, any>) =>
  Effect.gen(function*() {
    const params: Record<string, string> = {}
    for (const name of action.args ?? []) params[name] = String(flags[name])
    const path = fillPath(action.path, params)
    const query: Record<string, string | undefined> = {}
    let headers: Record<string, string> | undefined
    let followPages = false
    let maxPages: number | undefined
    if (action.list) {
      const listed = listQuery(flags)
      Object.assign(query, listed.query)
      headers = listed.headers
      followPages = listed.followPages
      maxPages = listed.maxPages
    } else {
      for (const pair of strings(flags.query)) {
        const [key, value] = parsePair(pair, "--query")
        query[key] = value
      }
      if (Option.isSome(flags.ifNoneMatch as Option.Option<string>)) {
        headers = { "if-none-match": (flags.ifNoneMatch as Option.Some<string>).value }
      }
    }
    for (const spec of action.query ?? []) {
      const value = flags[spec.name]
      if (spec.kind === "boolean") {
        if (value === true) query[spec.param] = "true"
      } else if (spec.required) {
        query[spec.param] = String(value)
      } else if (Option.isSome(value as Option.Option<string>)) {
        query[spec.param] = (value as Option.Some<string>).value
      }
    }
    let body: unknown
    let form: Record<string, string | File | undefined> | undefined
    if (action.upload) {
      const filePath = String(flags.file)
      const bytes = yield* Effect.tryPromise({
        try: () => readFile(filePath),
        catch: (error) => new UsageError({ message: `Could not read ${filePath}: ${String(error)}` })
      })
      form = { file: new File([bytes], basename(filePath)) }
      for (const spec of action.query ?? []) {
        const value = spec.kind === "boolean"
          ? undefined
          : spec.required
            ? String(flags[spec.name])
            : optionValue(flags[spec.name])
        if (value !== undefined) form[spec.param] = value
        if (spec.kind !== "boolean") delete query[spec.param]
      }
    } else if (action.body) {
      body = yield* readJsonBody(optionValue(flags.data), optionValue(flags.file), action.body === "required")
    }
    yield* checkFilters(query.filters)
    yield* checkBody(action, body)
    yield* runCall({
      method: action.method,
      path,
      query,
      body,
      form,
      headers,
      followPages,
      maxPages
    })
  })

type CliCommand = Command.Command<string, {}, {}, AppError, HttpClientEnv>

const fieldReference = (command: readonly string[]) => `Field reference: upim describe ${command.join(" ")}`

const buildAction = (command: readonly string[], action: Action): CliCommand =>
  Command.make(action.name, actionConfig(action) as never, (flags) => runAction(action, flags as Record<string, any>)).pipe(
    Command.withDescription(`${action.summary} ${fieldReference(command)}`)
  ) as CliCommand

const buildResource = (resource: Resource, prefix: readonly string[] = []): CliCommand => {
  const command = [...prefix, resource.name]
  const children = [
    ...(resource.actions ?? []).map((action) => buildAction([...command, action.name], action)),
    ...(resource.children ?? []).map((child) => buildResource(child, command))
  ]
  return Command.make(resource.name).pipe(
    Command.withDescription(`${resource.summary} ${fieldReference(command)}`),
    Command.withSubcommands(children)
  ) as CliCommand
}

const requireValue = (value: string | undefined, message: string) =>
  value && value.trim() !== ""
    ? Effect.succeed(value.trim())
    : Effect.fail(new UsageError({ message }))

const promptOr = (current: string | undefined, label: string, secret = false) =>
  current && current.trim() !== ""
    ? Effect.succeed(current.trim())
    : Effect.gen(function*() {
      if (!process.stdin.isTTY) {
        return yield* Effect.fail(new UsageError({ message: `${label} is required in non-interactive mode` }))
      }
      const answer = yield* ask(label, { secret })
      return yield* requireValue(answer, `${label} is required`)
    })

const configCommand = Command.make("config").pipe(
  Command.withDescription("Read and write the XDG configuration file"),
  Command.withSubcommands([
    Command.make("path", {}, () => Effect.gen(function*() {
      const flags = yield* globals()
      const locations = locationsFrom(optionValue(flags.config))
      emit(locations, flags.json)
    })).pipe(Command.withDescription("Print the config and token file paths")),
    Command.make("show", {
      reveal: bool("reveal", "Show the client secret and password")
    }, (flags) => Effect.gen(function*() {
      const parent = yield* globals()
      const locations = locationsFrom(optionValue(parent.config))
      const config = yield* loadConfig(locations)
      const name = profileName(config, optionValue(parent.profile))
      const shown: ConfigFile = flags.reveal
        ? config
        : {
            ...config,
            profiles: Object.fromEntries(Object.entries(config.profiles).map(([key, profile]) => [key, maskProfile(profile)]))
          }
      emit({ ...shown, selected: name, paths: locations }, parent.json)
    })).pipe(Command.withDescription("Print the configuration, masking secrets unless --reveal is set")),
    Command.make("init", {
      nonInteractive: bool("non-interactive", "Fail instead of prompting"),
      clientId: optionalString("client-id", "OAuth client id"),
      clientSecret: optionalString("client-secret", "OAuth client secret"),
      username: optionalString("username", "Integration robot username"),
      password: optionalString("password", "Integration robot password"),
      savePassword: bool("save-password", "Store the password in the config file"),
      name: optionalString("name", "Profile name to create")
    }, (flags) => Effect.gen(function*() {
      const parent = yield* globals()
      const locations = locationsFrom(optionValue(parent.config))
      const config = yield* loadConfig(locations)
      const name = optionValue(flags.name) || optionValue(parent.profile) || config.current || "default"
      const interactive = !flags.nonInteractive && process.stdin.isTTY
      const take = (value: string | undefined, label: string, secret = false) =>
        value && value !== ""
          ? Effect.succeed(value)
          : interactive
            ? promptOr(undefined, label, secret)
            : Effect.fail(new UsageError({ message: `${label} is required with --non-interactive` }))
      const baseUrlInput = yield* take(optionValue(parent.baseUrl) ?? process.env.UPIM_BASE_URL, "Base URL (site root, not /api/v1/rest)")
      const baseUrl = yield* requireBaseUrl(baseUrlInput)
      const clientId = yield* take(optionValue(flags.clientId) ?? process.env.UPIM_CLIENT_ID, "Client ID")
      const clientSecret = yield* take(optionValue(flags.clientSecret) ?? process.env.UPIM_CLIENT_SECRET, "Client secret", true)
      const username = yield* take(optionValue(flags.username) ?? process.env.UPIM_USERNAME, "Username")
      const passwordInput = optionValue(flags.password) ?? process.env.UPIM_PASSWORD
      const password = passwordInput !== undefined && passwordInput !== ""
        ? passwordInput
        : interactive
          ? yield* ask("Password", { secret: true })
          : undefined
      const savePassword = flags.savePassword || (interactive && password !== undefined && (yield* confirm("Save password in the config file?")))
      const profile: Profile = {
        baseUrl,
        clientId,
        clientSecret,
        username,
        ...(savePassword && password ? { password } : {})
      }
      const next: ConfigFile = {
        current: name,
        profiles: { ...config.profiles, [name]: profile }
      }
      yield* saveConfig(locations, next)
      emit({ saved: locations.configPath, profile: name, passwordSaved: Boolean(profile.password) }, parent.json)
    })).pipe(Command.withDescription("Create or replace a profile, interactively or with flags")),
    Command.make("set", {
      key: Argument.String("key").pipe(Argument.withDescription("baseUrl, clientId, clientSecret, username, or password")),
      value: Argument.String("value").pipe(Argument.withDescription("New value"))
    }, (flags) => Effect.gen(function*() {
      const parent = yield* globals()
      const locations = locationsFrom(optionValue(parent.config))
      const config = yield* loadConfig(locations)
      const name = profileName(config, optionValue(parent.profile))
      const current = config.profiles[name] ?? {
        baseUrl: "",
        clientId: "",
        clientSecret: ""
      }
      const key = flags.key
      if (!["baseUrl", "clientId", "clientSecret", "username", "password"].includes(key)) {
        return yield* Effect.fail(new UsageError({ message: `Unknown config key ${key}` }))
      }
      const value = key === "baseUrl" ? yield* requireBaseUrl(flags.value) : flags.value
      const next: ConfigFile = {
        ...config,
        current: config.current ?? name,
        profiles: { ...config.profiles, [name]: { ...current, [key]: value } }
      }
      yield* saveConfig(locations, next)
      emit({ profile: name, key, path: locations.configPath }, parent.json)
    })).pipe(Command.withDescription("Set one field on the selected profile")),
    Command.make("use", {
      name: Argument.String("name").pipe(Argument.withDescription("Profile to select"))
    }, (flags) => Effect.gen(function*() {
      const parent = yield* globals()
      const locations = locationsFrom(optionValue(parent.config))
      const config = yield* loadConfig(locations)
      if (config.profiles[flags.name] === undefined) {
        return yield* Effect.fail(new ConfigError({ message: `Profile "${flags.name}" does not exist` }))
      }
      yield* saveConfig(locations, { ...config, current: flags.name })
      emit({ current: flags.name }, parent.json)
    })).pipe(Command.withDescription("Select the current profile")),
    Command.make("example", {}, () => Effect.gen(function*() {
      const flags = yield* globals()
      emit({
        current: "default",
        profiles: {
          default: {
            baseUrl: "https://pim.example.com",
            clientId: "client-id",
            clientSecret: "client-secret",
            username: "api-robot",
            password: "optional-robot-password"
          }
        }
      }, flags.json)
    })).pipe(Command.withDescription("Print an example configuration document"))
  ])
)

const authCommand = Command.make("auth").pipe(
  Command.withDescription("OAuth password grant and refresh tokens"),
  Command.withSubcommands([
    Command.make("login", {
      username: optionalString("username", "Robot username"),
      password: optionalString("password", "Robot password"),
      savePassword: bool("save-password", "Store the password for later password grants")
    }, (flags) => Effect.gen(function*() {
      const parent = yield* globals()
      const opened = yield* openSession(parent)
      const username = yield* promptOr(optionValue(flags.username) ?? opened.session.profile.username, "Username")
      const password = yield* promptOr(optionValue(flags.password) ?? opened.session.profile.password, "Password", true)
      const savePassword = flags.savePassword || (process.stdin.isTTY && (yield* confirm("Save password in the config file?")))
      if (savePassword || username !== opened.session.profile.username) {
        const next: ConfigFile = {
          ...opened.config,
          current: opened.name,
          profiles: {
            ...opened.config.profiles,
            [opened.name]: {
              ...opened.session.profile,
              username,
              ...(savePassword ? { password } : { password: opened.config.profiles[opened.name]?.password })
            }
          }
        }
        const savedProfile = savePassword
          ? next.profiles[opened.name]!
          : (({ password: _password, ...rest }) => rest)(next.profiles[opened.name]!)
        yield* saveConfig(opened.locations, {
          ...next,
          profiles: { ...next.profiles, [opened.name]: savedProfile }
        })
      }
      opened.session.profile = { ...opened.session.profile, username, password }
      const tokens = yield* login(opened.session)
      emit({
        profile: opened.name,
        tokenType: tokens.tokenType,
        expiresAt: new Date(tokens.expiresAt).toISOString(),
        refreshTokenStored: tokens.refreshToken !== ""
      }, parent.json)
    })).pipe(Command.withDescription("Exchange the robot username and password for tokens")),
    Command.make("refresh", {}, () => Effect.gen(function*() {
      const parent = yield* globals()
      const { session, name } = yield* openSession(parent)
      if (!session.tokens?.refreshToken && !(session.profile.username && session.profile.password)) {
        return yield* Effect.fail(new UsageError({ message: "No refresh token or password is available" }))
      }
      const tokens = yield* login(session)
      emit({
        profile: name,
        expiresAt: new Date(tokens.expiresAt).toISOString(),
        fresh: tokenIsFresh(tokens)
      }, parent.json)
    })).pipe(Command.withDescription("Refresh the access token, or fall back to the password grant")),
    Command.make("status", {
      reveal: bool("reveal", "Print the access token")
    }, (flags) => Effect.gen(function*() {
      const parent = yield* globals()
      const { session, name, locations } = yield* openSession(parent)
      const tokens = session.tokens
      emit({
        profile: name,
        baseUrl: session.profile.baseUrl,
        username: session.profile.username ?? null,
        tokenPath: locations.tokenPath,
        authenticated: Boolean(tokens),
        fresh: tokens ? tokenIsFresh(tokens) : false,
        expiresAt: tokens ? new Date(tokens.expiresAt).toISOString() : null,
        ...(flags.reveal && tokens ? { accessToken: tokens.accessToken } : {})
      }, parent.json)
    })).pipe(Command.withDescription("Show whether the saved token is still fresh")),
    Command.make("logout", {}, () => Effect.gen(function*() {
      const parent = yield* globals()
      const { session, name } = yield* openSession(parent)
      yield* logout(session)
      emit({ profile: name, loggedOut: true }, parent.json)
    })).pipe(Command.withDescription("Delete saved tokens for the selected profile"))
  ])
)

const apiCommand = Command.make("api", {
  method: Argument.String("method").pipe(Argument.withDescription("HTTP method")),
  path: Argument.String("path").pipe(Argument.withDescription("Path beginning with / or an absolute URL")),
  data: optionalString("data", "JSON request body"),
  file: optionalString("file", "JSON file, or - for stdin"),
  form: repeated("form", "Form field key=value. Repeatable"),
  formFile: repeated("form-file", "Form file key=path. Repeatable"),
  query: repeated("query", "Query parameter key=value. Repeatable"),
  header: repeated("header", "Header key=value. Repeatable"),
  all: bool("all", "Follow links.next when the response is a collection. Fails instead of returning a partial catalog"),
  maxPages: Flag.Int("max-pages").pipe(
    Flag.optional,
    Flag.withDescription("Safety cap for --all (default 1000). A remaining links.next fails the command")
  )
}, (flags) => Effect.gen(function*() {
  const method = flags.method.toUpperCase()
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) {
    return yield* Effect.fail(new UsageError({ message: `Unsupported method ${flags.method}` }))
  }
  const query: Record<string, string> = {}
  for (const pair of flags.query) {
    const [key, value] = parsePair(pair, "--query")
    query[key] = value
  }
  const headers: Record<string, string> = {}
  for (const pair of flags.header) {
    const [key, value] = parsePair(pair, "--header")
    headers[key] = value
  }
  const body = yield* readJsonBody(optionValue(flags.data), optionValue(flags.file), false)
  const form: Record<string, string | File> = {}
  for (const pair of flags.form) {
    const [key, value] = parsePair(pair, "--form")
    form[key] = value
  }
  for (const pair of flags.formFile) {
    const [key, filePath] = parsePair(pair, "--form-file")
    const bytes = yield* Effect.tryPromise({
      try: () => readFile(filePath),
      catch: (error) => new UsageError({ message: `Could not read ${filePath}: ${String(error)}` })
    })
    form[key] = new File([bytes], basename(filePath))
  }
  yield* runCall({
    method,
    path: flags.path,
    query,
    headers,
    body,
    form: flags.form.length + flags.formFile.length > 0 ? form : undefined,
    followPages: flags.all,
    maxPages: Option.isSome(flags.maxPages) ? flags.maxPages.value : undefined
  })
})).pipe(Command.withDescription("Call any UnoPim path. Authentication and refresh still apply"))

const endpointsCommand = Command.make("endpoints", {}, () => Effect.gen(function*() {
  const flags = yield* globals()
  const commands = flatten().map((entry: FlatAction) => ({
    command: ["upim", ...entry.command].join(" "),
    method: entry.action.method,
    path: entry.action.path,
    summary: entry.action.summary,
    describe: `upim describe ${entry.command.join(" ")} --json`
  }))
  emit({
    api: "UnoPim 3.1",
    docs: "https://devdocs.unopim.com/3.1/api/",
    errors: "stderr",
    start: [
      "upim endpoints --json",
      "upim describe products create --json",
      "upim products create --data '<json>'"
    ],
    commands
  }, flags.json)
})).pipe(Command.withDescription("List every built-in UnoPim 3.1 action"))

const hasValueEnvelope = (document: OperationDocument) => {
  const properties = document.body?.schema.properties
  return typeof properties === "object" && properties !== null && "values" in properties
}

const describeCommand = Command.make("describe", {
  target: Argument.String("target").pipe(
    Argument.variadic,
    Argument.withDescription("Resource and optional action, for example products create")
  ),
  live: bool("live", "Merge this server's attribute dictionary into a product value schema"),
  family: optionalString("family", "With --live, keep only attributes assigned to this family")
}, (flags) => Effect.gen(function*() {
  const parent = yield* globals()
  let document = yield* describe(flags.target.map((part) => String(part)))
  if (flags.live) {
    if (document.kind !== "operation" || !hasValueEnvelope(document)) {
      return yield* new UsageError({ message: "--live applies to product create, update, and patch. Example: upim describe products create --live --family default" })
    }
    const { session } = yield* openSession(parent)
    const attributes = yield* call(session, { method: "GET", path: "/api/v1/rest/attributes", query: { limit: "100" }, followPages: true })
    const family = optionValue(flags.family)
    const familyBody = family === undefined
      ? undefined
      : yield* call(session, { method: "GET", path: `/api/v1/rest/families/${encodeURIComponent(family)}` })
    document = applyLiveDictionary(document, {
      attributes: attributesFromBody(attributes.body),
      ...(family ? { family, familyAttributes: familyAttributeCodes(familyBody?.body) } : {})
    })
  }
  if (parent.json) emit(document, true)
  else process.stdout.write(renderText(document))
})).pipe(Command.withDescription("Show fields, validation, and a copy-paste example. Add --json for the machine-readable schema."))

const skillCommand = Command.make("skill").pipe(
  Command.withDescription("Install the upim agent skill where project agents can discover it"),
  Command.withSubcommands([
    Command.make("path", {}, () => Effect.gen(function*() {
      const parent = yield* globals()
      emit({ source: skillSource() }, parent.json)
    })).pipe(Command.withDescription("Print the bundled skill directory")),
    Command.make("install", {
      user: bool("user", "Install into ~/.agents/skills instead of the current project"),
      path: optionalString("path", "Exact skill directory. Relative paths start at the current directory, or at --dir. A leading ~ is your home directory."),
      dir: optionalString("dir", "Directory used as the start for a relative --path, and as the project root otherwise")
    }, (flags) => Effect.gen(function*() {
      const parent = yield* globals()
      const installed = yield* installSkill({ user: flags.user, path: optionValue(flags.path), dir: optionValue(flags.dir) })
      emit(installed, parent.json)
    })).pipe(Command.withDescription("Copy the skill into .agents/skills/upim, or into --path"))
  ])
)

const schemaCommand = Command.make("schema", {}, () => Effect.gen(function*() {
  const parent = yield* globals()
  emit(openApiDocument(), parent.json)
})).pipe(Command.withDescription("Print the OpenAPI 3.1 contract generated from the Effect schemas"))

const app = root.pipe(Command.withSubcommands([
  configCommand,
  authCommand,
  apiCommand,
  endpointsCommand,
  describeCommand,
  schemaCommand,
  skillCommand,
  ...resources.map((resource) => buildResource(resource))
]))

export const run = Command.run(app, { version })
