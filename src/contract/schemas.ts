import { Schema } from "effect"

const describe = <S extends Schema.Top>(schema: S, description: string) =>
  schema.pipe(Schema.annotate({ description }))

const named = <S extends Schema.Top>(schema: S, identifier: string, description: string) =>
  schema.pipe(Schema.annotate({ identifier, title: identifier, description }))

const text = (description: string) => describe(Schema.NonEmptyString, description)

/** UnoPim stores several switches as 0 or 1, not JSON booleans. */
const Bit = describe(Schema.Literals([0, 1]), "0 or 1")

const Labels = named(
  Schema.Record(Schema.String, Schema.String),
  "LocaleLabels",
  "Locale code to label. Locale codes are configured on the server; list them with `upim locales list`."
)

const NullableText = Schema.NullOr(Schema.String)

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)

export const AttributeWrite = named(Schema.Struct({
  code: text("Attribute code. Letters, numbers, and underscores; unique in the catalog."),
  type: text("Attribute type, for example text, textarea, boolean, number, price, date, datetime, select, multiselect, image, or gallery. The installation is the authority for the full set."),
  validation: Schema.optionalKey(describe(NullableText, "Built-in validation name such as decimal, or null.")),
  regex_pattern: Schema.optionalKey(describe(NullableText, "Regular expression constraint, or null.")),
  position: Schema.optionalKey(describe(Schema.Int, "Sort position.")),
  is_required: Schema.optionalKey(Bit),
  is_unique: Schema.optionalKey(Bit),
  value_per_locale: Schema.optionalKey(Bit),
  value_per_channel: Schema.optionalKey(Bit),
  enable_wysiwyg: Schema.optionalKey(Bit),
  labels: Schema.optionalKey(Labels)
}), "AttributeWrite", "Create or replace an attribute. code and type are required; other documented fields are optional and unknown keys are forwarded.")

export const AttributePatch = named(Schema.Struct({
  code: Schema.optionalKey(text("Attribute code.")),
  type: Schema.optionalKey(text("Attribute type.")),
  validation: Schema.optionalKey(NullableText),
  regex_pattern: Schema.optionalKey(NullableText),
  position: Schema.optionalKey(Schema.Int),
  is_required: Schema.optionalKey(Bit),
  is_unique: Schema.optionalKey(Bit),
  value_per_locale: Schema.optionalKey(Bit),
  value_per_channel: Schema.optionalKey(Bit),
  enable_wysiwyg: Schema.optionalKey(Bit),
  labels: Schema.optionalKey(Labels)
}), "AttributePatch", "Partial attribute update. Only the keys you send are changed.")

export const AttributeGroupWrite = named(Schema.Struct({
  code: text("Attribute group code."),
  labels: Schema.optionalKey(Labels)
}), "AttributeGroupWrite", "Create or replace an attribute group.")

export const AttributeGroupPatch = named(Schema.Struct({
  code: Schema.optionalKey(text("Attribute group code.")),
  labels: Schema.optionalKey(Labels)
}), "AttributeGroupPatch", "Partial attribute group update.")

const PositionedCode = Schema.Struct({
  code: text("Attribute or group code."),
  position: Schema.optionalKey(describe(Schema.Int, "Sort position."))
})

export const FamilyWrite = named(Schema.Struct({
  code: text("Family code."),
  labels: Schema.optionalKey(Labels),
  attribute_groups: Schema.optionalKey(describe(Schema.Array(Schema.Struct({
    code: text("Attribute group code."),
    position: Schema.optionalKey(Schema.Int),
    custom_attributes: Schema.optionalKey(Schema.Array(PositionedCode))
  })), "Groups and the attributes assigned inside them."))
}), "FamilyWrite", "Create or replace an attribute family.")

export const FamilyPatch = named(Schema.Struct({
  code: Schema.optionalKey(text("Family code.")),
  labels: Schema.optionalKey(Labels),
  attribute_groups: Schema.optionalKey(Schema.Array(Schema.Struct({
    code: Schema.optionalKey(text("Attribute group code.")),
    position: Schema.optionalKey(Schema.Int),
    custom_attributes: Schema.optionalKey(Schema.Array(PositionedCode))
  })))
}), "FamilyPatch", "Partial family update.")

export const OptionWrite = named(Schema.Struct({
  code: text("Option code."),
  sort_order: Schema.optionalKey(describe(Schema.Int, "Sort order.")),
  labels: Schema.optionalKey(Labels)
}), "OptionWrite", "One select or multiselect option.")

export const OptionListWrite = named(
  Schema.Array(OptionWrite),
  "OptionListWrite",
  "Create or replace the option list. The body is a JSON array."
)

export const CategoryWrite = named(Schema.Struct({
  code: text("Category code."),
  parent: text("Parent category code. The tree root is root."),
  additional_data: Schema.optionalKey(describe(Schema.Unknown, "Category field values. The field set is configured on the server; list it with `upim category-fields list`."))
}), "CategoryWrite", "Create or replace a category. additional_data is not fully described here because category fields are instance-defined.")

