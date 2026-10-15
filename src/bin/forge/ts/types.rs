//! TypeScript types, following specs/03-schema-types.md.

use std::collections::HashSet;

use forge::ts::{Fragment, Ident, frag, join};
use forge::{EnumValue, Field, Model, Number, Object, Scalar, Type};

/// Where a type is printed, which decides whether a union or an
/// intersection needs parentheses. An intersection inside a union has them.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Prec {
    Top,
    Intersection,
    Array,
}

/// Which way a value of a type goes: from the API, or to it in a request,
/// where a client leaves out the fields the document marks read-only.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Side {
    Read,
    Write,
}

/// Returns `t` as part of a line.
///
/// ```text
/// p!(f, "export type ", m, " = ", typ(m.ty(), Prec::Top), ";");
/// ```
pub(crate) fn typ(t: Type<'_>, prec: Prec) -> Fragment {
    side_typ(t, prec, Side::Read)
}

/// Returns `t` as a request has it: without the fields the document marks
/// read-only, and with the input type of a model that has any
/// ([`super::inputs`]).
pub(crate) fn input_typ(t: Type<'_>, prec: Prec) -> Fragment {
    side_typ(t, prec, Side::Write)
}

fn side_typ(t: Type<'_>, prec: Prec, side: Side) -> Fragment {
    let typ = |t, prec| side_typ(t, prec, side);
    match t {
        Type::Scalar(scalar) => scalar_type(scalar),
        Type::Model(m) if side == Side::Write && needs_input(m) => frag!(input_ident(m).ty()),
        Type::Model(m) => frag!(Ident::model(m).ty()),
        Type::Array(array) => frag!(typ(array.elem(), Prec::Array), "[]"),
        Type::Object(object) => object_type(object, side),
        Type::Enum(e) => {
            let values = join(" | ", e.values().map(literal));
            if e.values().len() > 1 && prec > Prec::Top {
                frag!("(", values, ")")
            } else {
                values
            }
        }
        Type::Union(union) => {
            let members = side_alternatives(union.members(), side);
            if prec > Prec::Top {
                frag!("(", members, ")")
            } else {
                members
            }
        }
        Type::Intersection(intersection) => {
            let members = join(" & ", intersection.members().map(|m| typ(m, Prec::Intersection)));
            if prec >= Prec::Intersection {
                frag!("(", members, ")")
            } else {
                members
            }
        }
    }
}

fn scalar_type(scalar: Scalar) -> Fragment {
    let ty = match scalar {
        Scalar::Unknown => "unknown",
        Scalar::Null => "null",
        Scalar::Boolean => "boolean",
        Scalar::String => "string",
        Scalar::Number(Number::Int64) => "bigint",
        Scalar::Number(_) => "number",
        // The runtime's dates.ts says what a date is.
        Scalar::DateTime => return frag!(super::runtime("Timestamp").ty()),
        Scalar::Date => return frag!(super::runtime("CalendarDate").ty()),
        Scalar::Bytes => "Uint8Array",
        // Only JSON content reaches the SDK, and in JSON a string with
        // format `binary` is still a string on the wire, so it is kept
        // as one, with no codec.
        Scalar::Binary => "string",
    };
    frag!(ty)
}

/// Returns an object type: its fields, and an index signature when it
/// allows other keys, or a map when it keeps no field.
fn object_type(object: Object<'_>, side: Side) -> Fragment {
    if !has_fields(Type::Object(object)) {
        return frag!("{ [key: string]: ", side_typ(elem(object), Prec::Top, side), " }");
    }
    let mut open = object.extra().is_some();
    let mut members = Vec::new();
    for field in fields(object) {
        if !kept(field) {
            open = true;
        } else if side == Side::Read || !field.is_read_only() {
            members.push(member(field, side));
        }
    }
    let mut out = frag!("{ ", join("; ", members));
    if open {
        out.text("; [key: string]: unknown");
    }
    out.text(" }");
    out
}

/// Returns `types` joined by ` | `. A union among them, which has a
/// discriminator, and an enum need no parentheses.
pub(super) fn alternatives<'f>(types: impl IntoIterator<Item = Type<'f>>) -> Fragment {
    side_alternatives(types, Side::Read)
}

fn side_alternatives<'f>(types: impl IntoIterator<Item = Type<'f>>, side: Side) -> Fragment {
    join(
        " | ",
        types.into_iter().map(|t| match t {
            Type::Union(_) | Type::Enum(_) => side_typ(t, Prec::Top, side),
            _ => side_typ(t, Prec::Intersection, side),
        }),
    )
}

/// Returns a property of an object type, without the `;` after it.
pub(super) fn member(field: Field<'_>, side: Side) -> Fragment {
    frag!(
        key(&field.name().camel()),
        if field.is_required() { ": " } else { "?: " },
        side_typ(field.ty(), Prec::Top, side)
    )
}

