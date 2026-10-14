//! Runs the `forge` command.

use std::io::Write;
use std::process::{Command, Output, Stdio};

/// A document with one method, `a.get`.
const SPEC: &str = r#"{
  "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
  "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "get",
    "responses": {"200": {"description": "ok"}}}}}
}"#;

/// Runs `forge` with `args`, writing `stdin` to it.
fn forge(args: &[&str], stdin: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_forge"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    child.wait_with_output().unwrap()
}

/// Returns the standard error of `out`, and panics if `forge` succeeded.
#[track_caller]
fn failure(out: Output) -> String {
    assert!(!out.status.success(), "forge succeeded");
    String::from_utf8(out.stderr).unwrap()
}

#[test]
fn flags_are_required() {
    let err = failure(forge(&["-"], SPEC));
    assert!(err.contains("--target <TARGET>"), "{err}");
    assert!(err.contains("--out <OUT>"), "{err}");
}

#[test]
fn unknown_target() {
    let err = failure(forge(&["-", "--target", "go", "--out", "sdk"], SPEC));
    assert!(err.contains("invalid value 'go'"), "{err}");
    assert!(err.contains("possible values: ts"), "{err}");
}

#[test]
fn missing_spec() {
    let err = failure(forge(&["missing.json", "--target", "ts", "--out", "sdk"], ""));
    assert!(err.starts_with("forge: missing.json: "), "{err}");
}

#[test]
fn invalid_spec() {
    let err = failure(forge(&["-", "--target", "ts", "--out", "sdk"], "{"));
    assert!(err.starts_with("forge: -: "), "{err}");
}

#[test]
fn ts() {
    let out = std::env::temp_dir().join(format!("forge-cli-ts-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    let result = forge(&["-", "--target", "ts", "--out", out.to_str().unwrap()], SPEC);
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    for name in [
        "index.ts",
        "client.ts",
        "a/index.ts",
        "a/client.ts",
        "_/index.ts",
        "_/hooks/envelope.ts",
    ] {
        assert!(out.join(name).is_file(), "{name} is missing");
    }
    let client = std::fs::read_to_string(out.join("a/client.ts")).unwrap();
    assert!(
        client.contains("get(request?: GetRequest, options?: RequestOptions): Promise<GetResponse>;"),
        "{client}"
    );
    assert!(
        client.contains("export function bind(transport: Sender): Client {"),
        "{client}"
    );
    std::fs::remove_dir_all(&out).unwrap();
}

/// A document whose methods page by offset, with a page size, and by
/// cursor, with a required parameter, and where the method `zones.settings`
/// shares its name with a group.
const PAGED: &str = r##"{
  "openapi": "3.0.3", "info": {"title": "Shop", "version": "1"},
  "paths": {
    "/items": {"get": {"x-fern-sdk-group-name": "items", "x-fern-sdk-method-name": "list",
      "x-fern-pagination": {"offset": "$request.start", "step": "$request.page_size",
        "results": "$response.data", "has-next-page": "$response.has_more"},
      "parameters": [{"name": "start", "in": "query", "schema": {"type": "integer"}},
        {"name": "page_size", "in": "query", "schema": {"type": "integer"}}],
      "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
        "type": "object", "properties": {
          "data": {"type": "array", "items": {"$ref": "#/components/schemas/Item"}},
          "has_more": {"type": "boolean"}}}}}},
        "404": {"description": "missing", "content": {"application/json": {"schema": {
          "type": "object", "properties": {"code": {"type": "integer"}}}}}}}}},
    "/events": {"get": {"x-fern-sdk-group-name": "events", "x-fern-sdk-method-name": "list",
      "x-fern-pagination": {"cursor": "$request.cursor",
        "next_cursor": "$response.result_info.next_cursor", "results": "$response.result"},
      "parameters": [{"name": "since", "in": "query", "required": true, "schema": {"type": "string"}},
        {"name": "cursor", "in": "query", "schema": {"type": "string"}}],
      "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
        "type": "object", "properties": {
          "result": {"type": "array", "nullable": true, "items": {"$ref": "#/components/schemas/Item"}},
          "result_info": {"type": "object", "properties": {"next_cursor": {"type": "string"}}}}}}}}}}},
    "/zones/{zone}/settings": {"get": {"x-fern-sdk-group-name": "zones", "x-fern-sdk-method-name": "settings",
      "parameters": [{"name": "zone", "in": "path", "required": true, "schema": {"type": "string"}}],
      "responses": {"200": {"description": "ok"}}}},
    "/zones/{zone}/settings/{name}": {"get": {"x-fern-sdk-group-name": ["zones", "settings"],
      "x-fern-sdk-method-name": "get",
      "parameters": [{"name": "zone", "in": "path", "required": true, "schema": {"type": "string"}},
        {"name": "name", "in": "path", "required": true, "schema": {"type": "string"}}],
      "responses": {"200": {"description": "ok"}}}}
  },
  "components": {"schemas": {"Item": {"type": "object", "properties": {"id": {"type": "string"}}}}}
}"##;

