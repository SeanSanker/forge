//! What a document says about authentication, which forge's model doesn't
//! keep: its security schemes, which operations send no credentials, and
//! the scheme it asks for first. The effect target reads it from the
//! document itself.

use std::collections::HashSet;

use forge::Name;
use serde_json::Value;

/// The security of a document.
#[derive(Default)]
pub struct Security {
    /// The schemes the SDK can authenticate with, sorted by key. Schemes it
    /// can't, such as OpenID Connect, are left out.
    pub schemes: Vec<Scheme>,
    /// The operations whose requirements are all empty, so they send no
    /// credentials, by HTTP method and path template.
    pub public: HashSet<(String, String)>,
    /// The scheme of the document's first requirement, when it names one.
    pub default: Option<String>,
}

/// A security scheme the SDK can authenticate with.
pub struct Scheme {
    /// The name of the scheme in the document.
    pub key: String,
    /// The name of its constructor, in camelCase: Fern's name for it, or
    /// its key.
    pub name: String,
    pub description: String,
    pub kind: Kind,
}

pub enum Kind {
    /// HTTP bearer, with the environment variable Fern names for the token.
    Bearer { env: Option<String> },
    /// HTTP basic, with the environment variables of the username and
    /// password.
    Basic {
        username_env: Option<String>,
        password_env: Option<String>,
    },
    /// An API key in a header or the query, with the environment variable
    /// of the key.
    ApiKey {
        header: bool,
        name: String,
        env: Option<String>,
    },
    /// OAuth2 client credentials, from the token URL.
    ClientCredentials { token_url: String },
}

impl Security {
    /// Returns the security of the document `doc`.
    pub fn read(doc: &Value) -> Security {
        let mut security = Security::default();
        if let Some(schemes) = doc.pointer("/components/securitySchemes").and_then(Value::as_object) {
            security.schemes = schemes.iter().filter_map(|(key, value)| scheme(key, value)).collect();
        }
        let root = doc.get("security");
        security.default = root
            .and_then(Value::as_array)
            .and_then(|requirements| requirements.first())
            .and_then(Value::as_object)
            .filter(|requirement| requirement.len() == 1)
            .and_then(|requirement| requirement.keys().next().cloned());
        let Some(paths) = doc.get("paths").and_then(Value::as_object) else {
            return security;
        };
        for (path, item) in paths {
            let Some(item) = item.as_object() else { continue };
            for (method, operation) in item {
                if !OPERATIONS.contains(&method.as_str()) {
                    continue;
                }
                if is_public(operation.get("security").or(root)) {
                    security.public.insert((method.to_uppercase(), path.clone()));
                }
            }
        }
        security
    }
}

/// The keys of a Path Item Object that are operations.
const OPERATIONS: [&str; 9] = [
    "get", "put", "post", "delete", "options", "head", "patch", "trace", "query",
];

/// Reports whether an operation's requirements, which the document says,
/// are all empty, so it needs no credentials. An operation of a document
/// that says nothing about security is not public.
fn is_public(requirements: Option<&Value>) -> bool {
    match requirements.and_then(Value::as_array) {
        Some(requirements) => requirements
            .iter()
            .all(|requirement| requirement.as_object().is_some_and(|r| r.is_empty())),
        None => false,
    }
}

/// Returns the scheme `key` of the document, or `None` when the SDK can't
/// authenticate with it.
fn scheme(key: &str, value: &Value) -> Option<Scheme> {
    let text = |value: &Value, name: &str| value.get(name).and_then(Value::as_str).map(str::to_owned);
    let kind = match value.get("type")?.as_str()? {
        "http" => match value.get("scheme")?.as_str()?.to_ascii_lowercase().as_str() {
            "bearer" => Kind::Bearer {
                env: value.get("x-fern-bearer").and_then(|fern| text(fern, "env")),
            },
            "basic" => {
                let fern = value.get("x-fern-basic");
                let env = |part: &str| fern.and_then(|fern| fern.get(part)).and_then(|part| text(part, "env"));
                Kind::Basic {
                    username_env: env("username"),
                    password_env: env("password"),
                }
            }
            _ => return None,
        },
        "apiKey" => {
            let header = match value.get("in")?.as_str()? {
                "header" => true,
                "query" => false,
                _ => return None,
            };
            Kind::ApiKey {
                header,
                name: text(value, "name")?,
                env: value.get("x-fern-header").and_then(|fern| text(fern, "env")),
            }
        }
        "oauth2" => Kind::ClientCredentials {
            token_url: value.pointer("/flows/clientCredentials/tokenUrl")?.as_str()?.to_owned(),
        },
        _ => return None,
    };
    let fern_name = ["x-fern-bearer", "x-fern-header"]
        .iter()
        .find_map(|ext| value.get(*ext).and_then(|fern| text(fern, "name")));
    let name = Name::new(fern_name.as_deref().unwrap_or(key)).camel();
    if name.is_empty() {
        return None;
    }
    Some(Scheme {
        key: key.to_owned(),
        name,
        description: text(value, "description").unwrap_or_default(),
        kind,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Kind, Security};

    #[test]
    fn reads_schemes_public_operations_and_the_default() {
        let doc = json!({
            "security": [{"token": []}],
            "components": {"securitySchemes": {
                "token": {"type": "http", "scheme": "bearer", "x-fern-bearer": {"name": "apiToken", "env": "TOKEN"}},
                "key": {"type": "apiKey", "in": "header", "name": "X-Key"},
                "oauth": {"type": "oauth2", "flows": {"clientCredentials": {"tokenUrl": "https://a.test/token", "scopes": {}}}},
                "cookie": {"type": "apiKey", "in": "cookie", "name": "session"},
                "oidc": {"type": "openIdConnect", "openIdConnectUrl": "https://a.test"}
            }},
            "paths": {
                "/a": {"get": {}, "post": {"security": []}, "parameters": []},
                "/b": {"get": {"security": [{}]}, "put": {"security": [{"token": []}, {}]}}
            }
        });
        let security = Security::read(&doc);
        let names: Vec<&str> = security.schemes.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["key", "oauth", "apiToken"]);
        assert!(matches!(&security.schemes[2].kind, Kind::Bearer { env: Some(env) } if env == "TOKEN"));
        assert!(matches!(&security.schemes[0].kind, Kind::ApiKey { header: true, name, .. } if name == "X-Key"));
        let mut public: Vec<_> = security.public.iter().cloned().collect();
        public.sort();
        assert_eq!(
            public,
            [
                ("GET".to_owned(), "/b".to_owned()),
                ("POST".to_owned(), "/a".to_owned())
            ]
        );
        assert_eq!(security.default.as_deref(), Some("token"));
    }

    #[test]
    fn a_document_that_says_nothing_has_no_public_operations() {
        let security = Security::read(&json!({"paths": {"/a": {"get": {}}}}));
        assert!(security.public.is_empty());
        assert!(security.schemes.is_empty());
        assert!(security.default.is_none());
    }
}
