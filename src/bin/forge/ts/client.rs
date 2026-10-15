//! The client.ts of a group: its client (specs/07-client-surface.md), and
//! the requests (specs/05-requests.md), responses (specs/06-responses.md)
//! and operations of its methods.

use std::collections::{HashMap, HashSet};

use forge::ts::{File, Fragment, Ident, Module, frag, join, p};
use forge::{Field, Group, Location, Method, Model, Scalar, Type};

use super::models::print_fields;
use super::operation::operation;
use super::types::{
    Prec, Side, all_optional, alternatives, doc, has_fields, identifier, input_typ, js_string, kept, key, object_like,
    typ, valid_name,
};
use super::{Node, request_options, runtime};

/// Returns the client.ts of `node`: its ClientOptions and Client,
/// createClient and bind, the request and response types of each method,
/// then the operation of each method. The library has already rejected
/// methods and groups with no name and duplicate methods, and equal group
/// names are one group.
pub(super) fn client(node: Node<'_>) -> File {
    let groups = node.children();
    let group_names: HashMap<String, Group<'_>> = groups.iter().map(|&sub| (group_name(sub), sub)).collect();

    let methods: Vec<(Method<'_>, Request<'_>)> = node.methods().into_iter().map(|m| (m, Request::new(m))).collect();

    let mut f = File::new(node.dir().sub("client.ts"));
    client_options(&mut f);
    p!(f);
    client_interface(&mut f, &methods, &groups, &group_names);
    p!(f);
    p!(
        f,
        "export function ",
        f.ident("createClient"),
        "(options: ",
        f.ident("ClientOptions"),
        "): ",
        f.ident("Client"),
        " {"
    );
    f.indent(|f| {
        p!(
            f,
            "return ",
            f.ident("bind"),
            "(new ",
            runtime("Transport"),
            "(options));"
        );
    });
    p!(f, "}");
    p!(f);
    bind(&mut f, &methods, &groups, &group_names);
    for (m, request) in &methods {
        p!(f);
        request_type(&mut f, *m, request);
        p!(f);
        response_type(&mut f, *m);
    }
    for (m, request) in &methods {
        p!(f);
        operation(&mut f, *m, request);
    }
    f
}

/// Declares the ClientOptions of a group: the options every client takes,
/// and baseUrl, which is required.
fn client_options(f: &mut File) {
    p!(
        f,
        "export interface ",
        f.ident("ClientOptions"),
        " extends ",
        runtime("BaseClientOptions").ty(),
        " {"
    );
    f.indent(|f| {
        f.doc("The URL the paths of the API are relative to.");
        p!(f, "baseUrl: string;");
    });
    p!(f, "}");
}