#[test]
fn effect() {
    let out = std::env::temp_dir().join(format!("forge-cli-effect-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    let result = forge(&["-", "--target", "effect", "--out", out.to_str().unwrap()], PAGED);
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    for name in [
        "index.ts",
        "client.ts",
        "effect.ts",
        "items/client.ts",
        "items/effect.ts",
        "zones/settings/effect.ts",
        "_/index.ts",
        "_/effect.ts",
        "_/auth.ts",
        "_/paginate.ts",
    ] {
        assert!(out.join(name).is_file(), "{name} is missing");
    }
    let read = |name: &str| std::fs::read_to_string(out.join(name)).unwrap();
    let expect = |name: &str, snippets: &[&str]| {
        let text = read(name);
        for snippet in snippets {
            assert!(text.contains(snippet), "{name} has no {snippet:?}:\n{text}");
        }
    };
    expect(
        "effect.ts",
        &[
            r#"export * as Auth from "./_/auth.js";"#,
            r#"export class Api extends Context.Service<Api, Client>()("Shop/Api") {"#,
            "EffectTransport,",
            r#"export type { Operation } from "./_/index.js";"#,
            "Effect.map(HttpClient.HttpClient, (client) => Api.of(bind(new EffectTransport(client, options))));",
        ],
    );
    expect(
        "items/effect.ts",
        &[
            "list(request?: ListRequest, options?: RequestOptions): Effect.Effect<ListResponse, ListError>;",
            r#"listAll(request?: Omit<ListRequest, "start">, options?: RequestOptions): Stream.Stream<Item, ListError>;"#,
            "listAll: (request, options) => paginate(transport, ListOperation, ListPagination, request, options),",
            r#"{ kind: "offset", offset: "start", results: ["data"], step: "pageSize", hasNextPage: ["hasMore"] }"#,
            r#"export type ListError = ClientError<Reason<"NotFound", { code?: number }> | Unexpected>;"#,
        ],
    );
    expect(
        "events/effect.ts",
        &[
            r#"listAll(request: Omit<ListRequest, "cursor">, options?: RequestOptions): Stream.Stream<Item, ListError>;"#,
            r#"{ kind: "cursor", cursor: "cursor", nextCursor: ["resultInfo", "nextCursor"], results: ["result"] }"#,
        ],
    );
    expect(
        "zones/effect.ts",
        &[
            "readonly settings: ((request: SettingsRequest, options?: RequestOptions) => Effect.Effect<SettingsResponse, SettingsError>) & SettingsClient;",
            "bindSettings(transport),",
        ],
    );
    expect("items/client.ts", &["export const ListOperation: Operation = {"]);
    expect(
        "events/effect.ts",
        &["export type ListError = ClientError<Unexpected>;"],
    );
    std::fs::remove_dir_all(&out).unwrap();
}

/// A document with a method, `a.list`, that pages as PAGINATION says.
const PAGINATION_ERROR: &str = r#"{
  "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
  "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
    "x-fern-pagination": PAGINATION,
    "parameters": [{"name": "page", "in": "query", "schema": {"type": "integer"}}],
    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
      "type": "object", "properties": {
        "data": {"type": "array", "items": {"type": "string"}}, "total": {"type": "integer"}}}}}}}}}}
}"#;

