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
    // forge can exit before it reads its input, as when its flags are
    // wrong, so a write that finds the pipe closed is not an error.
    if let Err(err) = child.stdin.take().unwrap().write_all(stdin.as_bytes()) {
        assert_eq!(err.kind(), std::io::ErrorKind::BrokenPipe, "{err}");
    }
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

#[test]
fn ts_query_parameter_named_by_extension() {
    let spec = r#"{
      "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
      "paths": {"/zones": {"get": {"x-fern-sdk-group-name": "zones", "x-fern-sdk-method-name": "list",
        "parameters": [
          {"name": "account.id", "in": "query", "x-fern-parameter-name": "accountId", "schema": {"type": "string"}},
          {"name": "name~neq", "in": "query", "schema": {"type": "string"}}],
        "responses": {"200": {"description": "ok"}}}}}
    }"#;
    let out = std::env::temp_dir().join(format!("forge-cli-ts-named-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    let result = forge(&["-", "--target", "ts", "--out", out.to_str().unwrap()], spec);
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    let client = std::fs::read_to_string(out.join("zones/client.ts")).unwrap();
    // The named parameter is kept and sent under its wire name; the other
    // is left to the `query` option.
    assert!(client.contains("accountId?: string;"), "{client}");
    assert!(client.contains(r#"query: { accountId: "account.id" },"#), "{client}");
    assert!(!client.to_lowercase().contains("neq"), "{client}");
    std::fs::remove_dir_all(&out).unwrap();
}

/// A document whose `things.create` sends a Thing, whose `id` and
/// `created_at` are read-only, and whose `owner` has a read-only `id` too.
/// `things.list` returns Reports, which no request holds.
const READ_ONLY: &str = r##"{
  "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
  "paths": {"/things": {
    "post": {"x-fern-sdk-group-name": "things", "x-fern-sdk-method-name": "create",
      "requestBody": {"required": true, "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Thing"}}}},
      "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Thing"}}}}}},
    "get": {"x-fern-sdk-group-name": "things", "x-fern-sdk-method-name": "list",
      "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
        "type": "array", "items": {"$ref": "#/components/schemas/Report"}}}}}}}},
    "/stamps": {"post": {"x-fern-sdk-group-name": "stamps", "x-fern-sdk-method-name": "create",
      "requestBody": {"required": true, "content": {"application/json": {"schema": {
        "type": "object", "required": ["id"], "properties": {"id": {"type": "string", "readOnly": true}}}}}},
      "responses": {"204": {"description": "ok"}}}}},
  "components": {"schemas": {
    "Thing": {"type": "object", "required": ["id", "name"], "properties": {
      "id": {"type": "string", "readOnly": true},
      "name": {"type": "string"},
      "created_at": {"type": "string", "format": "date-time", "readOnly": true},
      "owner": {"$ref": "#/components/schemas/Owner"},
      "tags": {"type": "array", "items": {"$ref": "#/components/schemas/Tag"}}}},
    "Owner": {"type": "object", "properties": {"id": {"type": "string", "readOnly": true}, "email": {"type": "string"}}},
    "Tag": {"type": "object", "properties": {"label": {"type": "string"}}},
    "Report": {"type": "object", "properties": {"id": {"type": "string", "readOnly": true}}}}}
}"##;

#[test]
fn ts_requests_leave_out_read_only_fields() {
    let out = std::env::temp_dir().join(format!("forge-cli-ts-read-only-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    let result = forge(&["-", "--target", "ts", "--out", out.to_str().unwrap()], READ_ONLY);
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    let read = |name: &str| std::fs::read_to_string(out.join(name)).unwrap();

    // The request has the input type, which leaves out read-only fields and
    // holds the input types of the models in it; a model with no read-only
    // field is itself.
    let client = read("things/client.ts");
    assert!(client.contains("export type CreateRequest = ThingInput;"), "{client}");
    assert!(client.contains("export type CreateResponse = Thing;"), "{client}");
    let inputs = read("things/inputs.ts");
    assert!(
        inputs.contains("export interface ThingInput {\n  name: string;\n  owner?: OwnerInput;\n  tags?: Tag[];\n}"),
        "{inputs}"
    );
    assert!(
        inputs.contains("export interface OwnerInput {\n  email?: string;\n}"),
        "{inputs}"
    );
    // A model that only responses hold has no input type.
    assert!(!inputs.contains("ReportInput"), "{inputs}");
    // The models keep every field.
    let models = read("things/models.ts");
    assert!(models.contains("  id: string;"), "{models}");
    let index = read("things/index.ts");
    assert!(
        index.contains("  OwnerInput,\n  ThingInput,\n} from \"./inputs.js\";"),
        "{index}"
    );

    // A request whose only required field is read-only can be left out.
    let stamps = read("stamps/client.ts");
    assert!(stamps.contains("create(request?: CreateRequest"), "{stamps}");
    assert!(stamps.contains("export interface CreateRequest {}"), "{stamps}");
    assert!(!out.join("stamps/inputs.ts").exists());
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
            r#"export { Transport } from "./transport.js";"#,
            "Effect.map(Transport.make(options), (transport) => Api.of(bind(transport)));",
            "static readonly layerTest = (stubs: Stubs<Client>): Layer.Layer<Api> =>",
            "Layer.succeed(Api, Api.of(stub(bind, stubs)));",
        ],
    );
    expect(
        "transport.ts",
        &[
            r#"export class Transport extends Context.Service<Transport, EffectTransport>()("Shop/Transport") {"#,
            "Effect.map(HttpClient.HttpClient, (client) => new EffectTransport(client, options));",
            "Layer.effect(Transport, Effect.flatMap(Effect.isEffect(options) ? options : Effect.succeed(options), Transport.make));",
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
        (
            "true",
            "only an object of cursor, offset, next_uri or next_path pagination is covered",
        ),
        (
            r#"{"results": "$response.data"}"#,
            "only cursor, offset, next_uri and next_path pagination are covered",
        ),
        (
            r#"{"next_uri": "$request.page", "results": "$response.data"}"#,
            "next_uri must start with $response.",
        ),
        (
            r#"{"next_path": "$response.nope", "results": "$response.data"}"#,
            "next_path names $response.nope, which is not a field of the response",
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

const LINKED: &str = r#"{
  "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
  "paths": {
    "/orders": {"get": {"x-fern-sdk-group-name": "orders", "x-fern-sdk-method-name": "list",
      "x-fern-pagination": {"next_uri": "$response.links.next", "results": "$response.data"},
      "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
        "type": "object", "properties": {
          "data": {"type": "array", "items": {"type": "string"}},
          "links": {"type": "object", "properties": {"next": {"type": "string"}}}}}}}}}}},
    "/logs": {"get": {"x-fern-sdk-group-name": "logs", "x-fern-sdk-method-name": "list",
      "x-fern-pagination": {"next_path": "$response.next_page", "results": "$response.data"},
      "parameters": [{"name": "since", "in": "query", "required": true, "schema": {"type": "string"}}],
      "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
        "type": "object", "properties": {
          "data": {"type": "array", "items": {"type": "integer"}},
          "next_page": {"type": "string"}}}}}}}}}
  }
}"#;

