import { Clock, Effect, FileSystem, Option, Path, Schema, Stdio, Stream } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import type { AppError } from "./errors.ts"
import type { HttpClientEnv, StorageEnv } from "./client.ts"
import { flatten, resources, type Action, type ExtensionTag, type FlatAction, type Resource } from "./catalog.ts"
import { describe, openApiDocument, renderText, type OperationDocument } from "./contract/document.ts"
import { applyLiveDictionary, attributesFromBody, familyAttributeCodes } from "./contract/live.ts"
import { checkBody, checkFilters } from "./contract/validate.ts"
import { call, login, logout, type CallInput, type Session } from "./client.ts"
import {
  activeProfile,
  applyEnv,
  enabledExtensions,
  loadConfig,
  locationsFrom,
  maskProfile,
  normalizeBaseUrl,
  profileName,
  saveConfig,
  type ConfigFile,
  type Profile
} from "./config.ts"
import { ProfileEnv, readEnv } from "./env.ts"
import { ConfigError, UsageError } from "./errors.ts"
import {
  enableHint,
  flattenExtension,
  loadExtensions,
  selectEnabled,
  tagFor,
  type Extension,
  type InstalledExtension
} from "./extensions.ts"
import { emit } from "./output.ts"
import { ask, confirm } from "./prompt.ts"
import { fillPath, mergeFilters, parsePair } from "./query.ts"
import { installSkill, skillSource } from "./skill.ts"
import { makeTokenStore, tokenIsFresh } from "./tokens.ts"

/** The version in package.json, one directory above dist/ or src/. */
const packageVersion = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url))
  const text = yield* fs.readFileString(path.join(root, "package.json"))
  const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))(text)
  return manifest.version
}).pipe(Effect.orDie)

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

/** A text file, or all of stdin when the name is `-`. */
const readText = (file: string) =>
  Effect.gen(function*() {
    if (file === "-") {
      const stdio = yield* Stdio.Stdio
      return yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)
    }
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(file)
  }).pipe(Effect.mapError((error) => new UsageError({ message: `Could not read ${file}: ${error.message}`, cause: error })))

/** A file's bytes as a multipart File part named after the file. */
const fileFrom = (filePath: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const bytes = yield* fs.readFile(filePath)
    return new File([new Uint8Array(bytes)], path.basename(filePath))
  }).pipe(Effect.mapError((error) => new UsageError({ message: `Could not read ${filePath}: ${error.message}`, cause: error })))

const readJsonBody = (data: string | undefined, file: string | undefined, required: boolean) =>
  Effect.gen(function*() {
    if (data !== undefined && file !== undefined) {
      return yield* new UsageError({ message: "Pass only one of --data or --file" })
    }
    if (data === undefined && file === undefined) {
      if (!required) return undefined
      return yield* new UsageError({ message: "Pass JSON with --data or --file" })
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
    const locations = yield* locationsFrom(optionValue(flags.config))
    const config = yield* loadConfig(locations)
    const name = yield* profileName(config, optionValue(flags.profile))
    const loaded = yield* activeProfile(config, optionValue(flags.profile))
    const override = optionValue(flags.baseUrl)
    const profile: Profile = override === undefined
      ? loaded
      : { ...loaded, baseUrl: yield* requireBaseUrl(override) }
    const store = makeTokenStore(locations, name)
    const session: Session = {
      profile,
      profileName: name,
      tokens: yield* store.read,
      store
    }
    return { locations, config, name, session }
  })

const present = (result: { readonly status: number; readonly headers: Record<string, string>; readonly body: unknown }, meta: boolean) =>
  meta ? { status: result.status, headers: result.headers, body: result.body } : result.body

const requireEnabled = (profile: Profile, name: string, extension: ExtensionTag) =>
  enabledExtensions(profile).includes(extension.name)
    ? Effect.void
    : Effect.fail(new ConfigError({
      message: `Extension "${extension.name}" is installed but not enabled for profile "${name}". ${enableHint(extension.name)}`
    }))

const runCall = (input: CallInput, extension?: ExtensionTag) =>
  Effect.gen(function*() {
    const flags = yield* globals()
    const { session, name } = yield* openSession(flags)
    if (extension !== undefined) yield* requireEnabled(session.profile, name, extension)
    const result = yield* call(session, input)
    emit(present(result, flags.meta), flags.json)
  })

/**
 * The extensions the selected profile enables, without requiring tokens. A
 * missing profile means core only, so `upim endpoints` works before setup.
 */
const enabledFor = (flags: Globals, installed: readonly InstalledExtension[]) =>
  Effect.gen(function*() {
    const locations = yield* locationsFrom(optionValue(flags.config))
    const config = yield* loadConfig(locations)
    const name = yield* profileName(config, optionValue(flags.profile))
    const stored = config.profiles[name]
    const names = stored ? enabledExtensions(yield* applyEnv(stored)) : []
    return { name, names, ...selectEnabled(installed, names) }
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

const runAction = (action: Action, flags: Record<string, any>, extension?: ExtensionTag) =>
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
      form = { [action.fileField ?? "file"]: yield* fileFrom(String(flags.file)) }
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
    }, extension)
  })