#[test]
fn effect_pagination_errors() {
    for (pagination, message) in [
        ("true", "only an object of cursor or offset pagination is covered"),
        (
            r#"{"next_uri": "$response.next", "results": "$response.data"}"#,
            "only cursor and offset pagination are covered",
        ),
        (r#"{"offset": "$request.page"}"#, "results is missing"),
        (
            r#"{"offset": "page", "results": "$response.data"}"#,
            "offset must start with $request.",
        ),
        (
            r#"{"offset": "$request.nope", "results": "$response.data"}"#,
            "offset names $request.nope, which is not a parameter of the request",
        ),
        (
            r#"{"offset": "$request.page", "results": "$response.nope"}"#,
            "results names $response.nope, which is not a field of the response",
        ),
        (
            r#"{"offset": "$request.page", "results": "$response.total"}"#,
            "results names $response.total, which is not an array",
        ),
        (
            r#"{"cursor": "$request.page", "results": "$response.data"}"#,
            "next_cursor is missing",
        ),
    ] {
        let spec = PAGINATION_ERROR.replace("PAGINATION", pagination);
        let err = failure(forge(&["-", "--target", "effect", "--out", "unused"], &spec));
        assert!(
            err.contains(&format!("a.list: x-fern-pagination: {message}")),
            "{pagination}: {err}"
        );
    }
}

#[test]
fn effect_name() {
    let out = std::env::temp_dir().join(format!("forge-cli-effect-name-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    let args = [
        "-",
        "--target",
        "effect",
        "--out",
        out.to_str().unwrap(),
        "--name",
        "@acme/shop-sdk",
    ];
    let result = forge(&args, PAGED);
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    let root = std::fs::read_to_string(out.join("effect.ts")).unwrap();
    assert!(
        root.contains(r#"Context.Service<Api, Client>()("@acme/shop-sdk/Api")"#),
        "{root}"
    );
    std::fs::remove_dir_all(&out).unwrap();
}

/// A document with security schemes, whose first requirement is the bearer
/// token, and an operation that needs no credentials.
const SECURED: &str = r#"{
  "openapi": "3.0.3", "info": {"title": "Shop", "version": "1"},
  "servers": [{"url": "https://shop.test/v1"}],
  "security": [{"bearer": []}],
  "components": {"securitySchemes": {
    "bearer": {"type": "http", "scheme": "bearer", "x-fern-bearer": {"name": "apiToken", "env": "SHOP_TOKEN"}},
    "key": {"type": "apiKey", "in": "query", "name": "api_key"},
    "oidc": {"type": "openIdConnect", "openIdConnectUrl": "https://shop.test/.well-known"}
  }},
  "paths": {
    "/items": {"get": {"x-fern-sdk-group-name": "items", "x-fern-sdk-method-name": "list",
      "security": [], "responses": {"200": {"description": "ok"}}}},
    "/orders": {"get": {"x-fern-sdk-group-name": "orders", "x-fern-sdk-method-name": "list",
      "responses": {"200": {"description": "ok"}}}}
  }
}"#;

#[test]
fn effect_security() {
    let out = std::env::temp_dir().join(format!("forge-cli-effect-security-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    let result = forge(&["-", "--target", "effect", "--out", out.to_str().unwrap()], SECURED);
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    let read = |name: &str| std::fs::read_to_string(out.join(name)).unwrap();
    let root = read("effect.ts");
    for snippet in [
        "apiToken: (token: Secret): Auth => bearer(token),",
        r#"key: (key: Secret): Auth => apiKey(key, { query: "api_key" }),"#,
        r#"new EffectTransport(client, options, "https://shop.test/v1")"#,
        r#"Api.layer(Effect.map(Config.Redacted("SHOP_TOKEN"), (secret) => ({ ...options, auth: Security.apiToken(secret) })));"#,
    ] {
        assert!(root.contains(snippet), "effect.ts has no {snippet:?}:\n{root}");
    }
    assert!(!root.contains("oidc"), "{root}");
    let items = read("items/effect.ts");
    assert!(
        items.contains("transport.send(ListOperation, request, options, { auth: false })"),
        "{items}"
    );
    let orders = read("orders/effect.ts");
    assert!(
        orders.contains("transport.send(ListOperation, request, options),"),
        "{orders}"
    );
    std::fs::remove_dir_all(&out).unwrap();
}