/// Declares bind, which returns the Client of a group on a transport, any
/// Sender rather than only the runtime's Transport: each method sends its
/// operation, and each subgroup is a getter that binds the subgroup's Client
/// the first time it is read. A method and a subgroup with the same name
/// share a getter, of the method with the members of the subgroup's Client.
fn bind(
    f: &mut File,
    methods: &[(Method<'_>, Request<'_>)],
    groups: &[Group<'_>],
    group_names: &HashMap<String, Group<'_>>,
) {
    let shared: HashMap<String, Method<'_>> = methods
        .iter()
        .map(|&(m, _)| (method_name(m), m))
        .filter(|(name, _)| group_names.contains_key(name))
        .collect();
    p!(
        f,
        "export function ",
        f.ident("bind"),
        // A client with nothing to send leaves its transport unused.
        if methods.is_empty() && groups.is_empty() {
            "(_transport: "
        } else {
            "(transport: "
        },
        runtime("Sender").ty(),
        "): ",
        f.ident("Client"),
        " {"
    );
    f.indent(|f| {
        for &sub in groups {
            let name = group_name(sub);
            match shared.get(&name) {
                Some(&m) => {
                    let method = js_string(&method_name(m));
                    p!(
                        f,
                        "let ",
                        name,
                        "Client: ",
                        f.ident("Client"),
                        "[",
                        method,
                        "] | undefined;"
                    );
                }
                None => p!(f, "let ", name, "Client: ", client_ident(sub), " | undefined;"),
            }
        }
        p!(f, "return {");
        f.indent(|f| {
            for &(m, _) in methods {
                let name = method_name(m);
                if !shared.contains_key(&name) {
                    p!(f, key(&name), ": (request, options) => ", send(f, m), ",");
                }
            }
            for &sub in groups {
                let name = group_name(sub);
                p!(f, "get ", key(&name), "() {");
                f.indent(|f| match shared.get(&name) {
                    Some(&m) => {
                        p!(f, "return (", name, "Client ??= Object.assign(");
                        f.indent(|f| {
                            p!(
                                f,
                                "(request: ",
                                request_ident(f, m),
                                ", options?: ",
                                request_options(),
                                "): ",
                                result(f, m),
                                " => ",
                                send(f, m),
                                ","
                            );
                            p!(f, bind_ident(sub), "(transport),");
                        });
                        p!(f, "));");
                    }
                    None => p!(f, "return (", name, "Client ??= ", bind_ident(sub), "(transport));"),
                });
                p!(f, "},");
            }
        });
        p!(f, "};");
    });
    p!(f, "}");
}

/// Returns the call that sends the operation of `m`.
fn send(f: &File, m: Method<'_>) -> Fragment {
    frag!("transport.send(", operation_ident(f, m), ", request, options)")
}

/// Returns the bind of group `g`, imported under the name of the group.
fn bind_ident(g: Group<'_>) -> Ident {
    let alias = format!("bind{}", identifier(g.name().pascal()));
    Module::group(g).sub("client.ts").ident("bind").alias(alias)
}

/// Returns the Client of group `g`, imported under the name of the group.
fn client_ident(g: Group<'_>) -> Ident {
    let alias = format!("{}Client", identifier(g.name().pascal()));
    Module::group(g).sub("client.ts").ident("Client").ty().alias(alias)
}

/// Declares the Client of a group: its methods, then its subgroups, which
/// `group_names` has by name. A method and a subgroup with the same name
/// share the property, which is a function with the members of the
/// subgroup's Client.
fn client_interface(
    f: &mut File,
    methods: &[(Method<'_>, Request<'_>)],
    groups: &[Group<'_>],
    group_names: &HashMap<String, Group<'_>>,
) {
    if methods.is_empty() && groups.is_empty() {
        p!(f, "export interface ", f.ident("Client"), " {}");
        return;
    }
    p!(f, "export interface ", f.ident("Client"), " {");
    let mut shared = HashSet::new();
    f.indent(|f| {
        for (m, request) in methods {
            let m = *m;
            f.doc(&doc(&method_doc(m), m.is_deprecated()));
            let name = method_name(m);
            let params = method_params(f, m, request);
            match group_names.get(&name) {
                None => p!(f, key(&name), "(", params, "): ", result(f, m), ";"),
                Some(&sub) => {
                    p!(
                        f,
                        "readonly ",
                        key(&name),
                        ": ((",
                        params,
                        ") => ",
                        result(f, m),
                        ") & ",
                        client_ident(sub),
                        ";"
                    );
                    shared.insert(name);
                }
            }
        }
        for &sub in groups {
            let name = group_name(sub);
            if !shared.contains(&name) {
                p!(f, "readonly ", key(&name), ": ", client_ident(sub), ";");
            }
        }
    });
    p!(f, "}");
}

/// Returns the parameters of `m`: its request, which is optional when an
/// empty object is a request, and the options of the call.
fn method_params(f: &File, m: Method<'_>, request: &Request<'_>) -> Fragment {
    frag!(
        "request",
        if request.optional() { "?: " } else { ": " },
        request_ident(f, m),
        ", options?: ",
        request_options()
    )
}

/// Returns what `m` returns: a promise of its response.
fn result(f: &File, m: Method<'_>) -> Fragment {
    frag!("Promise<", response_ident(f, m), ">")
}

/// Declares the request type of `m`: its parameters, then its body. A flat
/// body sits next to the parameters, in an interface when it is an object
/// type, and intersected with them otherwise. Any other body is the field
/// `body`.
fn request_type(f: &mut File, m: Method<'_>, request: &Request<'_>) {
    let name = request_ident(f, m);
    let params = &request.params;
    if let Some(body) = &request.body
        && body.encoding != Encoding::Json
    {
        p!(f, "export interface ", name, " {");
        print_params(f, params);
        f.indent(|f| match (&body.parts, request.flat) {
            (Some(parts), true) => print_parts(f, parts),
            (parts, _) => {
                f.doc(body.description);
                let ty = match (body.encoding, parts) {
                    (Encoding::Raw { text: true }, _) => frag!("string"),
                    (Encoding::Raw { text: false }, _) => frag!(runtime("BinaryInput").ty()),
                    (_, Some(parts)) => parts_type(parts),
                    (_, None) => frag!("{ [key: string]: unknown }"),
                };
                p!(f, "body", if body.required { ": " } else { "?: " }, ty, ";");
            }
        });
        p!(f, "}");
        return;
    }
    if let Some(body) = &request.body
        && request.flat
        && !has_fields(body.ty)
    {
        if params.is_empty() {
            p!(f, "export type ", name, " = ", input_typ(body.ty, Prec::Top), ";");
            return;
        }
        p!(f, "export type ", name, " = {");
        print_params(f, params);
        p!(f, "} & ", input_typ(body.ty, Prec::Intersection), ";");
        return;
    }
    // A flat body whose fields are all read-only sends nothing of its own.
    let empty_body = match &request.body {
        None => true,
        Some(body) => {
            request.flat
                && matches!(body.ty, Type::Object(object)
                    if object.extra().is_none() && object.fields().all(|f| kept(f) && f.is_read_only()))
        }
    };
    if params.is_empty() && empty_body {
        p!(f, "export interface ", name, " {}");
        return;
    }
    p!(f, "export interface ", name, " {");
    print_params(f, params);
    if let Some(body) = &request.body {
        match body.ty {
            Type::Object(object) if request.flat => print_fields(f, object, Side::Write),
            ty => f.indent(|f| {
                f.doc(body.description);
                p!(
                    f,
                    "body",
                    if body.required { ": " } else { "?: " },
                    input_typ(ty, Prec::Top),
                    ";"
                );
            }),
        }
    }
    p!(f, "}");
}

/// Declares the response type of `m`: void when no success response has a
/// body, an interface when the only one is an object type, and otherwise a
/// union of the bodies, with undefined when a success response can have
/// none.
fn response_type(f: &mut File, m: Method<'_>) {
    let name = response_ident(f, m);
    let raw = match response_kind(m) {
        ResponseKind::Json => None,
        ResponseKind::Text => Some("string"),
        ResponseKind::Bytes => Some("Uint8Array"),
    };
    if let Some(raw) = raw {
        // A success response with no content has no body.
        let optional = m.responses().any(|r| r.contents().len() == 0);
        p!(
            f,
            "export type ",
            name,
            " = ",
            raw,
            if optional { " | undefined;" } else { ";" }
        );
        return;
    }
    let (types, optional) = response(m);
    match types[..] {
        [] => p!(f, "export type ", name, " = void;"),
        [Type::Object(object)] if !optional && has_fields(types[0]) => {
            p!(f, "export interface ", name, " {");
            print_fields(f, object, Side::Read);
            p!(f, "}");
        }
        _ if optional => p!(f, "export type ", name, " = ", alternatives(types), " | undefined;"),
        [ty] => p!(f, "export type ", name, " = ", typ(ty, Prec::Top), ";"),
        _ => p!(f, "export type ", name, " = ", alternatives(types), ";"),
    }
}

/// Returns the types of the JSON bodies of the success responses of `m`,
/// each model once, and whether a success response can have no body.
pub(super) fn response(m: Method<'_>) -> (Vec<Type<'_>>, bool) {
    let mut types = Vec::new();
    let mut optional = false;
    let mut seen: HashSet<Model<'_>> = HashSet::new();
    for response in m.responses() {
        match response.json().map(|content| content.ty()) {
            None => optional = true,
            Some(Type::Model(model)) if !seen.insert(model) => {}
            Some(ty) => types.push(ty),
        }
    }
    (types, optional)
}

/// The request of a method: its parameters that have a field, and its JSON
/// body.
pub(crate) struct Request<'f> {
    /// The parameters, path parameters first.
    pub(crate) params: Vec<Param<'f>>,
    pub(crate) body: Option<Body<'f>>,
    /// Whether the body's fields sit next to the parameters, rather than in
    /// the field `body`.
    pub(crate) flat: bool,
}

/// A parameter of a method, and the name of its field in the request.
pub(crate) struct Param<'f> {
    pub(crate) field: Field<'f>,
    pub(crate) name: String,
    pub(super) location: Location,
}