type CliCommand = Command.Command<string, {}, {}, AppError, HttpClientEnv | StorageEnv>

const fieldReference = (command: readonly string[]) => `Field reference: upim describe ${command.join(" ")}`

const buildAction = (command: readonly string[], action: Action, extension?: ExtensionTag): CliCommand =>
  Command.make(action.name, actionConfig(action) as never, (flags) => runAction(action, flags as Record<string, any>, extension)).pipe(
    Command.withDescription(`${action.summary} ${fieldReference(command)}`)
  ) as CliCommand

const buildResource = (resource: Resource, prefix: readonly string[] = [], extension?: ExtensionTag): CliCommand => {
  const command = [...prefix, resource.name]
  const children = [
    ...(resource.actions ?? []).map((action) => buildAction([...command, action.name], action, extension)),
    ...(resource.children ?? []).map((child) => buildResource(child, command, extension))
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
        return yield* new UsageError({ message: `${label} is required in non-interactive mode` })
      }
      const answer = yield* ask(label, { secret })
      return yield* requireValue(answer, `${label} is required`)
    })

const configCommand = Command.make("config").pipe(
  Command.withDescription("Read and write the XDG configuration file"),
  Command.withSubcommands([
    Command.make("path", {}, () => Effect.gen(function*() {
      const flags = yield* globals()
      const locations = yield* locationsFrom(optionValue(flags.config))
      emit(locations, flags.json)
    })).pipe(Command.withDescription("Print the config and token file paths")),
    Command.make("show", {
      reveal: bool("reveal", "Show the client secret and password")
    }, (flags) => Effect.gen(function*() {
      const parent = yield* globals()
      const locations = yield* locationsFrom(optionValue(parent.config))
      const config = yield* loadConfig(locations)
      const name = yield* profileName(config, optionValue(parent.profile))
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
      const locations = yield* locationsFrom(optionValue(parent.config))
      const config = yield* loadConfig(locations)
      const env = yield* readEnv(ProfileEnv)
      const name = optionValue(flags.name) || optionValue(parent.profile) || config.current || "default"
      const interactive = !flags.nonInteractive && process.stdin.isTTY
      const take = (value: string | undefined, label: string, secret = false) =>
        value && value !== ""
          ? Effect.succeed(value)
          : interactive
            ? promptOr(undefined, label, secret)
            : Effect.fail(new UsageError({ message: `${label} is required with --non-interactive` }))
      const baseUrlInput = yield* take(optionValue(parent.baseUrl) ?? Option.getOrUndefined(env.baseUrl), "Base URL (site root, not /api/v1/rest)")
      const baseUrl = yield* requireBaseUrl(baseUrlInput)
      const clientId = yield* take(optionValue(flags.clientId) ?? Option.getOrUndefined(env.clientId), "Client ID")
      const clientSecret = yield* take(optionValue(flags.clientSecret) ?? Option.getOrUndefined(env.clientSecret), "Client secret", true)
      const username = yield* take(optionValue(flags.username) ?? Option.getOrUndefined(env.username), "Username")
      const passwordInput = optionValue(flags.password) ?? Option.getOrUndefined(env.password)
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
      const locations = yield* locationsFrom(optionValue(parent.config))
      const config = yield* loadConfig(locations)
      const name = yield* profileName(config, optionValue(parent.profile))
      const current = config.profiles[name] ?? {
        baseUrl: "",
        clientId: "",
        clientSecret: ""
      }
      const key = flags.key
      if (!["baseUrl", "clientId", "clientSecret", "username", "password"].includes(key)) {
        return yield* new UsageError({ message: `Unknown config key ${key}` })
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
      const locations = yield* locationsFrom(optionValue(parent.config))
      const config = yield* loadConfig(locations)
      if (config.profiles[flags.name] === undefined) {
        return yield* new ConfigError({ message: `Profile "${flags.name}" does not exist` })
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
            password: "optional-robot-password",
            extensions: []
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
        return yield* new UsageError({ message: "No refresh token or password is available" })
      }
      const tokens = yield* login(session)
      const now = yield* Clock.currentTimeMillis
      emit({
        profile: name,
        expiresAt: new Date(tokens.expiresAt).toISOString(),
        fresh: tokenIsFresh(tokens, now)
      }, parent.json)
    })).pipe(Command.withDescription("Refresh the access token, or fall back to the password grant")),
    Command.make("status", {
      reveal: bool("reveal", "Print the access token")
    }, (flags) => Effect.gen(function*() {
      const parent = yield* globals()
      const { session, name, locations } = yield* openSession(parent)
      const tokens = session.tokens
      const now = yield* Clock.currentTimeMillis
      emit({
        profile: name,
        baseUrl: session.profile.baseUrl,
        username: session.profile.username ?? null,
        tokenPath: locations.tokenPath,
        authenticated: Boolean(tokens),
        fresh: tokens ? tokenIsFresh(tokens, now) : false,
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
    return yield* new UsageError({ message: `Unsupported method ${flags.method}` })
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
    form[key] = yield* fileFrom(filePath)
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

const endpointRow = (entry: FlatAction) => ({
  command: ["upim", ...entry.command].join(" "),
  method: entry.action.method,
  path: entry.action.path,
  summary: entry.action.summary,
  describe: `upim describe ${entry.command.join(" ")} --json`,
  ...(entry.extension ? { extension: entry.extension.name } : {})
})

const endpointsCommand = (installed: readonly InstalledExtension[]) =>
  Command.make("endpoints", {}, () => Effect.gen(function*() {
    const flags = yield* globals()
    const enabled = yield* enabledFor(flags, installed)
    emit({
      api: "UnoPim 3.1",
      docs: "https://devdocs.unopim.com/3.1/api/",
      errors: "stderr",
      start: [
        "upim endpoints --json",
        "upim describe products create --json",
        "upim products create --data '<json>'"
      ],
      extensions: {
        profile: enabled.name,
        enabled: enabled.extensions.map((extension) => extension.name),
        installed: installed.map((entry) => entry.extension.name),
        ...(enabled.unknown.length > 0
          ? { unknown: enabled.unknown, hint: "These names are enabled but no extension with that name is installed. Add .upim/extensions/<name>.json or run `upim extensions disable <name>`." }
          : {})
      },
      commands: [
        ...flatten().map(endpointRow),
        ...enabled.extensions.flatMap(flattenExtension).map(endpointRow)
      ]
    }, flags.json)
  })).pipe(Command.withDescription("List every UnoPim 3.1 action plus the extension actions the selected profile enables. Extension rows carry an `extension` field."))

const hasValueEnvelope = (document: OperationDocument) => {
  const properties = document.body?.schema.properties
  return typeof properties === "object" && properties !== null && "values" in properties
}

const describeCommand = (installed: readonly InstalledExtension[]) => Command.make("describe", {
  target: Argument.String("target").pipe(
    Argument.variadic,
    Argument.withDescription("Resource and optional action, for example products create, or ext dam assets list")
  ),
  live: bool("live", "Merge this server's attribute dictionary into a product value schema"),
  family: optionalString("family", "With --live, keep only attributes assigned to this family")
}, (flags) => Effect.gen(function*() {
  const parent = yield* globals()
  const enabled = yield* enabledFor(parent, installed)
  let document = yield* describe(flags.target.map((part) => String(part)), enabled.extensions)
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
      emit({ source: yield* skillSource }, parent.json)
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

const extCommand = (installed: readonly InstalledExtension[]) =>
  Command.make("ext", {}, () => Effect.gen(function*() {
    const flags = yield* globals()
    const enabled = yield* enabledFor(flags, installed)
    emit({
      profile: enabled.name,
      usage: "upim ext <extension> <resource> <action>",
      enabled: enabled.extensions.map((extension) => extension.name),
      installed: installed.map((entry) => entry.extension.name),
      hint: "upim extensions list shows every installed extension. upim endpoints --json lists the enabled actions."
    }, flags.json)
  })).pipe(
    Command.withDescription("Extension catalogs: upim ext <extension> <resource> <action>. Only extensions the selected profile enables may be called."),
    Command.withSubcommands(installed.map(({ extension }) =>
      Command.make(extension.name).pipe(
        Command.withDescription(`${extension.summary} Enable with: upim extensions enable ${extension.name}`),
        Command.withSubcommands(extension.resources.map((resource) => buildResource(resource, ["ext", extension.name], tagFor(extension))))
      ) as CliCommand
    ))
  )

const probeOutcome = (status: number) => {
  if (status >= 200 && status < 300) return "present"
  if (status === 404) return "absent"
  if (status === 401) return "auth"
  if (status === 403) return "forbidden"
  return `http-${status}`
}

const probeHints: Readonly<Record<string, string>> = {
  present: "The host answered the probe. Enable the extension if it is not enabled yet.",
  absent: "The host does not serve this route. The package is probably not installed.",
  auth: "Authentication failed even after a refresh. Check the profile credentials.",
  forbidden: "Authenticated, but the integration may lack the scope for this package.",
  unreachable: "The host could not be reached."
}

const probeExtension = (session: Session, extension: Extension) =>
  Effect.gen(function*() {
    if (extension.probe === undefined) {
      return { extension: extension.name, probe: null, status: null, result: "no-probe", hint: "This extension defines no probe request." }
    }
    const probe = `${extension.probe.method} ${extension.probe.path}`
    const status = yield* call(session, { method: extension.probe.method, path: extension.probe.path, query: { limit: "1" } }).pipe(
      Effect.map((result) => result.status),
      Effect.catchTags({
        ApiError: (error) => Effect.succeed(error.status),
        TransportError: () => Effect.succeed(0)
      })
    )
    const result = status === 0 ? "unreachable" : probeOutcome(status)
    return { extension: extension.name, probe, status: status === 0 ? null : status, result, hint: probeHints[result] ?? "Unexpected status. Inspect the host." }
  })

const requireInstalled = (installed: readonly InstalledExtension[], name: string) =>
  installed.some((entry) => entry.extension.name === name)
    ? Effect.void
    : Effect.fail(new ConfigError({
      message: `No extension named "${name}" is installed. Installed: ${installed.map((entry) => entry.extension.name).join(", ")}. Custom fragments load from .upim/extensions/*.json in the project and from the user config directory.`
    }))

const setExtensions = (flags: Globals, installed: readonly InstalledExtension[], name: string, change: (current: readonly string[]) => readonly string[]) =>
  Effect.gen(function*() {
    yield* requireInstalled(installed, name)
    const locations = yield* locationsFrom(optionValue(flags.config))
    const config = yield* loadConfig(locations)
    const profile = yield* profileName(config, optionValue(flags.profile))
    const stored = config.profiles[profile]
    if (stored === undefined) {
      return yield* new ConfigError({ message: `Profile "${profile}" is not configured. Run \`upim config init\` first.` })
    }
    // The stored list, not the UPIM_EXTENSIONS override, is what gets written back.
    const extensions = change(stored.extensions ?? [])
    yield* saveConfig(locations, {
      ...config,
      current: config.current ?? profile,
      profiles: { ...config.profiles, [profile]: { ...stored, extensions } }
    })
    emit({ profile, extensions, path: locations.configPath }, flags.json)
  })

const extensionsCommand = (installed: readonly InstalledExtension[]) =>
  Command.make("extensions").pipe(
    Command.withDescription("List, enable, disable, and probe extension catalogs for the selected profile"),
    Command.withSubcommands([
      Command.make("list", {}, () => Effect.gen(function*() {
        const flags = yield* globals()
        const enabled = yield* enabledFor(flags, installed)
        emit({
          profile: enabled.name,
          enabled: enabled.names,
          ...(enabled.unknown.length > 0 ? { unknown: enabled.unknown } : {}),
          extensions: installed.map(({ extension, source }) => ({
            name: extension.name,
            summary: extension.summary,
            source,
            enabled: enabled.names.includes(extension.name),
            resources: extension.resources.map((resource) => resource.name),
            actions: flattenExtension(extension).length,
            probe: extension.probe ? `${extension.probe.method} ${extension.probe.path}` : null,
            docs: extension.docs ?? null
          }))
        }, flags.json)
      })).pipe(Command.withDescription("Show installed extensions and whether the selected profile enables them")),
      Command.make("enable", {
        name: Argument.String("name").pipe(Argument.withDescription("Extension name, for example dam"))
      }, (flags) => Effect.gen(function*() {
        const parent = yield* globals()
        yield* setExtensions(parent, installed, flags.name, (current) => current.includes(flags.name) ? current : [...current, flags.name])
      })).pipe(Command.withDescription("Add an extension to the selected profile and save the config")),
      Command.make("disable", {
        name: Argument.String("name").pipe(Argument.withDescription("Extension name"))
      }, (flags) => Effect.gen(function*() {
        const parent = yield* globals()
        yield* setExtensions(parent, installed, flags.name, (current) => current.filter((entry) => entry !== flags.name))
      })).pipe(Command.withDescription("Remove an extension from the selected profile and save the config")),
      Command.make("probe", {
        name: Argument.String("name").pipe(Argument.optional, Argument.withDescription("Extension to probe. Defaults to every installed extension"))
      }, (flags) => Effect.gen(function*() {
        const parent = yield* globals()
        const target = optionValue(flags.name)
        if (target !== undefined) yield* requireInstalled(installed, target)
        const { session, name } = yield* openSession(parent)
        const chosen = installed.filter((entry) => target === undefined || entry.extension.name === target)
        const results = yield* Effect.forEach(chosen, (entry) => probeExtension(session, entry.extension))
        emit({
          profile: name,
          baseUrl: session.profile.baseUrl,
          note: "A probe reports whether the host serves the extension's sentinel route. It does not enable anything and is not a version check.",
          results: results.map((result) => ({ ...result, enabled: enabledExtensions(session.profile).includes(result.extension) }))
        }, parent.json)
      })).pipe(Command.withDescription("Ask the host whether each extension's package is installed (GET only)"))
    ])
  )

const buildApp = (installed: readonly InstalledExtension[]) =>
  root.pipe(Command.withSubcommands([
    configCommand,
    authCommand,
    apiCommand,
    endpointsCommand(installed),
    describeCommand(installed),
    schemaCommand,
    skillCommand,
    extCommand(installed),
    extensionsCommand(installed),
    ...resources.map((resource) => buildResource(resource))
  ]))

/** The --config flag has to be known before the command tree exists, because custom fragments live next to the config. */
const configFlagFromArgs = (args: readonly string[]) => {
  const index = args.indexOf("--config")
  if (index >= 0) return args[index + 1]
  return args.find((arg) => arg.startsWith("--config="))?.slice("--config=".length)
}

export const run = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  const locations = yield* locationsFrom(configFlagFromArgs(args))
  const installed = yield* loadExtensions(process.cwd(), locations)
  const version = yield* packageVersion
  return yield* Command.run(buildApp(installed), { version })
})
