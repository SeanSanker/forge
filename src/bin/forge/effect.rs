//! The Effect SDK generator: the TypeScript SDK, with an Effect client next
//! to the Promise client of each group.
//!
//! Each group's effect.ts declares its Client, whose methods return an
//! Effect, and bind, which sends the operations of its client.ts with an
//! EffectTransport. A method with `x-fern-pagination` also gets a twin,
//! named with `All`, that returns a Stream of every item of every page.
//! The root's effect.ts is the entry point of the Effect SDK: it also
//! declares Api, the client as an Effect service. The runtime of the Effect
//! clients goes in `_/`, next to the TypeScript runtime.

use std::collections::{HashMap, HashSet};

use forge::ts::{File as TsFile, Fragment, Ident, Module, PREAMBLE, frag, join, p};
use forge::{Err, Forge, Group, Method, Model, Plugin, Type};

use crate::ts::client::{
    Request, group_name, method_doc, method_name, operation_name, request_name, response_name, skipped,
};
use crate::ts::types::{Prec, all_optional, doc, identifier, js_string, kept, key, typ};
use crate::ts::{self, File, Node, RUNTIME_DIR};

mod security;

pub use security::Security;
use security::{Kind as SchemeKind, Scheme};

/// Generates a TypeScript SDK with an Effect client.
pub struct Generator {
    /// The name of the SDK's package, such as `@acme/pets-sdk`, which keys
    /// its Api service. Without it, the API's title does.
    pub name: Option<String>,
    /// The security of the document, which forge's model doesn't keep.
    pub security: Security,
}

impl Plugin for Generator {
    type File = File;

    /// Returns the files of the TypeScript SDK's root, the root's
    /// effect.ts, and the Effect runtime, whose files replace the
    /// TypeScript runtime's of the same path, such as `_/dates.ts`.
    fn generate(&self, forge: &Forge) -> Result<impl Iterator<Item = File>, Err> {
        let replaced: Vec<String> = RUNTIME
            .iter()
            .map(|&(path, _)| RUNTIME_DIR.sub(path).as_str().to_owned())
            .collect();
        let mut files: Vec<File> = ts::Generator
            .generate(forge)?
            .filter(|file| !matches!(file, File::Runtime { path, .. } if replaced.contains(path)))
            .collect();
        files.push(File::Ts(effect(
            Node::Root(forge),
            self.name.as_deref(),
            &self.security,
        )?));
        files.push(File::Ts(transport(forge, self.name.as_deref(), &self.security)));
        files.extend(RUNTIME.iter().map(|&(path, source)| File::Runtime {
            path: RUNTIME_DIR.sub(path).as_str().to_owned(),
            content: format!("{PREAMBLE}{source}"),
        }));
        Ok(files.into_iter())
    }

    /// Returns the files of the TypeScript SDK's group, and its effect.ts.
    fn generate_group(&self, group: Group<'_>) -> Result<impl Iterator<Item = File>, Err> {
        let mut files: Vec<File> = ts::Generator.generate_group(group)?.collect();
        files.push(File::Ts(effect(
            Node::Group(group),
            self.name.as_deref(),
            &self.security,
        )?));
        Ok(files.into_iter())
    }
}

/// The sources of the Effect runtime, by path in lib/src.
const RUNTIME: [(&str, &str); 4] = [
    ("auth.ts", include_str!("effect/lib/src/auth.ts")),
    ("dates.ts", include_str!("effect/lib/src/dates.ts")),
    ("effect.ts", include_str!("effect/lib/src/effect.ts")),
    ("paginate.ts", include_str!("effect/lib/src/paginate.ts")),
];

/// The modules of the Effect runtime, and of Effect.
const EFFECT_RUNTIME: Module = Module::new("_/effect.ts");
const PAGINATE: Module = Module::new("_/paginate.ts");
const AUTH: Module = Module::new("_/auth.ts");
const EFFECT: Module = Module::new("effect");
const HTTP: Module = Module::new("effect/http");
const TRANSPORT: Module = Module::new("transport.ts");

/// A method of a group's Effect client, and how it pages.
struct Entry<'f> {
    method: Method<'f>,
    request: Request<'f>,
    pagination: Option<Pagination<'f>>,
    /// Whether the method needs no credentials.
    public: bool,
}

/// How a method pages, from its `x-fern-pagination`, with the TypeScript
/// names of the fields it reads.
struct Pagination<'f> {
    /// The request field that picks the page, if any: a page that a link
    /// picks has none.
    param: Option<String>,
    /// The path of the items in the response.
    results: Vec<String>,
    /// The type of an item.
    item: Type<'f>,
    kind: Kind,
}