/// The request body of a method, in the media type it is sent as.
pub(crate) struct Body<'f> {
    /// The type of the content: of the JSON, or of the multipart or form
    /// fields. A raw body is typed by its encoding instead.
    pub(crate) ty: Type<'f>,
    pub(super) media_type: &'f str,
    pub(crate) required: bool,
    pub(super) description: &'f str,
    pub(crate) encoding: Encoding,
    /// The fields of a multipart or form body, each part once, or `None`
    /// when its type has no fixed fields, such as a union.
    pub(crate) parts: Option<Vec<Part<'f>>>,
}

/// How a request body is sent.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Encoding {
    Json,
    /// `multipart/form-data`: each field a part, binary values as files.
    Multipart,
    /// `application/x-www-form-urlencoded`.
    Form,
    /// The value itself, as the media type says: text, or bytes.
    Raw {
        text: bool,
    },
}

/// A field of a multipart or form body: the fields with its wire name in
/// each member of the body's type, which an `allOf` can declare more than
/// once.
pub(crate) struct Part<'f> {
    pub(crate) fields: Vec<Field<'f>>,
}

impl<'f> Part<'f> {
    fn first(&self) -> Field<'f> {
        self.fields[0]
    }

    /// Reports whether the part must be sent: one of its fields is
    /// required, and not read-only.
    pub(crate) fn is_required(&self) -> bool {
        self.fields.iter().any(|f| f.is_required() && !f.is_read_only())
    }

    fn is_read_only(&self) -> bool {
        self.fields.iter().all(|f| f.is_read_only())
    }
}