/// Reports whether a request's form of `m` differs from `m`: some object
/// in it, directly or through other models, arrays, maps and compositions,
/// has a field the document marks read-only.
pub(crate) fn needs_input(m: Model<'_>) -> bool {
    fn walk<'f>(t: Type<'f>, seen: &mut HashSet<Model<'f>>) -> bool {
        match t {
            Type::Model(m) => seen.insert(m) && walk(m.ty(), seen),
            Type::Array(array) => walk(array.elem(), seen),
            Type::Object(object) => {
                object
                    .fields()
                    .any(|f| kept(f) && (f.is_read_only() || walk(f.ty(), seen)))
                    || object.extra().is_some_and(|extra| walk(extra, seen))
            }
            Type::Union(union) => union.members().any(|m| walk(m, seen)),
            Type::Intersection(intersection) => intersection.members().any(|m| walk(m, seen)),
            Type::Scalar(_) | Type::Enum(_) => false,
        }
    }
    walk(m.ty(), &mut HashSet::new())
}

/// Returns the identifier of the input type of `m`, which a request has in
/// place of `m` when [`needs_input`] reports it: its name with `Input`
/// after it, declared in the `inputs.ts` next to its `models.ts`, so it
/// can't clash with a model.
pub(crate) fn input_ident(m: Model<'_>) -> Ident {
    let model = Ident::model(m);
    let dir = m.group().map_or(forge::ts::Module::ROOT, forge::ts::Module::group);
    dir.sub("inputs.ts").ident(format!("{}Input", model.name))
}

/// Returns the documentation of a declaration, with `@deprecated` after it
/// when it is deprecated.
pub(crate) fn doc(text: &str, deprecated: bool) -> String {
    if !deprecated {
        return text.to_owned();
    }
    let text = text.trim();
    if text.is_empty() {
        "@deprecated".to_owned()
    } else {
        format!("{text}\n\n@deprecated")
    }
}

/// Returns the fields of `object`, sorted by wire name.
pub(super) fn fields(object: Object<'_>) -> Vec<Field<'_>> {
    let mut fields: Vec<Field<'_>> = object.fields().collect();
    fields.sort_by_key(|field| field.wire_name());
    fields
}

/// Returns the type of the values of a map, which is unknown when the map
/// does not say.
pub(super) fn elem(object: Object<'_>) -> Type<'_> {
    object.extra().unwrap_or(Type::Scalar(Scalar::Unknown))
}

/// Reports whether `t` is an object type with a property the SDK keeps. An
/// object without one is a map.
pub(super) fn has_fields(t: Type<'_>) -> bool {
    matches!(t, Type::Object(object) if object.fields().any(kept))
}

/// Reports whether the SDK keeps a property: its name is valid
/// (specs/02-naming.md). An object that leaves out a property allows other
/// keys.
pub(crate) fn kept(field: Field<'_>) -> bool {
    valid_name(field.wire_name())
}

/// Reports whether `t` is an object type with fields, a model of one, or a
/// composition of them. `seen` has the models already followed.
pub(super) fn object_like<'f>(t: Type<'f>, seen: &mut HashSet<Model<'f>>) -> bool {
    match t {
        Type::Object(_) => has_fields(t),
        Type::Model(m) => seen.insert(m) && object_like(m.ty(), seen),
        Type::Union(union) => union.members().all(|m| object_like(m, seen)),
        Type::Intersection(intersection) => intersection.members().all(|m| object_like(m, seen)),
        _ => false,
    }
}

/// Reports whether an empty object is a value of `t`.
pub(crate) fn all_optional(t: Type<'_>) -> bool {
    fn walk<'f>(t: Type<'f>, seen: &mut HashSet<Model<'f>>) -> bool {
        match t {
            // A request leaves out a read-only field, even a required one.
            Type::Object(object) => !object.fields().any(|f| kept(f) && f.is_required() && !f.is_read_only()),
            Type::Scalar(Scalar::Unknown) => true,
            Type::Model(m) => seen.insert(m) && walk(m.ty(), seen),
            Type::Intersection(intersection) => intersection.members().all(|m| walk(m, seen)),
            Type::Union(union) => union.members().any(|m| walk(m, seen)),
            _ => false,
        }
    }
    walk(t, &mut HashSet::new())
}

/// Prefixes `s` with `_` if it starts with a digit, so it's a valid
/// identifier.
pub(crate) fn identifier(s: String) -> String {
    if s.starts_with(|c: char| c.is_ascii_digit()) {
        format!("_{s}")
    } else {
        s
    }
}

/// Reports whether `s` is made only of letters, digits, `-` and `_`, and
/// has at least one letter or digit.
pub(super) fn valid_name(s: &str) -> bool {
    let mut alnum = false;
    for c in s.chars() {
        if c.is_alphabetic() || c.is_numeric() {
            alnum = true;
        } else if c != '-' && c != '_' {
            return false;
        }
    }
    alnum
}

/// Reports whether `s` is a JavaScript identifier made of ASCII letters,
/// digits, `_` and `$`.
pub(super) fn is_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// Returns a property name, quoted when it is not an identifier.
pub(crate) fn key(name: &str) -> String {
    if is_identifier(name) {
        name.to_owned()
    } else {
        js_string(name)
    }
}

/// Returns `s` as a string literal, escaped as Go's `encoding/json` does
/// without HTML escaping.
pub(crate) fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\u{2028}' | '\u{2029}' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Returns an enum value as a literal type.
fn literal(value: EnumValue<'_>) -> String {
    match value {
        EnumValue::String(s) => js_string(s),
        EnumValue::Number(n) => n.to_string(),
        EnumValue::Boolean(b) => b.to_string(),
    }
}