export const CategoryPatch = named(Schema.Struct({
  code: Schema.optionalKey(text("Category code.")),
  parent: Schema.optionalKey(text("Parent category code.")),
  additional_data: Schema.optionalKey(Schema.Unknown)
}), "CategoryPatch", "Partial category update.")

export const CategoryFieldWrite = named(Schema.Struct({
  code: text("Category field code."),
  type: text("Field type, for example text."),
  status: Schema.optionalKey(Bit),
  validation: Schema.optionalKey(NullableText),
  regex_pattern: Schema.optionalKey(NullableText),
  position: Schema.optionalKey(Schema.Int),
  is_required: Schema.optionalKey(Bit),
  is_unique: Schema.optionalKey(Bit),
  value_per_locale: Schema.optionalKey(Bit),
  enable_wysiwyg: Schema.optionalKey(Bit),
  section: Schema.optionalKey(describe(Schema.String, "Admin section, for example left.")),
  labels: Schema.optionalKey(Labels)
}), "CategoryFieldWrite", "Create or replace a category field.")

export const CategoryFieldPatch = named(Schema.Struct({
  code: Schema.optionalKey(text("Category field code.")),
  type: Schema.optionalKey(text("Field type.")),
  status: Schema.optionalKey(Bit),
  validation: Schema.optionalKey(NullableText),
  regex_pattern: Schema.optionalKey(NullableText),
  position: Schema.optionalKey(Schema.Int),
  is_required: Schema.optionalKey(Bit),
  is_unique: Schema.optionalKey(Bit),
  value_per_locale: Schema.optionalKey(Bit),
  enable_wysiwyg: Schema.optionalKey(Bit),
  section: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(Labels)
}), "CategoryFieldPatch", "Partial category field update.")

export const ProductValues = named(Schema.Struct({
  common: Schema.optionalKey(describe(UnknownRecord, "Attribute codes that are not scoped to a channel or locale. Values may be strings, numbers, booleans, or price objects.")),
  categories: Schema.optionalKey(describe(Schema.Array(Schema.String), "Category codes.")),
  channel_specific: Schema.optionalKey(describe(
    Schema.Record(Schema.String, UnknownRecord),
    "Channel code, then attribute code, then value."
  )),
  channel_locale_specific: Schema.optionalKey(describe(
    Schema.Record(Schema.String, Schema.Record(Schema.String, UnknownRecord)),
    "Channel code, then locale code, then attribute code, then value."
  ))
}), "ProductValues", "Value buckets. Keys inside the buckets are attribute codes from this installation, not a fixed list.")

export const ProductAssociations = named(
  Schema.Record(Schema.String, Schema.Array(Schema.Struct({
    sku: text("SKU of the linked product. Responses name this related_sku; requests use sku."),
    additional_data: Schema.optionalKey(describe(Schema.NullOr(Schema.Unknown), "Per-link field values defined by the association type, or null."))
  }))),
  "ProductAssociations",
  "Association type code to links. Each submitted type replaces that type's links. Omitted types are left alone."
)

const productFields = {
  sku: text("Product SKU."),
  family: text("Attribute family code."),
  type: text("Product type, for example simple or configurable."),
  status: Schema.optionalKey(describe(Schema.Boolean, "Enabled when true.")),
  parent: Schema.optionalKey(describe(Schema.NullOr(Schema.String), "Parent SKU for a variant, or null.")),
  additional: Schema.optionalKey(describe(Schema.NullOr(Schema.Unknown), "Additional product payload, or null.")),
  values: Schema.optionalKey(ProductValues),
  associations: Schema.optionalKey(ProductAssociations),
  super_attributes: Schema.optionalKey(describe(Schema.Array(Schema.String), "Configurable products only. Variant axis attribute codes.")),
  variants: Schema.optionalKey(describe(Schema.Array(Schema.Struct({
    sku: text("Variant SKU."),
    attributes: Schema.optionalKey(describe(UnknownRecord, "Axis attribute code to option code."))
  })), "Configurable products only. Existing variants to attach."))
}

export const ProductWrite = named(Schema.Struct(productFields), "ProductWrite", "Create or replace a simple or configurable product. values and associations are checked only as envelopes. Attribute codes, option codes, channels, and locales are discovered from the server.")

export const ProductPatch = named(Schema.Struct({
  sku: Schema.optionalKey(text("Product SKU.")),
  family: Schema.optionalKey(text("Attribute family code.")),
  type: Schema.optionalKey(text("Product type.")),
  status: Schema.optionalKey(Schema.Boolean),
  parent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  additional: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
  values: Schema.optionalKey(ProductValues),
  associations: Schema.optionalKey(ProductAssociations),
  super_attributes: Schema.optionalKey(Schema.Array(Schema.String)),
  variants: Schema.optionalKey(Schema.Array(Schema.Struct({
    sku: Schema.optionalKey(text("Variant SKU.")),
    attributes: Schema.optionalKey(UnknownRecord)
  })))
}), "ProductPatch", "Partial product update. Send only the keys that change. Unknown attribute codes inside values are forwarded.")