/// What the success responses of a method have.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResponseKind {
    /// JSON, or no body.
    Json,
    /// Text, such as `text/plain` or `application/xml`.
    Text,
    /// Bytes, such as `application/octet-stream` or `image/png`.
    Bytes,
}

/// Returns what the success responses of `m` have: JSON when any has it,
/// or no body; otherwise text when every media type is text, and bytes
/// when one isn't.
pub(crate) fn response_kind(m: Method<'_>) -> ResponseKind {
    let mut media_types = Vec::new();
    for response in m.responses() {
        if response.json().is_some() {
            return ResponseKind::Json;
        }
        media_types.extend(response.contents().map(|c| c.media_type()));
    }
    match media_types[..] {
        [] => ResponseKind::Json,
        _ if media_types.iter().all(|t| is_text(t)) => ResponseKind::Text,
        _ => ResponseKind::Bytes,
    }
}

/// Returns the media types of the success responses of `m` that are not
/// JSON, each once, for the `Accept` header of a request for text or bytes.
pub(crate) fn accept(m: Method<'_>) -> Vec<&str> {
    let mut types = Vec::new();
    for content in m.responses().flat_map(|r| r.contents()) {
        if !types.contains(&content.media_type()) {
            types.push(content.media_type());
        }
    }
    types
}

/// Reports whether a media type is text: `text/*`, XML, JavaScript, a PEM
/// file or an email, and `string`, as some documents write `text/plain`.
pub(crate) fn is_text(media_type: &str) -> bool {
    let essence = essence(media_type);
    essence.starts_with("text/")
        || essence.ends_with("+xml")
        || matches!(
            essence.as_str(),
            "string" | "application/xml" | "application/javascript" | "application/x-pem-file" | "message/rfc822"
        )
}