#[test]
fn effect_link_pagination() {
    let out = std::env::temp_dir().join(format!("forge-cli-effect-link-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    let result = forge(&["-", "--target", "effect", "--out", out.to_str().unwrap()], LINKED);
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    let read = |name: &str| std::fs::read_to_string(out.join(name)).unwrap();
    let orders = read("orders/effect.ts");
    for snippet in [
        "listAll(request?: ListRequest, options?: RequestOptions): Stream.Stream<string, ListError>;",
        r#"const ListPagination: Pagination = { kind: "uri", next: ["links", "next"], results: ["data"] };"#,
    ] {
        assert!(orders.contains(snippet), "orders has no {snippet:?}:\n{orders}");
    }
    let logs = read("logs/effect.ts");
    for snippet in [
        "listAll(request: ListRequest, options?: RequestOptions): Stream.Stream<number, ListError>;",
        r#"const ListPagination: Pagination = { kind: "path", next: ["nextPage"], results: ["data"] };"#,
    ] {
        assert!(logs.contains(snippet), "logs has no {snippet:?}:\n{logs}");
    }
    std::fs::remove_dir_all(&out).unwrap();
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
    let transport = std::fs::read_to_string(out.join("transport.ts")).unwrap();
    assert!(
        transport.contains(r#"Context.Service<Transport, EffectTransport>()("@acme/shop-sdk/Transport")"#),
        "{transport}"
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
        r#"export { Security, Transport } from "./transport.js";"#,
        r#"Api.layer(Effect.map(Config.Redacted("SHOP_TOKEN"), (secret) => ({ ...options, auth: Security.apiToken(secret) })));"#,
    ] {
        assert!(root.contains(snippet), "effect.ts has no {snippet:?}:\n{root}");
    }
    let transport = read("transport.ts");
    for snippet in [
        "apiToken: (token: Secret): Auth => bearer(token),",
        r#"key: (key: Secret): Auth => apiKey(key, { query: "api_key" }),"#,
        r#"new EffectTransport(client, options, "https://shop.test/v1")"#,
        r#"Transport.layer(Effect.map(Config.Redacted("SHOP_TOKEN"), (secret) => ({ ...options, auth: Security.apiToken(secret) })));"#,
    ] {
        assert!(
            transport.contains(snippet),
            "transport.ts has no {snippet:?}:\n{transport}"
        );
    }
    assert!(!root.contains("oidc") && !transport.contains("oidc"), "{transport}");
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

#[test]
fn effect_pages_through_the_200_body() {
    // A 200 page of items, and a 202 while the results are being prepared.
    let spec = r#"{
  "openapi": "3.0.3", "info": {"title": "t", "version": "1"},
  "paths": {"/a": {"get": {"x-fern-sdk-group-name": "a", "x-fern-sdk-method-name": "list",
    "x-fern-pagination": {"offset": "$request.page", "results": "$response.result"},
    "parameters": [{"name": "page", "in": "query", "schema": {"type": "integer"}}],
    "responses": {
      "200": {"description": "ok", "content": {"application/json": {"schema": {
        "type": "object", "properties": {"result": {"type": "array", "items": {"type": "string"}}}}}}},
      "202": {"description": "later", "content": {"application/json": {"schema": {
        "type": "object", "properties": {"job": {"type": "string"}}}}}}}}}}
}"#;
    let out = std::env::temp_dir().join(format!("forge-cli-effect-200-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    let result = forge(&["-", "--target", "effect", "--out", out.to_str().unwrap()], spec);
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    let a = std::fs::read_to_string(out.join("a/effect.ts")).unwrap();
    assert!(a.contains("Stream.Stream<string, ListError>"), "{a}");
    std::fs::remove_dir_all(&out).unwrap();
}