enum Kind {
    /// The response has the cursor of the next page at the path.
    Cursor { next: Vec<String> },
    /// The page is picked by a page number, or by the index of its first
    /// item when `step` names the request field of the page size.
    Offset {
        step: Option<String>,
        has_next_page: Option<Vec<String>>,
    },
    /// The response has a link to the next page at the path: a URL, or a
    /// path that follows the base URL.
    Link { next: Vec<String>, path: bool },
}

/// Returns the effect.ts of `node`: its Client and bind, then how each
/// paginated method pages. The root's also declares Api, and exports what
/// the SDK's users need with it.
fn effect(node: Node<'_>, name: Option<&str>, security: &Security) -> Result<TsFile, Err> {
    let groups = node.children();
    let group_names: HashMap<String, Group<'_>> = groups.iter().map(|&sub| (group_name(sub), sub)).collect();
    let entries: Vec<Entry<'_>> = node
        .methods()
        .into_iter()
        .filter(|&m| !skipped(m))
        .map(|m| {
            let request = Request::new(m);
            let pagination = pagination(m, &request)?;
            let operation = (m.http_method().as_str().to_owned(), m.path().to_owned());
            Ok(Entry {
                method: m,
                request,
                pagination,
                public: security.public.contains(&operation),
            })
        })
        .collect::<Result<_, Err>>()?;
    check_names(&entries, &group_names)?;

    let mut f = TsFile::new(node.dir().sub("effect.ts"));
    if let Node::Root(_) = node {
        p!(f, r#"export * as Auth from "./_/auth.js";"#);
        p!(
            f,
            r#"export { ApiError, type ClientError, type ClientOptions, EffectTransport, type Reason, type RequestOptions, type Stubs, type Unexpected } from "./_/effect.js";"#
        );
        p!(f, r#"export type { Operation } from "./_/index.js";"#);
        if security.schemes.is_empty() {
            p!(f, r#"export { Transport } from "./transport.js";"#);
        } else {
            p!(f, r#"export { Security, Transport } from "./transport.js";"#);
        }
        p!(f);
    }
    client_interface(&mut f, &entries, &groups, &group_names);
    p!(f);
    bind(&mut f, &entries, &groups, &group_names);
    for entry in &entries {
        p!(f);
        declare_error(&mut f, entry.method);
    }
    for entry in &entries {
        if let Some(pagination) = &entry.pagination {
            p!(f);
            declare_pagination(&mut f, entry.method, pagination);
        }
    }
    if let Node::Root(forge) = node {
        p!(f);
        api(&mut f, &service_key(forge, name, "Api"), forge, security);
    }
    Ok(f)
}

/// Returns an error if the `All` twin of a method is named like another
/// method or a group.
fn check_names(entries: &[Entry<'_>], group_names: &HashMap<String, Group<'_>>) -> Result<(), Err> {
    let names: HashSet<String> = entries.iter().map(|e| method_name(e.method)).collect();
    for entry in entries {
        if entry.pagination.is_some() {
            let all = all_name(entry.method);
            if names.contains(&all) || group_names.contains_key(&all) {
                return Err(format!(
                    "{}: its Stream of every item would be {all}, which is already taken",
                    method_path(entry.method)
                )
                .into());
            }
        }
    }
    Ok(())
}

/// Declares the Client of a group: its methods, each followed by its `All`
/// twin when it pages, then its subgroups. A method and a subgroup with the
/// same name share the property, which is a function with the members of
/// the subgroup's Client.
fn client_interface(
    f: &mut TsFile,
    entries: &[Entry<'_>],
    groups: &[Group<'_>],
    group_names: &HashMap<String, Group<'_>>,
) {
    if entries.is_empty() && groups.is_empty() {
        p!(f, "export interface ", f.ident("Client"), " {}");
        return;
    }
    p!(f, "export interface ", f.ident("Client"), " {");
    let mut shared = HashSet::new();
    f.indent(|f| {
        for entry in entries {
            let m = entry.method;
            let mut text = method_doc(m);
            if entry.public {
                text.push_str("\n\nIt needs no credentials, and sends none.");
            }
            f.doc(&doc(&text, m.is_deprecated()));
            let name = method_name(m);
            let params = frag!(
                "request",
                if entry.request.optional() { "?: " } else { ": " },
                request_ident(m),
                ", options?: ",
                request_options()
            );
            match group_names.get(&name) {
                None => p!(f, key(&name), "(", params, "): ", result(m), ";"),
                Some(&sub) => {
                    p!(
                        f,
                        "readonly ",
                        key(&name),
                        ": ((",
                        params,
                        ") => ",
                        result(m),
                        ") & ",
                        client_ident(sub),
                        ";"
                    );
                    shared.insert(name.clone());
                }
            }
            if let Some(pagination) = &entry.pagination {
                let text =
                    format!("Every item of every page of `{name}`, fetched a page at a time as the stream is read.");
                f.doc(&doc(&text, m.is_deprecated()));
                let param = pagination.param.as_deref();
                let optional = optional_without(&entry.request, param.unwrap_or_default());
                let request = match param {
                    Some(param) => frag!("Omit<", request_ident(m), ", ", js_string(param), ">"),
                    None => frag!(request_ident(m)),
                };
                p!(
                    f,
                    key(&all_name(m)),
                    "(request",
                    if optional { "?: " } else { ": " },
                    request,
                    ", options?: ",
                    request_options(),
                    "): ",
                    EFFECT.ident("Stream").ty(),
                    ".Stream<",
                    typ(pagination.item, Prec::Top),
                    ", ",
                    error_ident(m),
                    ">;"
                );
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

/// Declares bind, which returns the Client of a group on an
/// EffectTransport: each method sends its operation, each `All` twin pages
/// through it, and each subgroup is a getter that binds the subgroup's
/// Client the first time it is read. A method and a subgroup with the same
/// name share a getter, of the method with the members of the subgroup's
/// Client.
fn bind(f: &mut TsFile, entries: &[Entry<'_>], groups: &[Group<'_>], group_names: &HashMap<String, Group<'_>>) {
    let shared: HashMap<String, &Entry<'_>> = entries
        .iter()
        .map(|e| (method_name(e.method), e))
        .filter(|(name, _)| group_names.contains_key(name))
        .collect();
    p!(
        f,
        "export function ",
        f.ident("bind"),
        // A client with nothing to send leaves its transport unused.
        if entries.is_empty() && groups.is_empty() {
            "(_transport: "
        } else {
            "(transport: "
        },
        EFFECT_RUNTIME.ident("EffectTransport").ty(),
        "): ",
        f.ident("Client"),
        " {"
    );
    f.indent(|f| {
        for &sub in groups {
            let name = group_name(sub);
            match shared.get(&name) {
                Some(entry) => {
                    let method = js_string(&method_name(entry.method));
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
            for entry in entries {
                let m = entry.method;
                let name = method_name(m);
                if !shared.contains_key(&name) {
                    p!(f, key(&name), ": (request, options) => ", send(entry), ",");
                }
                if entry.pagination.is_some() {
                    p!(
                        f,
                        key(&all_name(m)),
                        ": (request, options) => ",
                        PAGINATE.ident("paginate"),
                        "(transport, ",
                        operation_ident(m),
                        ", ",
                        f.ident(pagination_name(m)),
                        ", request, options",
                        if entry.public { ", { auth: false }" } else { "" },
                        "),"
                    );
                }
            }
            for &sub in groups {
                let name = group_name(sub);
                p!(f, "get ", key(&name), "() {");
                f.indent(|f| match shared.get(&name) {
                    Some(entry) => {
                        let m = entry.method;
                        p!(f, "return (", name, "Client ??= Object.assign(");
                        f.indent(|f| {
                            p!(
                                f,
                                "(request: ",
                                request_ident(m),
                                ", options?: ",
                                request_options(),
                                "): ",
                                result(m),
                                " => ",
                                send(entry),
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

/// Declares how `m` pages, for its `All` twin.
fn declare_pagination(f: &mut TsFile, m: Method<'_>, pagination: &Pagination<'_>) {
    let path = |names: &[String]| frag!("[", join(", ", names.iter().map(|n| js_string(n))), "]");
    let param = js_string(pagination.param.as_deref().unwrap_or_default());
    let mut members: Vec<Fragment> = Vec::new();
    match &pagination.kind {
        Kind::Cursor { next } => {
            members.push(frag!(r#"kind: "cursor""#));
            members.push(frag!("cursor: ", param));
            members.push(frag!("nextCursor: ", path(next)));
            members.push(frag!("results: ", path(&pagination.results)));
        }
        Kind::Offset { step, has_next_page } => {
            members.push(frag!(r#"kind: "offset""#));
            members.push(frag!("offset: ", param));
            members.push(frag!("results: ", path(&pagination.results)));
            if let Some(step) = step {
                members.push(frag!("step: ", js_string(step)));
            }
            if let Some(has_next_page) = has_next_page {
                members.push(frag!("hasNextPage: ", path(has_next_page)));
            }
        }
        Kind::Link { next, path: relative } => {
            members.push(frag!("kind: ", if *relative { r#""path""# } else { r#""uri""# }));
            members.push(frag!("next: ", path(next)));
            members.push(frag!("results: ", path(&pagination.results)));
        }
    }
    p!(
        f,
        "const ",
        f.ident(pagination_name(m)),
        ": ",
        PAGINATE.ident("Pagination").ty(),
        " = { ",
        join(", ", members),
        " };"
    );
}

/// Declares Security, an Auth for each security scheme of the API, then
/// Api, the root's Client as an Effect service, under `key`.
fn api(f: &mut TsFile, key: &str, forge: &Forge, security: &Security) {
    let effect = EFFECT.ident("Effect");
    let layer = EFFECT.ident("Layer");
    let http_client = HTTP.ident("HttpClient");
    let options = EFFECT_RUNTIME.ident("ClientOptions").ty();
    let api = f.ident("Api");
    let client = f.ident("Client");
    f.doc(
        "The client of the API, as an Effect service. Each method returns an Effect, and sends with the HttpClient \
         that the client was made with. A program that uses only a few groups can bind them to a Transport instead, \
         so a bundler leaves the others out.",
    );
    p!(
        f,
        "export class ",
        api,
        " extends ",
        EFFECT.ident("Context"),
        ".Service<",
        api,
        ", ",
        client,
        ">()(",
        js_string(key),
        ") {"
    );
    f.indent(|f| {
        let mut text = "Makes the client with the HttpClient in context.".to_owned();
        if !forge.base_url.is_empty() {
            text.push_str(&format!(" Its baseUrl is {} by default.", forge.base_url));
        }
        f.doc(&text);
        p!(
            f,
            "static readonly make = (options: ",
            options,
            "): ",
            effect,
            ".Effect<",
            client,
            ", never, ",
            http_client,
            ".HttpClient> =>"
        );
        f.indent(|f| {
            p!(
                f,
                effect,
                ".map(",
                TRANSPORT.ident("Transport"),
                ".make(options), (transport) => ",
                api,
                ".of(",
                f.ident("bind"),
                "(transport)));"
            );
        });
        p!(f);
        f.doc("Returns a layer of the client, from its options or an Effect of them, such as a Config.");
        p!(f, "static readonly layer = <E = never, R = never>(");
        f.indent(|f| {
            p!(f, "options: ", options, " | ", effect, ".Effect<", options, ", E, R>,");
        });
        p!(
            f,
            "): ",
            layer,
            ".Layer<",
            api,
            ", E, R | ",
            http_client,
            ".HttpClient> =>"
        );
        f.indent(|f| {
            p!(
                f,
                layer,
                ".effect(",
                api,
                ", ",
                effect,
                ".flatMap(",
                effect,
                ".isEffect(options) ? options : ",
                effect,
                ".succeed(options), ",
                api,
                ".make));"
            );
        });
        p!(f);
        f.doc(
            "Returns a layer of a fake client, for tests: the stubs answer for the methods they stub, and any other \
             method dies, naming its operation.",
        );
        p!(
            f,
            "static readonly layerTest = (stubs: ",
            EFFECT_RUNTIME.ident("Stubs").ty(),
            "<",
            client,
            ">): ",
            layer,
            ".Layer<",
            api,
            "> =>"
        );
        f.indent(|f| {
            p!(
                f,
                layer,
                ".succeed(",
                api,
                ", ",
                api,
                ".of(",
                EFFECT_RUNTIME.ident("stub"),
                "(",
                f.ident("bind"),
                ", stubs)));"
            );
        });
        let default = security
            .default
            .as_deref()
            .and_then(|key| security.schemes.iter().find(|scheme| scheme.key == key));
        if let Some(scheme) = default {
            layer_config(f, scheme, "client", f.ident("Api"), TRANSPORT.ident("Security"));
        }
    });
    p!(f, "}");
}

/// Returns transport.ts: Security, and Transport, the EffectTransport of the
/// API as an Effect service, which a program can bind single groups to.
fn transport(forge: &Forge, name: Option<&str>, security: &Security) -> TsFile {
    let mut f = TsFile::new(Node::Root(forge).dir().sub("transport.ts"));
    let effect = EFFECT.ident("Effect");
    let layer = EFFECT.ident("Layer");
    let http_client = HTTP.ident("HttpClient");
    let options = EFFECT_RUNTIME.ident("ClientOptions").ty();
    let effect_transport = EFFECT_RUNTIME.ident("EffectTransport");
    let transport = f.ident("Transport");
    if !security.schemes.is_empty() {
        declare_security(&mut f, &security.schemes);
        p!(f);
    }
    f.doc(
        "The transport of the API, as an Effect service: what each group's `bind` sends with. Binding only the \
         groups a program uses keeps the others out of its bundle:\n\n```ts\nimport { bind } from \"./kv/effect.js\";\n\n\
         const kv = yield* Effect.map(Transport, bind);\n```",
    );
    p!(
        f,
        "export class ",
        transport.clone(),
        " extends ",
        EFFECT.ident("Context"),
        ".Service<",
        transport.clone(),
        ", ",
        effect_transport.clone(),
        ">()(",
        js_string(&service_key(forge, name, "Transport")),
        ") {"
    );
    f.indent(|f| {
        let base_url = if forge.base_url.is_empty() {
            String::new()
        } else {
            format!(", {}", js_string(&forge.base_url))
        };
        let mut text = "Makes the transport with the HttpClient in context.".to_owned();
        if !forge.base_url.is_empty() {
            text.push_str(&format!(" Its baseUrl is {} by default.", forge.base_url));
        }
        f.doc(&text);
        p!(
            f,
            "static readonly make = (options: ",
            options.clone(),
            "): ",
            effect.clone(),
            ".Effect<",
            effect_transport.clone(),
            ", never, ",
            http_client.clone(),
            ".HttpClient> =>"
        );
        f.indent(|f| {
            p!(
                f,
                effect.clone(),
                ".map(",
                http_client.clone(),
                ".HttpClient, (client) => new ",
                effect_transport.clone(),
                "(client, options",
                base_url,
                "));"
            );
        });
        p!(f);
        f.doc("Returns a layer of the transport, from its options or an Effect of them, such as a Config.");
        p!(f, "static readonly layer = <E = never, R = never>(");
        f.indent(|f| {
            p!(
                f,
                "options: ",
                options.clone(),
                " | ",
                effect.clone(),
                ".Effect<",
                options.clone(),
                ", E, R>,"
            );
        });
        p!(
            f,
            "): ",
            layer.clone(),
            ".Layer<",
            f.ident("Transport"),
            ", E, R | ",
            http_client.clone(),
            ".HttpClient> =>"
        );
        f.indent(|f| {
            p!(
                f,
                layer.clone(),
                ".effect(",
                f.ident("Transport"),
                ", ",
                effect.clone(),
                ".flatMap(",
                effect.clone(),
                ".isEffect(options) ? options : ",
                effect.clone(),
                ".succeed(options), ",
                f.ident("Transport"),
                ".make));"
            );
        });
        let default = security
            .default
            .as_deref()
            .and_then(|key| security.schemes.iter().find(|scheme| scheme.key == key));
        if let Some(scheme) = default {
            layer_config(f, scheme, "transport", f.ident("Transport"), f.ident("Security"));
        }
    });
    p!(f, "}");
    f
}

/// Declares Security: for each security scheme the SDK can authenticate
/// with, a function that returns its Auth.
fn declare_security(f: &mut TsFile, schemes: &[Scheme]) {
    let auth = AUTH.ident("Auth").ty();
    let secret = AUTH.ident("Secret").ty();
    f.doc("How requests to the API authenticate, by its security schemes. Pass one as the client's auth.");
    p!(f, "export const ", f.ident("Security"), " = {");
    f.indent(|f| {
        for scheme in schemes {
            let (summary, params, body): (String, Fragment, Fragment) = match &scheme.kind {
                SchemeKind::Bearer { .. } => (
                    "Sends a token as `Authorization: Bearer <token>`.".to_owned(),
                    frag!("token: ", secret.clone()),
                    frag!(AUTH.ident("bearer"), "(token)"),
                ),
                SchemeKind::Basic { .. } => (
                    "Sends a username and password as `Authorization: Basic`.".to_owned(),
                    frag!("username: string, password: ", secret.clone()),
                    frag!(AUTH.ident("basic"), "(username, password)"),
                ),
                SchemeKind::ApiKey { header, name, .. } => {
                    let (place, text) = if *header {
                        ("header", "header")
                    } else {
                        ("query", "query parameter")
                    };
                    (
                        format!("Sends an API key in the {text} `{name}`."),
                        frag!("key: ", secret.clone()),
                        frag!(AUTH.ident("apiKey"), "(key, { ", place, ": ", js_string(name), " })"),
                    )
                }
                SchemeKind::ClientCredentials { token_url } => (
                    format!("Gets an access token from {token_url} with the OAuth2 client credentials grant."),
                    frag!(
                        "options: { readonly clientId: string; readonly clientSecret: ",
                        secret.clone(),
                        "; readonly scope?: string }"
                    ),
                    frag!(
                        AUTH.ident("oauth2ClientCredentials"),
                        "({ tokenUrl: ",
                        js_string(token_url),
                        ", ...options })"
                    ),
                ),
            };
            let mut text = summary;
            if !scheme.description.trim().is_empty() {
                text.push_str("\n\n");
                text.push_str(scheme.description.trim());
            }
            f.doc(&text);
            let result = match scheme.kind {
                SchemeKind::ClientCredentials { .. } => frag!(
                    EFFECT.ident("Effect").ty(),
                    ".Effect<",
                    auth.clone(),
                    ", never, ",
                    HTTP.ident("HttpClient").ty(),
                    ".HttpClient>"
                ),
                _ => frag!(auth.clone()),
            };
            p!(f, key(&scheme.name), ": (", params, "): ", result, " => ", body, ",");
        }
    });
    p!(f, "};");
}

/// Declares layerConfig, which reads the credentials of `scheme`, the one
/// the API asks for first, from the environment variables its document
/// names, when it names them all.
fn layer_config(f: &mut TsFile, scheme: &Scheme, what: &str, class: Ident, security: Ident) {
    let config = EFFECT.ident("Config");
    let (vars, read, args): (Vec<&str>, Fragment, &str) = match &scheme.kind {
        SchemeKind::Bearer { env: Some(env) } | SchemeKind::ApiKey { env: Some(env), .. } => (
            vec![env],
            frag!(config.clone(), ".Redacted(", js_string(env), ")"),
            "(secret) => ",
        ),
        SchemeKind::Basic {
            username_env: Some(username),
            password_env: Some(password),
        } => (
            vec![username, password],
            frag!(
                config.clone(),
                ".all([",
                config.clone(),
                ".String(",
                js_string(username),
                "), ",
                config.clone(),
                ".Redacted(",
                js_string(password),
                ")])"
            ),
            "([username, password]) => ",
        ),
        _ => return,
    };
    let call = match scheme.kind {
        SchemeKind::Basic { .. } => "(username, password)",
        _ => "(secret)",
    };
    let names: Vec<String> = vars.iter().map(|var| format!("`{var}`")).collect();
    p!(f);
    f.doc(&format!(
        "Returns a layer of the {what} that authenticates with {}, from the config {}.",
        scheme.name,
        names.join(" and ")
    ));
    p!(
        f,
        "static readonly layerConfig = (options?: Omit<",
        EFFECT_RUNTIME.ident("ClientOptions").ty(),
        ", \"auth\">) =>"
    );
    f.indent(|f| {
        p!(
            f,
            class,
            ".layer(",
            EFFECT.ident("Effect"),
            ".map(",
            read,
            ", ",
            args,
            "({ ...options, auth: ",
            security,
            ".",
            scheme.name.as_str(),
            call,
            " })));"
        );
    });
}

/// Returns the key of the Api service: the name of the SDK's package, or
/// else the title of the API, the first paragraph of its description,
/// followed by `/Api`, as Effect keys services by their module.
fn service_key(forge: &Forge, name: Option<&str>, service: &str) -> String {
    if let Some(name) = name {
        return format!("{}/{service}", name.trim_end_matches('/'));
    }
    let title = forge.description.split("\n\n").next().unwrap_or_default();
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        service.to_owned()
    } else {
        format!("{title}/{service}")
    }
}

/// Returns how `m` pages, from its `x-fern-pagination`, or `None` when it
/// has none. Cursor, offset, next_uri and next_path pagination are
/// covered. The request field that picks the page must be a parameter, and
/// the paths must name fields of the one JSON body of the success
/// responses.
fn pagination<'f>(m: Method<'f>, request: &Request<'f>) -> Result<Option<Pagination<'f>>, Err> {
    let Some(ext) = m.extension("x-fern-pagination") else {
        return Ok(None);
    };
    let at = format!("{}: x-fern-pagination", method_path(m));
    if ext.as_object().is_none() {
        return Err(
            format!("{at}: only an object of cursor, offset, next_uri or next_path pagination is covered").into(),
        );
    }
    let get = |name: &str| -> Result<Option<&str>, Err> {
        match ext.get(name) {
            None => Ok(None),
            Some(value) => match value.as_str() {
                Some(s) => Ok(Some(s)),
                None => Err(format!("{at}: {name} is not a string").into()),
            },
        }
    };
    let require =
        |name: &str| -> Result<&str, Err> { get(name)?.ok_or_else(|| format!("{at}: {name} is missing").into()) };

    // A page is the JSON body of the success response, or of the 200 one
    // when there are others, such as a 202.
    let bodies: Vec<(&str, Type<'f>)> = m
        .responses()
        .filter_map(|r| r.json().map(|content| (r.status(), content.ty())))
        .collect();
    let body = match bodies[..] {
        [(_, body)] => body,
        _ => bodies
            .iter()
            .find(|&&(status, _)| status == "200")
            .map(|&(_, body)| body)
            .ok_or_else(|| format!("{at}: the method needs a JSON response body, or a 200 one, to page through"))?,
    };
    let response_path = |name: &str, path: &str| -> Result<(Vec<String>, Type<'f>), Err> {
        let rest = path
            .strip_prefix("$response.")
            .ok_or_else(|| format!("{at}: {name} must start with $response."))?;
        let mut names = Vec::new();
        let mut ty = body;
        for part in rest.split('.') {
            let field = find_field(ty, part, &mut HashSet::new())
                .ok_or_else(|| format!("{at}: {name} names {path}, which is not a field of the response"))?;
            names.push(field.name().camel());
            ty = field.ty();
        }
        Ok((names, ty))
    };
    let request_field = |name: &str, path: &str| -> Result<String, Err> {
        let wire = path
            .strip_prefix("$request.")
            .ok_or_else(|| format!("{at}: {name} must start with $request."))?;
        request
            .params
            .iter()
            .find(|param| param.field.wire_name() == wire)
            .map(|param| param.name.clone())
            .ok_or_else(|| format!("{at}: {name} names {path}, which is not a parameter of the request").into())
    };

    let (results, results_ty) = response_path("results", require("results")?)?;
    let item = elem(results_ty, &mut HashSet::new()).ok_or_else(|| {
        format!(
            "{at}: results names {}, which is not an array",
            require("results").unwrap_or("")
        )
    })?;
    let (param, kind) = if let Some(cursor) = get("cursor")? {
        let (next, _) = response_path("next_cursor", require("next_cursor")?)?;
        (Some(request_field("cursor", cursor)?), Kind::Cursor { next })
    } else if let Some(offset) = get("offset")? {
        let step = get("step")?.map(|step| request_field("step", step)).transpose()?;
        let has_next_page = get("has-next-page")?
            .map(|path| response_path("has-next-page", path).map(|(names, _)| names))
            .transpose()?;
        (
            Some(request_field("offset", offset)?),
            Kind::Offset { step, has_next_page },
        )
    } else if let Some(uri) = get("next_uri")? {
        let (next, _) = response_path("next_uri", uri)?;
        (None, Kind::Link { next, path: false })
    } else if let Some(path) = get("next_path")? {
        let (next, _) = response_path("next_path", path)?;
        (None, Kind::Link { next, path: true })
    } else {
        return Err(format!("{at}: only cursor, offset, next_uri and next_path pagination are covered").into());
    };
    Ok(Some(Pagination {
        param,
        results,
        item,
        kind,
    }))
}

/// Returns the field of `t` with the wire name `wire`: of an object, the
/// model of one, or a member of a union or an intersection. `seen` has the
/// models already followed.
fn find_field<'f>(t: Type<'f>, wire: &str, seen: &mut HashSet<Model<'f>>) -> Option<forge::Field<'f>> {
    match t {
        Type::Object(object) => object.fields().find(|&field| kept(field) && field.wire_name() == wire),
        Type::Model(m) if seen.insert(m) => find_field(m.ty(), wire, seen),
        Type::Union(union) => union.members().find_map(|member| find_field(member, wire, seen)),
        Type::Intersection(intersection) => intersection.members().find_map(|member| find_field(member, wire, seen)),
        _ => None,
    }
}

/// Returns the type of the items of `t`, when `t` is an array, the model
/// of one, or a union of one with null.
fn elem<'f>(t: Type<'f>, seen: &mut HashSet<Model<'f>>) -> Option<Type<'f>> {
    match t {
        Type::Array(array) => Some(array.elem()),
        Type::Model(m) if seen.insert(m) => elem(m.ty(), seen),
        Type::Union(union) => {
            let mut members = union
                .members()
                .filter(|&member| !matches!(member, Type::Scalar(forge::Scalar::Null)));
            match (members.next(), members.next()) {
                (Some(member), None) => elem(member, seen),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Reports whether the request of a method can be left out once its field
/// `param` is: no other parameter is required, and an empty object is a
/// body.
fn optional_without(request: &Request<'_>, param: &str) -> bool {
    let params = !request.params.iter().any(|p| p.name != param && p.field.is_required());
    let body = match &request.body {
        None => true,
        Some(body) if request.flat => all_optional(body.ty),
        Some(body) => !body.required,
    };
    params && body
}

/// Returns what `m` returns: an Effect of its response, which fails with
/// its error.
fn result(m: Method<'_>) -> Fragment {
    frag!(
        EFFECT.ident("Effect").ty(),
        ".Effect<",
        response_ident(m),
        ", ",
        error_ident(m),
        ">"
    )
}

/// Declares what `m` fails with: a ClientError whose ApiError has a reason
/// for each declared error response with a JSON body, named after its
/// status, or is Unexpected.
fn declare_error(f: &mut TsFile, m: Method<'_>) {
    let mut reasons: Vec<Fragment> = Vec::new();
    let mut tags = HashSet::new();
    for response in m.errors() {
        let Some(content) = response.json() else {
            continue;
        };
        let tag = reason_tag(response.status());
        if tags.insert(tag.clone()) {
            reasons.push(frag!(
                EFFECT_RUNTIME.ident("Reason").ty(),
                "<",
                js_string(&tag),
                ", ",
                typ(content.ty(), Prec::Top),
                ">"
            ));
        }
    }
    reasons.push(frag!(EFFECT_RUNTIME.ident("Unexpected").ty()));
    f.doc(&format!("What `{}` fails with.", method_name(m)));
    p!(
        f,
        "export type ",
        error_ident(m),
        " = ",
        EFFECT_RUNTIME.ident("ClientError").ty(),
        "<",
        join(" | ", reasons),
        ">;"
    );
}

/// Returns the tag of the reason for a declared error response, by its
/// status, as `reasonTag` in the runtime names it.
fn reason_tag(status: &str) -> String {
    let name = match status {
        "default" => "Default",
        "400" => "BadRequest",
        "401" => "Unauthorized",
        "402" => "PaymentRequired",
        "403" => "Forbidden",
        "404" => "NotFound",
        "405" => "MethodNotAllowed",
        "406" => "NotAcceptable",
        "408" => "RequestTimeout",
        "409" => "Conflict",
        "410" => "Gone",
        "412" => "PreconditionFailed",
        "413" => "ContentTooLarge",
        "415" => "UnsupportedMediaType",
        "422" => "UnprocessableContent",
        "429" => "TooManyRequests",
        "500" => "InternalServerError",
        "501" => "NotImplemented",
        "502" => "BadGateway",
        "503" => "ServiceUnavailable",
        "504" => "GatewayTimeout",
        _ => return format!("Status{status}"),
    };
    name.to_owned()
}

/// Returns the error type of `m`, declared in its group's effect.ts.
fn error_ident(m: Method<'_>) -> Ident {
    Module::group(m.group())
        .sub("effect.ts")
        .ident(format!("{}Error", identifier(m.name().pascal())))
        .ty()
}

/// Returns the call that sends the operation of an entry, with no
/// credentials when it needs none.
fn send(entry: &Entry<'_>) -> Fragment {
    let public = if entry.public { ", { auth: false }" } else { "" };
    frag!(
        "transport.send(",
        operation_ident(entry.method),
        ", request, options",
        public,
        ")"
    )
}

fn request_options() -> Ident {
    EFFECT_RUNTIME.ident("RequestOptions").ty()
}

/// Returns the request and response types and the operation of `m`, from
/// the client.ts of its group.
fn request_ident(m: Method<'_>) -> Ident {
    client_module(m).ident(request_name(m)).ty()
}

fn response_ident(m: Method<'_>) -> Ident {
    client_module(m).ident(response_name(m)).ty()
}

fn operation_ident(m: Method<'_>) -> Ident {
    client_module(m).ident(operation_name(m))
}

fn client_module(m: Method<'_>) -> Module {
    Module::group(m.group()).sub("client.ts")
}

/// Returns the bind of group `g`'s Effect client, imported under the name
/// of the group.
fn bind_ident(g: Group<'_>) -> Ident {
    let alias = format!("bind{}", identifier(g.name().pascal()));
    Module::group(g).sub("effect.ts").ident("bind").alias(alias)
}

/// Returns the Client of group `g`'s Effect client, imported under the name
/// of the group.
fn client_ident(g: Group<'_>) -> Ident {
    let alias = format!("{}Client", identifier(g.name().pascal()));
    Module::group(g).sub("effect.ts").ident("Client").ty().alias(alias)
}

/// Returns the property of the `All` twin of `m`.
fn all_name(m: Method<'_>) -> String {
    format!("{}All", method_name(m))
}

/// Returns the name of how `m` pages.
fn pagination_name(m: Method<'_>) -> String {
    format!("{}Pagination", identifier(m.name().pascal()))
}

/// Returns the path of `m` in the client, such as `pets.list`, for errors.
fn method_path(m: Method<'_>) -> String {
    let mut parts: Vec<String> = m.group().path().map(|name| name.camel()).collect();
    parts.push(method_name(m));
    parts.join(".")
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::RUNTIME;

    /// Every source of the Effect runtime is embedded.
    #[test]
    fn runtime_is_complete() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/bin/forge/effect/lib/src");
        let mut paths: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        paths.sort();
        let embedded: Vec<&str> = RUNTIME.iter().map(|&(path, _)| path).collect();
        assert_eq!(paths, embedded);
    }
}
