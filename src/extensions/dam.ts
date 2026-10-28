/**
 * UnoPim DAM 3.x (unopim-digital-asset-management) REST surface.
 * Sources: src/Routes/V1/asset-routes.php in that package and the Postman docs.
 *
 * Left out on purpose:
 * - GET /assets/download/{id} returns bytes. upim prints JSON, so it needs a
 *   binary --output flag first.
 * - GET /assets/signUrlDownload/{id} uses Laravel signed URLs, not OAuth.
 */
import type { Action, Resource } from "../catalog.ts"
import type { Extension } from "../extensions.ts"

const rest = "/api/v1/rest"

const byId = (summary: string, method: Action["method"], path: string, body?: Action["body"]): Action => ({
  name: "",
  summary,
  method,
  path,
  args: ["id"],
  ...(body ? { body } : {})
})

const named = (name: string, action: Action): Action => ({ ...action, name })

const assets: Resource = {
  name: "assets",
  summary: "Digital assets (files) and their metadata",
  actions: [
    { name: "list", summary: "List assets", method: "GET", path: `${rest}/assets`, list: true },
    named("get", byId("Get one asset", "GET", `${rest}/assets/{id}`)),
    {
      name: "upload",
      summary: "Upload a file into a directory (multipart files[] plus directory_id)",
      method: "POST",
      path: `${rest}/assets`,
      upload: true,
      fileField: "files[]",
      query: [{ kind: "string", name: "directory-id", param: "directory_id", description: "Directory id to upload into", required: true }]
    },
    {
      name: "reupload",
      summary: "Replace the file behind an existing asset (multipart file plus asset_id)",
      method: "POST",
      path: `${rest}/assets/reupload`,
      upload: true,
      query: [{ kind: "string", name: "asset-id", param: "asset_id", description: "Asset id to replace", required: true }]
    },
    named("update", byId("Update asset fields such as file_name", "PUT", `${rest}/assets/{id}`, "required")),
    named("edit", byId("Edit an asset through the edit route", "PUT", `${rest}/assets/edit/{id}`, "required")),
    named("metadata", byId("Embedded metadata (EXIF, IPTC) extracted at upload", "GET", `${rest}/assets/{id}/metadata`)),
    named("delete", byId("Delete an asset", "DELETE", `${rest}/assets/{id}`))
  ]
}

const directories: Resource = {
  name: "directories",
  summary: "Asset directories (folders)",
  actions: [
    { name: "list", summary: "List directories", method: "GET", path: `${rest}/directories`, list: true },
    named("get", byId("Get one directory", "GET", `${rest}/directories/{id}`)),
    { name: "create", summary: "Create a directory (name, parent_id)", method: "POST", path: `${rest}/directories`, body: "required" },
    named("update", byId("Update a directory (name, parent_id)", "PUT", `${rest}/directories/{id}`, "required")),
    named("delete", byId("Delete a directory", "DELETE", `${rest}/directories/{id}`))
  ]
}

const comments: Resource = {
  name: "comments",
  summary: "Comments on assets",
  actions: [
    named("get", byId("Get a comment", "GET", `${rest}/comments/{id}`)),
    { name: "create", summary: "Create a comment (comments, dam_asset_id)", method: "POST", path: `${rest}/comments`, body: "required" },
    named("update", byId("Update a comment", "PUT", `${rest}/comments/{id}`, "required")),
    named("delete", byId("Delete a comment", "DELETE", `${rest}/comments/{id}`))
  ]
}

const tags: Resource = {
  name: "tags",
  summary: "Tag vocabulary and asset tagging",
  actions: [
    {
      name: "list",
      summary: "List every tag in the vocabulary",
      method: "GET",
      path: `${rest}/tags`,
      query: [
        { kind: "string", name: "search", param: "query", description: "Search tags by name" },
        { kind: "string", name: "per-page", param: "per_page", description: "Page size, 1 to 100" }
      ]
    },
    named("get", byId("Tags on one asset, by asset id", "GET", `${rest}/tags/{id}`)),
    { name: "add", summary: "Create a tag and attach it to an asset (tag, asset_id)", method: "POST", path: `${rest}/tags`, body: "required" },
    { name: "remove", summary: "Detach a tag from an asset (tag, asset_id)", method: "DELETE", path: `${rest}/tags`, body: "required" },
    { name: "bulk", summary: "Assign tags to many assets at once (asset_ids, tags; max 500 ids)", method: "POST", path: `${rest}/tags/bulk`, body: "required" },
    named("delete", byId("Delete a tag from the vocabulary and every asset", "DELETE", `${rest}/tags/{id}`))
  ]
}

const properties: Resource = {
  name: "properties",
  summary: "Custom properties on assets",
  actions: [
    named("get", byId("Get a property", "GET", `${rest}/properties/{id}`)),
    named("add", byId("Add a property to an asset by asset id (name, type, value, language)", "POST", `${rest}/properties/{id}`, "required")),
    named("update", byId("Update a property (type, value, language)", "PATCH", `${rest}/properties/{id}`, "required")),
    named("delete", byId("Delete a property", "DELETE", `${rest}/properties/{id}`))
  ]
}

const linkedResource: Resource = {
  name: "linked-resource",
  summary: "Products and other records linked to an asset",
  actions: [
    named("get", byId("Linked resources for an asset", "GET", `${rest}/linked-resource/{id}`))
  ]
}

const shares: Resource = {
  name: "shares",
  summary: "Share links for assets and directories",
  actions: [
    { name: "list", summary: "List share links visible to this integration", method: "GET", path: `${rest}/shares`, list: true },
    named("get", byId("Get a share link", "GET", `${rest}/shares/{id}`)),
    {
      name: "create",
      summary: "Create a share link (share_type asset|directory, asset_id or directory_id, name, expiry_days or no_expiry)",
      method: "POST",
      path: `${rest}/shares`,
      body: "required"
    },
    named("update", byId("Rename a share or change its expiry", "PUT", `${rest}/shares/{id}`, "required")),
    named("revoke", byId("Revoke a share link; the record is kept", "POST", `${rest}/shares/{id}/revoke`)),
    named("reauthorize", byId("Reactivate a revoked share link", "POST", `${rest}/shares/{id}/reauthorize`)),
    named("delete", byId("Delete a share record", "DELETE", `${rest}/shares/{id}`))
  ]
}

export const dam: Extension = {
  name: "dam",
  summary: "UnoPim DAM 3.x routes (unopim-digital-asset-management). Pinned to the 3.x paths.",
  docs: "https://documenter.getpostman.com/view/4385199/2sBXVhEWjQ",
  probe: { method: "GET", path: `${rest}/directories` },
  resources: [assets, directories, comments, tags, properties, linkedResource, shares]
}