/// Returns the media type's essence, lower case and without parameters.
fn essence(media_type: &str) -> String {
    media_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

/// Returns the content a body is sent as, and its encoding: JSON when it
/// has it, or else multipart, or else a form, or else its first media type
/// as it is.
fn chosen(body: forge::Body<'_>) -> Option<(forge::Content<'_>, Encoding)> {
    if let Some(content) = body.json() {
        return Some((content, Encoding::Json));
    }
    let find = |ty: &str| body.contents().find(|c| essence(c.media_type()) == ty);
    if let Some(content) = find("multipart/form-data") {
        return Some((content, Encoding::Multipart));
    }
    if let Some(content) = find("application/x-www-form-urlencoded") {
        return Some((content, Encoding::Form));
    }
    let content = body.contents().next()?;
    Some((
        content,
        Encoding::Raw {
            text: is_text(content.media_type()),
        },
    ))
}

/// Returns the fields of a multipart or form body of type `t`, following
/// models and merging the members of an intersection, or `None` when `t`
/// has no fixed fields.
fn parts(t: Type<'_>) -> Option<Vec<Part<'_>>> {
    fn walk<'f>(t: Type<'f>, parts: &mut Vec<Part<'f>>, seen: &mut HashSet<Model<'f>>) -> bool {
        match t {
            Type::Object(object) => {
                for field in object.fields().filter(|&f| kept(f)) {
                    match parts.iter_mut().find(|p| p.first().wire_name() == field.wire_name()) {
                        Some(part) => part.fields.push(field),
                        None => parts.push(Part { fields: vec![field] }),
                    }
                }
                true
            }
            Type::Model(m) => seen.insert(m) && walk(m.ty(), parts, seen),
            Type::Intersection(intersection) => intersection.members().all(|m| walk(m, parts, seen)),
            _ => false,
        }
    }
    let mut parts = Vec::new();
    walk(t, &mut parts, &mut HashSet::new()).then_some(parts)
}

/// Prints the parts of a multipart or form body, each on a line of its own
/// after its documentation, leaving out read-only ones.
fn print_parts(f: &mut File, parts: &[Part<'_>]) {
    for part in parts.iter().filter(|p| !p.is_read_only()) {
        let field = part.first();
        f.doc(&doc(field.description(), field.is_deprecated()));
        p!(f, part_member(part), ";");
    }
}

/// Returns the parts of a multipart or form body as an object type.
fn parts_type(parts: &[Part<'_>]) -> Fragment {
    let members = parts.iter().filter(|p| !p.is_read_only()).map(part_member);
    frag!("{ ", join("; ", members), " }")
}

/// Returns a part as a property of an object type, without the `;` after
/// it: a binary value is a file, and anything else is as JSON has it.
fn part_member(part: &Part<'_>) -> Fragment {
    let ty = join(" & ", part.fields.iter().map(|f| part_type(f.ty())));
    frag!(
        key(&part.first().name().camel()),
        if part.is_required() { ": " } else { "?: " },
        ty
    )
}

/// Reports whether a value of `t` is binary content, or may be.
fn binary(t: Type<'_>) -> bool {
    match t {
        Type::Scalar(Scalar::Binary) => true,
        Type::Model(m) => binary(m.ty()),
        Type::Union(union) => union.members().any(binary),
        _ => false,
    }
}

impl Part<'_> {
    /// Reports whether the part is a file, or files: its value is binary
    /// content, or an array of it.
    pub(crate) fn is_file(&self) -> bool {
        self.fields.iter().any(|f| match f.ty() {
            Type::Array(array) => binary(array.elem()),
            t => binary(t),
        })
    }

    /// Returns the part's name on the wire.
    pub(crate) fn wire_name(&self) -> &str {
        self.first().wire_name()
    }
}

/// Returns the type of a part's value: a file for binary content, files
/// for an array of it, and otherwise the type as a request has it.
fn part_type(t: Type<'_>) -> Fragment {
    match t {
        Type::Array(array) if binary(array.elem()) => frag!(runtime("BinaryInput").ty(), "[]"),
        t if binary(t) => frag!(runtime("BinaryInput").ty()),
        t => input_typ(t, Prec::Intersection),
    }
}

impl<'f> Request<'f> {
    /// Returns the request of `m`, as [`Method::request`] lays it out. A
    /// query parameter whose name is not valid has no field, and one named
    /// like another parameter gets a `$`. A parameter named `body` next to a
    /// body that is not flat gets a `$` too.
    pub(crate) fn new(m: Method<'f>) -> Request<'f> {
        let request = m.request();
        let object = match request {
            Some(Type::Object(object)) => Some(object),
            Some(Type::Intersection(intersection)) => match intersection.members().next() {
                Some(Type::Object(object)) => Some(object),
                _ => None,
            },
            _ => None,
        };
        let located: Vec<(Field<'f>, Location)> = object
            .into_iter()
            .flat_map(|object| object.fields())
            .filter_map(|field| Some((field, m.location(field)?)))
            .collect();

        let body = m.body().and_then(|body| {
            let (content, encoding) = chosen(body)?;
            let parts = match encoding {
                Encoding::Multipart | Encoding::Form => parts(content.ty()),
                Encoding::Json | Encoding::Raw { .. } => None,
            };
            Some(Body {
                ty: content.ty(),
                media_type: content.media_type(),
                required: body.is_required(),
                description: body.description(),
                encoding,
                parts,
            })
        });
        // forge lays out a JSON body; the fields of a multipart or form body
        // sit next to the parameters unless one has a parameter's name, and
        // a raw body is the field `body`.
        let flat = match &body {
            None => false,
            Some(body) => match body.encoding {
                Encoding::Json if located.is_empty() => object_like(body.ty, &mut HashSet::new()),
                Encoding::Json => matches!(request, Some(Type::Intersection(_))),
                Encoding::Multipart | Encoding::Form => body.parts.as_ref().is_some_and(|parts| {
                    !parts.iter().any(|part| {
                        located
                            .iter()
                            .any(|(field, _)| field.name().camel() == part.first().name().camel())
                    })
                }),
                Encoding::Raw { .. } => false,
            },
        };

        let mut taken = HashSet::new();
        let mut params = Vec::new();
        for (field, location) in located {
            // A query parameter whose name has other characters, such as
            // `meta.<field>[<operator>]`, is sent through the `query`
            // option, unless an extension names it.
            if matches!(location, Location::Query { .. }) && !valid_name(field.wire_name()) && !field.is_named() {
                continue;
            }
            let mut name = field.name().camel();
            if !flat && name == "body" {
                name.push('$');
            }
            while !taken.insert(name.clone()) {
                name.push('$');
            }
            params.push(Param { field, name, location });
        }
        Request { params, body, flat }
    }

    /// Reports whether the request can be left out: no parameter is
    /// required, and an empty object is a body.
    pub(crate) fn optional(&self) -> bool {
        let params = !self.params.iter().any(|p| p.field.is_required());
        let body = match &self.body {
            None => true,
            Some(body) if self.flat => all_optional(body.ty),
            Some(body) => !body.required,
        };
        params && body
    }
}

/// Prints the parameters of a request, each on a line of its own after its
/// documentation.
fn print_params(f: &mut File, params: &[Param<'_>]) {
    f.indent(|f| {
        for param in params {
            let field = param.field;
            f.doc(&doc(field.description(), field.is_deprecated()));
            p!(
                f,
                key(&param.name),
                if field.is_required() { ": " } else { "?: " },
                input_typ(field.ty(), Prec::Top),
                ";"
            );
        }
    });
}

/// Returns the request and response types of `m`, which are named after it.
fn request_ident(f: &File, m: Method<'_>) -> Ident {
    f.ident(request_name(m))
}

fn response_ident(f: &File, m: Method<'_>) -> Ident {
    f.ident(response_name(m))
}

pub(crate) fn request_name(m: Method<'_>) -> String {
    format!("{}Request", identifier(m.name().pascal()))
}

pub(crate) fn response_name(m: Method<'_>) -> String {
    format!("{}Response", identifier(m.name().pascal()))
}

/// Returns the operation of `m`, which is named after it.
pub(super) fn operation_ident(f: &File, m: Method<'_>) -> Ident {
    f.ident(operation_name(m))
}

pub(crate) fn operation_name(m: Method<'_>) -> String {
    format!("{}Operation", identifier(m.name().pascal()))
}

/// Returns the property of a method and a group in the Client.
pub(crate) fn method_name(m: Method<'_>) -> String {
    identifier(m.name().camel())
}

pub(crate) fn group_name(g: Group<'_>) -> String {
    identifier(g.name().camel())
}

/// Returns the documentation of `m`: its summary, then its description.
pub(crate) fn method_doc(m: Method<'_>) -> String {
    let mut text = m.summary().trim().to_owned();
    let description = m.description().trim();
    if !description.is_empty() && description != text {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(description);
    }
    text
}