export const ChannelWrite = named(Schema.Struct({
  code: text("Channel code."),
  locales: describe(Schema.Array(Schema.String), "Locale codes enabled on the channel."),
  currencies: describe(Schema.Array(Schema.String), "Currency codes enabled on the channel."),
  root_category: text("Root category code for the channel tree."),
  labels: Schema.optionalKey(Labels)
}), "ChannelWrite", "Create or replace a channel. PUT replaces the submitted resource; omitted translations keep their stored values.")

export const LocaleWrite = named(Schema.Struct({
  code: text("Locale code, for example fr_FR."),
  status: Bit
}), "LocaleWrite", "Create or replace a locale.")

export const CurrencyWrite = named(Schema.Struct({
  code: text("Currency code, for example CAD."),
  status: Bit
}), "CurrencyWrite", "Create or replace a currency.")

export const AssociationTypeWrite = named(Schema.Struct({
  code: text("Association type code. Letters, numbers, and underscores, no leading digit, and not a reserved product field."),
  status: Schema.optionalKey(describe(Schema.Boolean, "Enabled when true."))
}), "AssociationTypeWrite", "Create or replace an association type. Locale keys such as en_US are objects { name } and are not listed here because the active locale set comes from the server. Unknown keys are forwarded.")

export const AssociationTypePatch = named(Schema.Struct({
  code: Schema.optionalKey(text("Association type code.")),
  status: Schema.optionalKey(Schema.Boolean)
}), "AssociationTypePatch", "Partial association type update. Locale name objects are forwarded as unknown keys.")

export const AssociationFieldWrite = named(Schema.Struct({
  code: text("Field code. code, type, and locale are reserved."),
  type: text("Field type, for example text."),
  status: Schema.optionalKey(Schema.Boolean),
  validation: Schema.optionalKey(NullableText),
  position: Schema.optionalKey(Schema.Int),
  is_required: Schema.optionalKey(Bit),
  is_unique: Schema.optionalKey(Bit),
  value_per_locale: Schema.optionalKey(Bit),
  labels: Schema.optionalKey(Labels)
}), "AssociationFieldWrite", "Create or replace a per-link association field. The 3.1 field page shows the stored shape; treat a server 422 as the authority.")

export const VariantStructureWrite = named(Schema.Struct({
  code: text("Variant structure code."),
  name: text("Display name."),
  levels: describe(Schema.Int, "Number of variant levels."),
  axes: Schema.Struct({
    level_1: describe(Schema.Array(Schema.String), "Attribute codes for the first level."),
    level_2: Schema.optionalKey(describe(Schema.Array(Schema.String), "Attribute codes for the second level. Empty for a single-level structure."))
  }),
  placements: Schema.optionalKey(Schema.Struct({
    common: Schema.optionalKey(Schema.Array(Schema.String)),
    sub_parent: Schema.optionalKey(Schema.Array(Schema.String)),
    variant: Schema.optionalKey(Schema.Array(Schema.String))
  }))
}), "VariantStructureWrite", "Create or replace a family variant structure. A GET result round-trips as a PUT body.")

export const VariantStructurePatch = named(Schema.Struct({
  code: Schema.optionalKey(text("Variant structure code.")),
  name: Schema.optionalKey(text("Display name.")),
  levels: Schema.optionalKey(Schema.Int),
  axes: Schema.optionalKey(Schema.Struct({
    level_1: Schema.optionalKey(Schema.Array(Schema.String)),
    level_2: Schema.optionalKey(Schema.Array(Schema.String))
  })),
  placements: Schema.optionalKey(Schema.Struct({
    common: Schema.optionalKey(Schema.Array(Schema.String)),
    sub_parent: Schema.optionalKey(Schema.Array(Schema.String)),
    variant: Schema.optionalKey(Schema.Array(Schema.String))
  }))
}), "VariantStructurePatch", "Partial variant structure update.")

export const PassportPublish = named(Schema.Struct({
  channel_id: describe(Schema.Int, "Numeric channel id."),
  locale_ids: describe(Schema.Array(Schema.Int), "Numeric locale ids to publish.")
}), "PassportPublish", "Queue a digital product passport publication. The call returns 202.")

export const PassportRedact = named(Schema.Struct({
  reason: text("Why the passport is being redacted.")
}), "PassportRedact", "GDPR redaction. reason is required.")

export const FilterClause = named(Schema.Struct({
  operator: text("Filter operator."),
  value: describe(Schema.Unknown, "Comparison value. IN and NOT IN take an array. BETWEEN takes exactly two values. Other operators take a scalar.")
}), "FilterClause", "One filter clause.")

export const Filters = named(
  Schema.Record(Schema.String, Schema.Array(FilterClause)),
  "Filters",
  "Field code to a list of clauses. Documented operators include =, IN, NOT IN, >, >=, <, <=, and BETWEEN. Other operators are forwarded and judged by UnoPim."
)
