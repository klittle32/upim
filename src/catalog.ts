/**
 * UnoPim 3.1 REST surface.
 * Sources: https://devdocs.unopim.com/3.1/api/ and the measurements REST table.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export type QuerySpec = {
  readonly kind: "string" | "boolean"
  readonly name: string
  readonly param: string
  readonly description: string
  readonly required?: boolean
}

export type Action = {
  readonly name: string
  readonly summary: string
  readonly method: HttpMethod
  readonly path: string
  readonly args?: readonly string[]
  readonly body?: "required" | "optional"
  readonly list?: boolean
  readonly upload?: boolean
  readonly query?: readonly QuerySpec[]
}

export type Resource = {
  readonly name: string
  readonly summary: string
  readonly actions?: readonly Action[]
  readonly children?: readonly Resource[]
}

const crud = (
  path: string,
  id: string,
  options?: { readonly patch?: boolean; readonly list?: boolean }
): readonly Action[] => {
  const item = `${path}/{${id}}`
  const actions: Action[] = [
    { name: "list", summary: "List records", method: "GET", path, list: options?.list ?? true },
    { name: "get", summary: "Get one record", method: "GET", path: item, args: [id] },
    { name: "create", summary: "Create a record", method: "POST", path, body: "required" },
    { name: "update", summary: "Replace a record", method: "PUT", path: item, args: [id], body: "required" }
  ]
  if (options?.patch !== false) {
    actions.push({
      name: "patch",
      summary: "Partially update a record",
      method: "PATCH",
      path: item,
      args: [id],
      body: "required"
    })
  }
  actions.push({ name: "delete", summary: "Delete a record", method: "DELETE", path: item, args: [id] })
  return actions
}

const stringQuery = (name: string, description: string, required = false): QuerySpec => ({
  kind: "string",
  name,
  param: name,
  description,
  required
})

export const resources: readonly Resource[] = [
  {
    name: "attributes",
    summary: "Product attributes",
    actions: crud("/api/v1/rest/attributes", "code"),
    children: [
      {
        name: "options",
        summary: "Select and multiselect attribute options",
        actions: [
          {
            name: "list",
            summary: "List options for an attribute",
            method: "GET",
            path: "/api/v1/rest/attributes/{code}/options",
            args: ["code"],
            list: true
          },
          {
            name: "create",
            summary: "Create options",
            method: "POST",
            path: "/api/v1/rest/attributes/{code}/options",
            args: ["code"],
            body: "required"
          },
          {
            name: "update",
            summary: "Replace the option set",
            method: "PUT",
            path: "/api/v1/rest/attributes/{code}/options",
            args: ["code"],
            body: "required"
          },
          {
            name: "delete",
            summary: "Delete one option",
            method: "DELETE",
            path: "/api/v1/rest/attributes/{code}/options/{option}",
            args: ["code", "option"]
          }
        ]
      }
    ]
  },
  {
    name: "attribute-groups",
    summary: "Attribute groups",
    actions: crud("/api/v1/rest/attribute-groups", "code")
  },
  {
    name: "families",
    summary: "Attribute families",
    actions: crud("/api/v1/rest/families", "code"),
    children: [
      {
        name: "structures",
        summary: "Variant structures for a family",
        actions: [
          {
            name: "list",
            summary: "List variant structures",
            method: "GET",
            path: "/api/v1/rest/families/{code}/variant-structures",
            args: ["code"],
            list: true
          },
          {
            name: "get",
            summary: "Get a variant structure",
            method: "GET",
            path: "/api/v1/rest/families/{code}/variant-structures/{structure}",
            args: ["code", "structure"]
          },
          {
            name: "create",
            summary: "Create a variant structure",
            method: "POST",
            path: "/api/v1/rest/families/{code}/variant-structures",
            args: ["code"],
            body: "required"
          },
          {
            name: "update",
            summary: "Replace a variant structure",
            method: "PUT",
            path: "/api/v1/rest/families/{code}/variant-structures/{structure}",
            args: ["code", "structure"],
            body: "required"
          },
          {
            name: "patch",
            summary: "Partially update a variant structure",
            method: "PATCH",
            path: "/api/v1/rest/families/{code}/variant-structures/{structure}",
            args: ["code", "structure"],
            body: "required"
          },
          {
            name: "delete",
            summary: "Delete a variant structure",
            method: "DELETE",
            path: "/api/v1/rest/families/{code}/variant-structures/{structure}",
            args: ["code", "structure"]
          }
        ]
      }
    ]
  },
  {
    name: "categories",
    summary: "Categories",
    actions: crud("/api/v1/rest/categories", "code")
  },
  {
    name: "category-fields",
    summary: "Category fields",
    actions: crud("/api/v1/rest/category-fields", "code"),
    children: [
      {
        name: "options",
        summary: "Category field options",
        actions: [
          {
            name: "list",
            summary: "List options for a category field",
            method: "GET",
            path: "/api/v1/rest/category-fields/{code}/options",
            args: ["code"],
            list: true
          },
          {
            name: "create",
            summary: "Create category field options",
            method: "POST",
            path: "/api/v1/rest/category-fields/{code}/options",
            args: ["code"],
            body: "required"
          },
          {
            name: "update",
            summary: "Replace category field options",
            method: "PUT",
            path: "/api/v1/rest/category-fields/{code}/options",
            args: ["code"],
            body: "required"
          },
          {
            name: "delete",
            summary: "Delete one category field option",
            method: "DELETE",
            path: "/api/v1/rest/category-fields/{code}/options/{option}",
            args: ["code", "option"]
          }
        ]
      }
    ]
  },
  {
    name: "products",
    summary: "Simple and variant products",
    actions: [
      {
        name: "list",
        summary: "List products. Supports filters and cursor pagination.",
        method: "GET",
        path: "/api/v1/rest/products",
        list: true,
        query: [
          {
            kind: "boolean",
            name: "with-completeness",
            param: "with_completeness",
            description: "Include completeness scores"
          }
        ]
      },
      {
        name: "get",
        summary: "Get a product by SKU, including associations",
        method: "GET",
        path: "/api/v1/rest/products/{sku}",
        args: ["sku"],
        query: [
          {
            kind: "boolean",
            name: "with-completeness",
            param: "with_completeness",
            description: "Include completeness scores"
          }
        ]
      },
      {
        name: "create",
        summary: "Create a product. Variant children are created here with a parent.",
        method: "POST",
        path: "/api/v1/rest/products",
        body: "required"
      },
      {
        name: "update",
        summary: "Replace a product",
        method: "PUT",
        path: "/api/v1/rest/products/{sku}",
        args: ["sku"],
        body: "required"
      },
      {
        name: "patch",
        summary: "Partially update a product",
        method: "PATCH",
        path: "/api/v1/rest/products/{sku}",
        args: ["sku"],
        body: "required"
      },
      {
        name: "delete",
        summary: "Delete a product",
        method: "DELETE",
        path: "/api/v1/rest/products/{sku}",
        args: ["sku"]
      }
    ]
  },
  {
    name: "configurable-products",
    summary: "Configurable products",
    actions: [
      ...crud("/api/v1/rest/configurable-products", "sku").map((action) =>
        action.name === "list" || action.name === "get"
          ? {
              ...action,
              query: [
                {
                  kind: "boolean" as const,
                  name: "with-completeness",
                  param: "with_completeness",
                  description: "Include completeness scores"
                }
              ]
            }
          : action
      )
    ]
  },
  {
    name: "channels",
    summary: "Channels",
    actions: crud("/api/v1/rest/channels", "code", { patch: false })
  },
  {
    name: "locales",
    summary: "Locales",
    actions: crud("/api/v1/rest/locales", "code", { patch: false })
  },
  {
    name: "currencies",
    summary: "Currencies",
    actions: crud("/api/v1/rest/currencies", "code", { patch: false })
  },
  {
    name: "association-types",
    summary: "Association types and their per-link fields",
    actions: crud("/api/v1/rest/association-types", "code"),
    children: [
      {
        name: "fields",
        summary: "Fields stored on association links",
        actions: [
          {
            name: "list",
            summary: "List fields",
            method: "GET",
            path: "/api/v1/rest/association-types/{code}/fields",
            args: ["code"],
            list: true
          },
          {
            name: "create",
            summary: "Create a field",
            method: "POST",
            path: "/api/v1/rest/association-types/{code}/fields",
            args: ["code"],
            body: "required"
          },
          {
            name: "update",
            summary: "Replace a field",
            method: "PUT",
            path: "/api/v1/rest/association-types/{code}/fields/{field}",
            args: ["code", "field"],
            body: "required"
          },
          {
            name: "delete",
            summary: "Delete a field",
            method: "DELETE",
            path: "/api/v1/rest/association-types/{code}/fields/{field}",
            args: ["code", "field"]
          }
        ]
      }
    ]
  },
  {
    name: "media",
    summary: "Product, category, and swatch media",
    children: [
      {
        name: "product",
        summary: "Product media files",
        actions: [
          {
            name: "upload",
            summary: "Upload a product image or gallery file",
            method: "POST",
            path: "/api/v1/rest/media-files/product",
            upload: true,
            query: [
              stringQuery("sku", "Product SKU", true),
              stringQuery("attribute", "Media attribute code, for example image", true),
              stringQuery("channel", "Channel code when the attribute is channel scoped"),
              stringQuery("locale", "Locale code when the attribute is locale scoped")
            ]
          },
          {
            name: "get",
            summary: "List stored product media paths",
            method: "GET",
            path: "/api/v1/rest/media-files/product",
            query: [
              stringQuery("sku", "Product SKU", true),
              stringQuery("attribute", "Media attribute code", true),
              stringQuery("channel", "Channel code when the attribute is channel scoped"),
              stringQuery("locale", "Locale code when the attribute is locale scoped")
            ]
          },
          {
            name: "delete",
            summary: "Delete stored product media",
            method: "DELETE",
            path: "/api/v1/rest/media-files/product",
            query: [
              stringQuery("sku", "Product SKU", true),
              stringQuery("attribute", "Media attribute code", true),
              stringQuery("channel", "Channel code when the attribute is channel scoped"),
              stringQuery("locale", "Locale code when the attribute is locale scoped")
            ]
          }
        ]
      },
      {
        name: "category",
        summary: "Category media files",
        actions: [
          {
            name: "upload",
            summary: "Upload a category media file",
            method: "POST",
            path: "/api/v1/rest/media-files/category",
            upload: true,
            query: [
              stringQuery("code", "Category code", true),
              stringQuery("category_field", "Category media field code", true)
            ]
          },
          {
            name: "get",
            summary: "List stored category media paths",
            method: "GET",
            path: "/api/v1/rest/media-files/category",
            query: [
              stringQuery("code", "Category code", true),
              stringQuery("category_field", "Category media field code", true)
            ]
          },
          {
            name: "delete",
            summary: "Delete stored category media",
            method: "DELETE",
            path: "/api/v1/rest/media-files/category",
            query: [
              stringQuery("code", "Category code", true),
              stringQuery("category_field", "Category media field code", true)
            ]
          }
        ]
      },
      {
        name: "swatch",
        summary: "Attribute option swatch images",
        actions: [
          {
            name: "upload",
            summary: "Upload a swatch image (jpeg, png, jpg, webp, or svg, max 2 MB)",
            method: "POST",
            path: "/api/v1/rest/media-files/swatch",
            upload: true,
            query: [
              stringQuery("code", "Attribute option code", true),
              stringQuery("attribute_code", "Attribute code", true)
            ]
          },
          {
            name: "get",
            summary: "Read a swatch image path",
            method: "GET",
            path: "/api/v1/rest/media-files/swatch",
            query: [
              stringQuery("code", "Attribute option code", true),
              stringQuery("attribute_code", "Attribute code", true)
            ]
          },
          {
            name: "delete",
            summary: "Delete a swatch image",
            method: "DELETE",
            path: "/api/v1/rest/media-files/swatch",
            query: [
              stringQuery("code", "Attribute option code", true),
              stringQuery("attribute_code", "Attribute code", true)
            ]
          }
        ]
      }
    ]
  },
  {
    name: "passports",
    summary: "Digital product passport publications",
    actions: [
      {
        name: "list",
        summary: "List publications, newest first",
        method: "GET",
        path: "/api/v1/rest/passports",
        list: true,
        query: [
          stringQuery("sku", "Only publications for this product SKU"),
          stringQuery("status", "Only publications in this status")
        ]
      },
      {
        name: "get",
        summary: "Read every publication for one product",
        method: "GET",
        path: "/api/v1/rest/passports/{sku}",
        args: ["sku"]
      },
      {
        name: "publish",
        summary: "Queue publication (returns 202). Body requires channel_id and locale_ids.",
        method: "POST",
        path: "/api/v1/rest/passports/publish/{sku}",
        args: ["sku"],
        body: "required"
      },
      {
        name: "withdraw",
        summary: "Take a published passport offline by numeric publication id",
        method: "POST",
        path: "/api/v1/rest/passports/withdraw/{id}",
        args: ["id"]
      },
      {
        name: "reinstate",
        summary: "Put a withdrawn passport back online",
        method: "POST",
        path: "/api/v1/rest/passports/reinstate/{id}",
        args: ["id"]
      },
      {
        name: "redact",
        summary: "GDPR redact. Body requires reason.",
        method: "POST",
        path: "/api/v1/rest/passports/redact/{id}",
        args: ["id"],
        body: "required"
      }
    ]
  },
  {
    name: "measurements",
    summary: "Measurement families, units, and attribute bindings",
    actions: crud("/api/v1/rest/measurement", "code", { patch: false }),
    children: [
      {
        name: "units",
        summary: "Units belonging to a measurement family",
        actions: [
          {
            name: "list",
            summary: "List units",
            method: "GET",
            path: "/api/v1/rest/units/{family}",
            args: ["family"],
            list: true
          },
          {
            name: "get",
            summary: "Get a unit",
            method: "GET",
            path: "/api/v1/rest/units/{family}/{code}",
            args: ["family", "code"]
          },
          {
            name: "create",
            summary: "Create a unit",
            method: "POST",
            path: "/api/v1/rest/units/{family}",
            args: ["family"],
            body: "required"
          },
          {
            name: "update",
            summary: "Replace a unit",
            method: "PUT",
            path: "/api/v1/rest/units/{family}/{code}",
            args: ["family", "code"],
            body: "required"
          },
          {
            name: "delete",
            summary: "Delete a unit",
            method: "DELETE",
            path: "/api/v1/rest/units/{family}/{code}",
            args: ["family", "code"]
          }
        ]
      },
      {
        name: "bindings",
        summary: "Attribute measurement configuration",
        actions: [
          {
            name: "get",
            summary: "Read an attribute's family and unit binding",
            method: "GET",
            path: "/api/v1/rest/attribute-measurement/config/{attribute}",
            args: ["attribute"]
          },
          {
            name: "units",
            summary: "List units available to a measurement family",
            method: "GET",
            path: "/api/v1/rest/attribute-measurement/{family}",
            args: ["family"],
            list: true
          },
          {
            name: "bind",
            summary: "Bind an attribute to a measurement family and unit",
            method: "POST",
            path: "/api/v1/rest/attribute-measurement/{attribute}",
            args: ["attribute"],
            body: "required"
          },
          {
            name: "update",
            summary: "Update an attribute's measurement binding",
            method: "PUT",
            path: "/api/v1/rest/attribute-measurement/{attribute}",
            args: ["attribute"],
            body: "required"
          }
        ]
      }
    ]
  }
]

export type FlatAction = {
  readonly command: readonly string[]
  readonly action: Action
}

export const flatten = (
  nodes: readonly Resource[] = resources,
  prefix: readonly string[] = []
): readonly FlatAction[] =>
  nodes.flatMap((node) => {
    const command = [...prefix, node.name]
    const own = (node.actions ?? []).map((action) => ({
      command: [...command, action.name],
      action
    }))
    return [...own, ...flatten(node.children ?? [], command)]
  })
