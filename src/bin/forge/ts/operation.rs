//! The operation of a method, which the runtime sends
//! (specs/12-runtime-library.md).

use forge::ts::{File, frag, join, p};
use forge::{Location, Method};

use super::client::{Encoding, Param, Request, ResponseKind, accept, operation_ident, response, response_kind};
use super::codec::{codec, members_codec};
use super::runtime;
use super::types::{js_string, key};

/// Declares the operation of `m`: its HTTP method and route, where its
/// parameters and body go, and the codecs of its body and responses. It is
/// exported, for clients that send operations with a transport of their
/// own, such as the Effect clients.
pub(super) fn operation(f: &mut File, m: Method<'_>, request: &Request<'_>) {
    p!(
        f,
        "export const ",
        operation_ident(f, m),
        ": ",
        runtime("Operation").ty(),
        " = {"
    );
    f.indent(|f| {
        p!(f, "method: ", js_string(m.http_method().as_str()), ",");
        p!(f, "route: ", js_string(&route(m, &request.params)), ",");
        let mut query = Vec::new();
        let mut joined = Vec::new();
        for param in &request.params {
            if let Location::Query { exploded } = param.location {
                query.push(format!("{}: {}", key(&param.name), js_string(param.field.wire_name())));
                if !exploded {
                    joined.push(js_string(&param.name));
                }
            }
        }
        if !query.is_empty() {
            p!(f, "query: { ", join(", ", query), " },");
        }
        if !joined.is_empty() {
            p!(f, "joined: [", join(", ", joined), "],");
        }
        if let Some(body) = &request.body {
            if request.flat {
                p!(f, r#"body: "flat","#);
            } else {
                p!(f, r#"body: "nested","#);
            }
            match body.encoding {
                Encoding::Json => {}
                Encoding::Multipart => {
                    p!(f, r#"encoding: "multipart","#);
                    let files: Vec<String> = body
                        .parts
                        .iter()
                        .flatten()
                        .filter(|part| part.is_file())
                        .map(|part| js_string(part.wire_name()))
                        .collect();
                    if !files.is_empty() {
                        p!(f, "files: [", join(", ", files), "],");
                    }
                }
                Encoding::Form => p!(f, r#"encoding: "form","#),
                Encoding::Raw { .. } => p!(f, r#"encoding: "raw","#),
            }
            // A multipart body's content type has the boundary, which the
            // runtime's FormData sets.
            if body.media_type != "application/json" && body.encoding != Encoding::Multipart {
                p!(f, "contentType: ", js_string(body.media_type), ",");
            }
            if !matches!(body.encoding, Encoding::Raw { .. }) {
                let codec = codec(body.ty, true);
                if !codec.is_empty() {
                    p!(f, "request: ", codec, ",");
                }
            }
        }
        let kind = response_kind(m);
        if kind != ResponseKind::Json {
            p!(f, "response: null,");
            let raw = if kind == ResponseKind::Text { "text" } else { "bytes" };
            p!(f, "responseType: ", js_string(raw), ",");
            p!(f, "accept: ", js_string(&accept(m).join(", ")), ",");
            error_codecs(f, m);
            return;
        }
        let (types, _) = response(m);
        if !types.is_empty() {
            let codec = members_codec(types, "union", true);
            p!(
                f,
                "response: ",
                if codec.is_empty() { frag!("null") } else { codec },
                ","
            );
        }
        error_codecs(f, m);
    });
    p!(f, "};");
}

/// Prints the declared error responses of an operation, by status: the
/// codec of a JSON body, true for a JSON body with nothing to convert, and
/// false for a body that is not JSON. Error responses that are all not JSON
/// are read like undeclared ones, so they are left out.
fn error_codecs(f: &mut File, m: Method<'_>) {
    let mut json = false;
    let errors = join(
        ", ",
        m.errors().map(|r| {
            let status = if r.status() == "default" {
                "default".to_owned()
            } else {
                js_string(r.status())
            };
            let Some(content) = r.json() else {
                return frag!(status, ": false");
            };
            json = true;
            let codec = codec(content.ty(), true);
            frag!(status, ": ", if codec.is_empty() { frag!("true") } else { codec })
        }),
    );
    if json {
        p!(f, "errors: { ", errors, " },");
    }
}

/// Returns the path of a method with each path parameter as the name of its
/// field in braces.
fn route(m: Method<'_>, params: &[Param<'_>]) -> String {
    let mut path = m.path().to_owned();
    for param in params {
        if param.location == Location::Path {
            let wire = format!("{{{}}}", param.field.wire_name());
            path = path.replace(&wire, &format!("{{{}}}", param.name));
        }
    }
    path
}
